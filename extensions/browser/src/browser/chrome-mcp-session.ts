// Owns Chrome MCP attachment, admission, and retained cleanup per profile configuration.
import { toErrorObject } from "../infra/errors.js";
import {
  createChromeMcpSession,
  setChromeMcpSessionFactoryForTest,
  waitForChromeMcpPendingSession,
  waitForChromeMcpReady,
} from "./chrome-mcp-connect.js";
import type {
  ChromeMcpCallOptions,
  ChromeMcpSession,
  ChromeMcpSessionLease,
  NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import { redactChromeMcpProfileLabelForDiagnostic } from "./chrome-mcp-diagnostics.js";
import { buildChromeMcpSessionCacheKey } from "./chrome-mcp-options.js";
import {
  cleanupTarget,
  closeChromeMcpSessionHandle,
  setChromeMcpProcessCleanupDepsForTest,
} from "./chrome-mcp-process.js";
import { BrowserProfileUnavailableError } from "./errors.js";

export { setChromeMcpProcessCleanupDepsForTest, setChromeMcpSessionFactoryForTest };

const owners = new Map<string, ChromeMcpSessionOwner>();

type PendingAttach = ReturnType<typeof createChromeMcpSession> & {
  controller: AbortController;
  waiters: number;
  settled: boolean;
  cancelled: boolean;
  cleanupSettled: boolean;
  session?: ChromeMcpSession;
};

class ChromeMcpSessionOwner {
  private session?: ChromeMcpSession;
  private pending?: PendingAttach;
  private readonly retired = new Map<ChromeMcpSession, Promise<void> | undefined>();
  private temporary = 0;
  private admissions = 0;

  constructor(
    readonly profileName: string,
    readonly options: NormalizedChromeMcpProfileOptions,
    private readonly key: string,
  ) {}

  private forgetIfEmpty(): void {
    if (
      !this.session &&
      !this.pending &&
      !this.retired.size &&
      !this.temporary &&
      !this.admissions &&
      owners.get(this.key) === this
    ) {
      owners.delete(this.key);
    }
  }

  isCurrent(session: ChromeMcpSession): boolean {
    return this.session?.transport === session.transport;
  }

  get pid(): number | null {
    if (this.session) {
      return this.session.transport.pid ?? null;
    }
    const retained = this.retired.keys().next().value;
    const target = retained?.processCleanup && cleanupTarget(retained.processCleanup);
    return target?.root.pid ?? retained?.transport.pid ?? null;
  }

  close(session: ChromeMcpSession): Promise<void> {
    if (this.session?.transport === session.transport) {
      this.session = undefined;
    }
    if (session.processCleanup?.status === "closed") {
      this.retired.delete(session);
      this.forgetIfEmpty();
      return Promise.resolve();
    }
    const existing = this.retired.get(session);
    if (existing) {
      return existing;
    }
    // Revoke sends and publish the exact handle before process discovery yields.
    session.transport.send = async () => {
      throw new Error("Chrome MCP session is closing");
    };
    owners.set(this.key, this);
    const cleanup = closeChromeMcpSessionHandle(session)
      .then(() => {
        this.retired.delete(session);
      })
      .finally(() => {
        if (this.retired.has(session)) {
          this.retired.set(session, undefined);
        }
        this.forgetIfEmpty();
      });
    this.retired.set(session, cleanup);
    void cleanup.catch(() => {});
    return cleanup;
  }

  private cancel(pending: PendingAttach, reason?: unknown): void {
    pending.cancelled = true;
    if (!pending.settled) {
      pending.controller.abort(
        reason ?? new Error("Chrome MCP session attach no longer has active waiters"),
      );
    }
  }

  private async drainRetired(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.retired.keys()].map((session) => this.close(session)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  }

  private async drainPending(pending: PendingAttach): Promise<void> {
    const settled = pending.cleanupSettled;
    try {
      await pending.cleanup;
    } catch (error) {
      // Concurrent waiters observe the original failure; later admission retries its retained handle.
      if (!settled) {
        throw error;
      }
      await this.drainRetired();
    }
    if (this.pending === pending) {
      this.pending = undefined;
    }
  }

  async stop(): Promise<boolean> {
    const active = Boolean(this.pending || this.session || this.retired.size);
    if (this.pending) {
      this.cancel(this.pending, new Error("Chrome MCP profile session was replaced"));
      await this.drainPending(this.pending);
    }
    await this.drainRetired();
    if (this.session) {
      await this.close(this.session);
    }
    this.forgetIfEmpty();
    return active;
  }

  private start(): PendingAttach {
    const controller = new AbortController();
    const creation = createChromeMcpSession(
      this,
      this.profileName,
      this.options,
      controller.signal,
    );
    const pending: PendingAttach = {
      ...creation,
      controller,
      waiters: 0,
      settled: false,
      cancelled: false,
      cleanupSettled: false,
    };
    this.pending = pending;
    owners.set(this.key, this);
    pending.promise = creation.promise
      .then(async (session) => {
        pending.session = session;
        if (this.pending === pending) {
          this.session = session;
        } else {
          await this.close(session);
        }
        return session;
      })
      .finally(() => {
        pending.settled = true;
      });
    pending.cleanup = creation.cleanup.finally(() => {
      pending.cleanupSettled = true;
    });
    void pending.promise.catch(() => {});
    void pending.cleanup.catch(() => {});
    return pending;
  }

  private async join(
    pending: PendingAttach,
    options: ChromeMcpCallOptions,
  ): Promise<ChromeMcpSession> {
    pending.waiters++;
    let released = false;
    const release = async (close: boolean) => {
      if (released) {
        return;
      }
      released = true;
      if (--pending.waiters !== 0) {
        return;
      }
      if (!pending.settled) {
        this.cancel(pending, options.signal?.reason);
        await this.drainPending(pending);
      } else if (close && pending.session) {
        this.cancel(pending, options.signal?.reason);
        await this.close(pending.session);
      }
      if (this.pending === pending) {
        this.pending = undefined;
      }
      this.forgetIfEmpty();
    };
    let abortRelease: Promise<void> | undefined;
    const abort = () => {
      // Last-waiter cancellation publishes its cleanup barrier during the abort event.
      abortRelease ??= release(true);
      void abortRelease.catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    try {
      const session = await waitForChromeMcpPendingSession(pending.promise, options.signal);
      await waitForChromeMcpReady(session, this.profileName, options.timeoutMs, options.signal);
      return session;
    } catch (error) {
      await (abortRelease ?? release(options.signal?.aborted === true || pending.waiters <= 1));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await release(false);
    }
  }

  async lease(options: ChromeMcpCallOptions): Promise<ChromeMcpSessionLease> {
    this.admissions++;
    // A caller arriving on a live session must not reconnect after queued cleanup overtakes it.
    const admittedSession =
      !this.pending && this.session?.transport.pid !== null ? this.session : undefined;
    try {
      if (!options.ephemeral) {
        await stopOwners(this.profileName, this);
      }
      options.signal?.throwIfAborted();
      return await this.acquire(options, admittedSession);
    } finally {
      this.admissions--;
      this.forgetIfEmpty();
    }
  }

  private async acquire(
    options: ChromeMcpCallOptions,
    admittedSession?: ChromeMcpSession,
  ): Promise<ChromeMcpSessionLease> {
    for (let retry = 0; ; retry++) {
      if (!admittedSession) {
        if (this.pending?.cancelled) {
          await this.drainPending(this.pending);
        }
        await this.drainRetired();
        options.signal?.throwIfAborted();
        if (this.session?.transport.pid === null) {
          await this.close(this.session);
        }
        if (this.pending?.cancelled) {
          continue;
        }
      }
      const temporary = Boolean(
        !admittedSession && options.ephemeral && (this.pending || !this.session),
      );
      let session = admittedSession ?? (this.pending ? undefined : this.session);
      if (temporary) {
        this.temporary++;
        const creation = createChromeMcpSession(
          this,
          this.profileName,
          this.options,
          options.signal,
        );
        try {
          session = await creation.promise;
          await waitForChromeMcpReady(session, this.profileName, options.timeoutMs, options.signal);
        } catch (error) {
          try {
            await creation.cleanup;
            if (session) {
              await this.close(session);
            }
          } finally {
            this.temporary--;
            this.forgetIfEmpty();
          }
          throw error;
        }
      } else if (session) {
        try {
          await waitForChromeMcpReady(session, this.profileName, options.timeoutMs, options.signal);
        } catch (error) {
          if (!options.ephemeral || !options.signal?.aborted) {
            await this.close(session);
          }
          throw error;
        }
      } else {
        session = await this.join(this.pending ?? this.start(), options);
      }
      if (!admittedSession && !options.ephemeral && session.transport.pid === null) {
        if (this.pending?.session === session) {
          this.pending = undefined;
        }
        await this.close(session);
        if (retry === 0) {
          continue;
        }
        throw new BrowserProfileUnavailableError(
          `Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(this.profileName)}". ` +
            "The Chrome MCP subprocess exited before it became usable.",
        );
      }
      return {
        session,
        temporary,
        owner: this,
        release: async () => {
          if (temporary) {
            try {
              await this.close(session);
            } finally {
              this.temporary--;
              this.forgetIfEmpty();
            }
          }
        },
      };
    }
  }
}

export function getChromeMcpSessionOwner(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): ChromeMcpSessionOwner {
  const key = buildChromeMcpSessionCacheKey(profileName, options);
  let owner = owners.get(key);
  if (!owner) {
    owner = new ChromeMcpSessionOwner(profileName, options, key);
    owners.set(key, owner);
  }
  return owner;
}

async function stopOwners(profileName?: string, keep?: ChromeMcpSessionOwner): Promise<boolean> {
  const results = await Promise.allSettled(
    [...owners.values()]
      .filter(
        (owner) =>
          owner !== keep && (profileName === undefined || owner.profileName === profileName),
      )
      .map((owner) => owner.stop()),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw toErrorObject(failed.reason, "Chrome MCP session cleanup failed.");
  }
  return results.some((result) => result.status === "fulfilled" && result.value);
}

export function getChromeMcpPid(profileName: string): number | null {
  for (const owner of owners.values()) {
    if (owner.profileName === profileName && owner.pid !== null) {
      return owner.pid;
    }
  }
  return null;
}

export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  return await stopOwners(profileName);
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  setChromeMcpSessionFactoryForTest(null);
  await stopOwners();
  setChromeMcpProcessCleanupDepsForTest(null);
}
