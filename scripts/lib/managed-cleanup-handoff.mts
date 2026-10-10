import type { ChildProcess, StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fstatSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { isMainThread } from "node:worker_threads";

const HANDOFF_ENV = "OPENCLAW_MANAGED_CLEANUP_PARENT";
const MAX_FRAME_BYTES = 1024;
type Parent = { fd: number; pid: number; token: string };

function readParent(): Parent | undefined {
  const value = process.env[HANDOFF_ENV];
  // Worker threads share the PID and descriptors, but cannot receive OS signals.
  if (!isMainThread || process.platform === "win32" || !value) {
    return undefined;
  }
  const [pidText, fdText, token, extra] = value.split(":");
  const pid = Number(pidText);
  const fd = Number(fdText);
  if (
    extra !== undefined ||
    pid !== process.ppid ||
    !Number.isSafeInteger(fd) ||
    fd < 3 ||
    typeof token !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(token)
  ) {
    return undefined;
  }
  try {
    if (fstatSync(fd).isSocket()) {
      return { fd, pid, token };
    }
  } catch {
    // Inherited environment without the directly supplied descriptor is not authority.
  }
  return undefined;
}

export function hasManagedCleanupParent(): boolean {
  return client !== undefined || readParent() !== undefined;
}

let client: ReturnType<typeof createCleanupClient> | undefined;

export class ManagedCleanupCancelled extends Error {
  readonly code = "ABORT_ERR";
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super("Managed cleanup parent is already cancelling");
    this.signal = signal;
  }
}

function cleanupClient() {
  if (client) {
    return client;
  }
  const parent = readParent();
  if (!parent) {
    return undefined;
  }
  // A child can pass its environment onward, but never this parent's authority.
  delete process.env[HANDOFF_ENV];
  return (client = createCleanupClient(parent));
}

function createCleanupClient(parent: Parent) {
  const channel = new Socket({ fd: parent.fd, readable: true, writable: true });
  let owned = false;
  let permanent = false;
  let operations = 0;
  let failedCleanup = false;
  let error: Error | undefined;
  let buffer = "";
  let tail = Promise.resolve();
  let waiters = 0;
  let pending:
    | { kind: "claim" | "release"; resolve: () => void; reject: (failure: Error) => void }
    | undefined;
  const fail = (failure: Error) => {
    error ??= failure;
    pending?.reject(error);
    pending = undefined;
    channel.destroy();
  };
  const markFailed = () => {
    if (!failedCleanup) {
      failedCleanup = true;
      if (owned && !channel.destroyed) {
        channel.write(`failed ${parent.token}\n`);
      }
    }
  };
  channel.unref();
  channel.setEncoding("utf8");
  channel.on("error", fail);
  channel.on("end", () => fail(new Error("Managed cleanup parent closed its control channel")));
  channel.on("close", () => {
    if (pending) {
      fail(new Error("Managed cleanup parent closed before acknowledging ownership"));
    }
  });
  channel.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      fail(new Error("Managed cleanup parent sent an invalid acknowledgement"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const stopping = (["SIGINT", "SIGTERM", "SIGHUP"] satisfies NodeJS.Signals[]).find(
        (signal) => frame === `stopping ${signal} ${parent.token}`,
      );
      if (stopping) {
        fail(new ManagedCleanupCancelled(stopping));
        return;
      }
      if (
        !pending ||
        frame !== `${pending.kind === "claim" ? "owned" : "released"} ${parent.token}`
      ) {
        fail(new Error("Managed cleanup parent sent an invalid acknowledgement"));
        return;
      }
      owned = pending.kind === "claim";
      const { resolve } = pending;
      pending = undefined;
      resolve();
    }
  });
  // An aborted admission may exit before its claim/release acknowledgement.
  // The terminal receipt follows those frames and certifies no remaining work.
  process.once("exit", () => {
    if ((owned || pending?.kind === "claim") && operations === 0 && !failedCleanup && !error) {
      try {
        writeSync(parent.fd, `finished ${parent.token}\n`);
      } catch {
        // Parent loss cannot grant a different process cleanup authority.
      }
    }
  });
  const request = (kind: "claim" | "release") => {
    if (error) {
      return Promise.reject(error);
    }
    if (failedCleanup) {
      return Promise.reject(
        Object.assign(new Error("Managed cleanup ownership contains unjoined work"), {
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "indeterminate",
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      pending = { kind, resolve, reject };
      channel.write(`${kind} ${parent.token}\n`);
    });
  };
  const serialize = (operation: () => Promise<void>) => {
    const completion = tail.then(operation);
    tail = completion.catch(() => {});
    return completion;
  };
  const ensureOwned = () =>
    owned && !error && !failedCleanup ? Promise.resolve() : request("claim");
  const waitForAcknowledgement = async (completion: Promise<void>, signal?: AbortSignal) => {
    waiters++;
    channel.ref();
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        completion.then(resolve, reject);
        if (signal) {
          abort = () =>
            reject(Object.assign(new Error("Managed command aborted"), { code: "ABORT_ERR" }));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
          }
        }
      });
    } finally {
      if (abort) {
        signal?.removeEventListener("abort", abort);
      }
      if (--waiters === 0) {
        channel.unref();
      }
    }
  };
  return {
    markFailed,
    async claim() {
      permanent = true;
      await waitForAcknowledgement(serialize(ensureOwned));
      return true;
    },
    async acquire(signal?: AbortSignal) {
      signal?.throwIfAborted();
      operations++;
      let released = false;
      const release = (joined: boolean) => {
        if (released) {
          return;
        }
        released = true;
        operations--;
        if (!joined) {
          markFailed();
          return;
        }
        // Physical joining completes this operation. The ordered exchange still
        // fences later admission, without extending the command's own lifetime.
        void serialize(() =>
          operations === 0 && !permanent && owned && !failedCleanup
            ? request("release")
            : Promise.resolve(),
        ).catch(fail);
      };
      try {
        await waitForAcknowledgement(
          serialize(() => (operations > 0 || permanent ? ensureOwned() : Promise.resolve())),
          signal,
        );
      } catch (failure) {
        // No command started. Relinquish this reservation immediately, but keep
        // the shared claim/release exchange ordered for concurrent or later work.
        release(true);
        throw failure;
      }
      return release;
    },
  };
}

/** Call only after installing the implementation's lifetime cancellation owner. */
export function claimManagedCleanup(): Promise<boolean> {
  return cleanupClient()?.claim() ?? Promise.resolve(false);
}

export function acquireManagedCleanup(signal?: AbortSignal) {
  return cleanupClient()?.acquire(signal);
}

export function failManagedCleanup() {
  client?.markFailed();
}

export type ManagedCleanupHandoff = {
  stop: (signal: NodeJS.Signals) => void;
  delegated: () => boolean;
  waitForOwnerSettlement: (deadlineAt: number) => Promise<boolean>;
  failure: () => Error | undefined;
  settled: () => boolean;
  close: () => void;
};

/** Each descriptor belongs to exactly the ChildProcess passed to attach. */
export function prepareManagedCleanupHandoff(
  stdio: StdioOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  delete env[HANDOFF_ENV];
  if (platform === "win32") {
    return {
      stdio,
      attach: (_child: ChildProcess): ManagedCleanupHandoff | undefined => undefined,
    };
  }
  const descriptors: Exclude<StdioOptions, string> = Array.isArray(stdio)
    ? [...stdio]
    : [stdio, stdio, stdio];
  const fd = Math.max(3, descriptors.length);
  const token = randomUUID();
  while (descriptors.length < fd) {
    descriptors.push(descriptors.length < 3 ? "pipe" : "ignore");
  }
  descriptors.push("pipe");
  env[HANDOFF_ENV] = `${process.pid}:${fd}:${token}`;
  return {
    stdio: descriptors,
    attach(child: ChildProcess): ManagedCleanupHandoff | undefined {
      // Descriptor exhaustion can fail spawn before Node initializes stdio.
      // Without a spawned child there is no process to accept cleanup custody.
      if (!child.pid) {
        return undefined;
      }
      const channel = child.stdio[fd];
      if (!(channel instanceof Socket)) {
        return undefined;
      }
      let owned = false;
      let participated = false;
      let finished = false;
      let ended = false;
      let stopping: NodeJS.Signals | undefined;
      let error: Error | undefined;
      let buffer = "";
      const failureListeners = new Set<(failure: Error) => void>();
      const releaseListeners = new Set<() => void>();
      const fail = (failure: Error) => {
        error ??= failure;
        for (const listener of failureListeners) {
          listener(error);
        }
      };
      channel.unref();
      channel.setEncoding("utf8");
      channel.on("error", (failure) => {
        if ((owned && !finished) || buffer.length > 0) {
          fail(failure);
        }
      });
      const finishChannel = () => {
        if (ended) {
          return;
        }
        ended = true;
        if (buffer.length > 0 || (owned && !finished)) {
          fail(
            new Error(
              "Managed cleanup owner lost its control channel before relinquishing ownership",
            ),
          );
        }
      };
      channel.on("end", finishChannel);
      channel.on("close", finishChannel);
      child.once("exit", () => {
        // An ordinary command never accepted this contract. Its descendants
        // must not acquire a new close-based lifetime by inheriting an unused FD.
        if (!participated) {
          channel.destroy();
        }
      });
      channel.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
          fail(new Error("Managed cleanup owner sent an oversized handoff"));
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const frame = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (frame === `claim ${token}` && !owned && !finished && !error) {
            if (stopping) {
              channel.end(`stopping ${stopping} ${token}\n`);
            } else {
              owned = true;
              participated = true;
              channel.write(`owned ${token}\n`);
            }
          } else if (
            frame === `finished ${token}` &&
            !finished &&
            (owned || participated || stopping)
          ) {
            finished = true;
          } else if (frame === `release ${token}` && owned && !finished && !error) {
            owned = false;
            channel.write(`released ${token}\n`);
            for (const listener of releaseListeners) {
              listener();
            }
          } else if (frame === `failed ${token}` && owned && !finished) {
            fail(new Error("Managed cleanup owner reported unjoined work"));
          } else {
            fail(new Error("Managed cleanup owner sent an invalid handoff"));
          }
        }
      });
      return {
        stop(signal) {
          stopping ??= signal;
        },
        delegated: () => owned,
        failure: () => error,
        settled: () => !participated || ended,
        waitForOwnerSettlement: (deadlineAt) =>
          new Promise<boolean>((resolve, reject) => {
            if (error) {
              reject(error);
              return;
            }
            if (!owned || child.exitCode !== null || child.signalCode !== null) {
              resolve(true);
              return;
            }
            const cleanup = () => {
              clearTimeout(timer);
              child.off("exit", onExit);
              child.off("error", onError);
              failureListeners.delete(onError);
              releaseListeners.delete(onExit);
            };
            const onExit = () => {
              cleanup();
              resolve(true);
            };
            const onError = (failure: Error) => {
              cleanup();
              reject(failure);
            };
            const timer = setTimeout(
              () => {
                cleanup();
                resolve(false);
              },
              Math.max(0, deadlineAt - Date.now()),
            );
            child.once("exit", onExit);
            child.once("error", onError);
            failureListeners.add(onError);
            releaseListeners.add(onExit);
          }),
        close: () => channel.destroy(),
      };
    },
  };
}
