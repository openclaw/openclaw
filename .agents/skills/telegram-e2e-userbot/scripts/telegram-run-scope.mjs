import { AsyncLocalStorage } from "node:async_hooks";

const runs = new AsyncLocalStorage();

export function currentTelegramRun() {
  const scope = runs.getStore();
  if (!scope) throw new Error("Telegram work requires a run owner.");
  return scope;
}

class TelegramRunScope {
  controller = new AbortController();
  children = new Map();
  proxies = new Map();
  tasks = new Set();
  io = new Set();
  scratch = new Map();
  evidence = new Set();
  credential = undefined;
  acquisition = undefined;
  closing = undefined;
  leaseCheck = undefined;
  failure = undefined;
  finalized = false;

  constructor(signal) {
    this.signal = this.controller.signal;
    this.stopped = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.health = {
      assertHealthy: () => this.assertActive(),
      whenUnhealthy: this.stopped,
    };
    this.externalSignal = signal;
    this.externalAbort = () => this.cancel(signal.reason);
    signal?.addEventListener("abort", this.externalAbort, { once: true });
    if (signal?.aborted) this.externalAbort();
  }

  assertActive() {
    this.signal.throwIfAborted();
    this.leaseCheck?.();
  }

  acquire(promise) {
    if (this.acquisition) throw new Error("This Telegram run already owns an acquisition.");
    // An in-flight acquire may already have succeeded remotely. Keep its result
    // owned even when cancellation closes admission before the response arrives.
    this.acquisition = promise.then((credential) => {
      this.credential = credential;
      return credential;
    });
    return this.acquisition;
  }

  observeLease(credential) {
    if (this.credential && this.credential !== credential)
      throw new Error("Telegram lease owner changed.");
    this.credential = credential;
    this.leaseCheck = () => credential.assertLeaseHealthy();
    credential.whenLeaseUnhealthy.then((error) => {
      if (error.code !== "LEASE_RELEASED") this.cancel(error);
    });
    this.assertActive();
  }

  cancel(reason = new Error("Telegram run cancelled.")) {
    if (this.finalized) return;
    this.failure ??= reason;
    this.closeAdmission(reason);
  }

  closeAdmission(reason) {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    this.resolveStop(reason);
    for (const child of this.children.keys()) void this.stopChild(child).catch(() => {});
    for (const proxy of this.proxies.keys()) void this.closeProxy(proxy).catch(() => {});
  }

  ownChild(child, stop) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    this.children.set(child, { stop, closed, stopping: undefined });
    if (this.signal.aborted) void this.stopChild(child).catch(() => {});
    return child;
  }

  stopChild(child, graceMs) {
    if (!child) return Promise.resolve();
    const entry = this.children.get(child);
    if (!entry) return Promise.resolve();
    entry.stopping ??= (async () => {
      await entry.stop(child, graceMs);
      let timer;
      try {
        await Promise.race([
          entry.closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Telegram child streams did not close: ${child.pid}`)),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      this.children.delete(child);
    })();
    return entry.stopping;
  }

  ownProxy(proxy) {
    this.proxies.set(proxy, { closing: undefined });
    if (this.signal.aborted) void this.closeProxy(proxy).catch(() => {});
    return proxy;
  }

  closeProxy(proxy) {
    if (!proxy) return Promise.resolve();
    const entry = this.proxies.get(proxy);
    if (!entry) return Promise.resolve();
    entry.closing ??= Promise.resolve(proxy.close()).then(() => {
      this.proxies.delete(proxy);
    });
    return entry.closing;
  }

  wait(promise) {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", aborted, { once: true });
      if (this.signal.aborted) aborted();
      Promise.resolve(promise)
        .then(resolve, reject)
        .finally(() => {
          this.signal.removeEventListener("abort", aborted);
        });
    });
  }

  sleep(milliseconds) {
    this.assertActive();
    let timer;
    const sleeping = new Promise((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    });
    return this.wait(sleeping).finally(() => clearTimeout(timer));
  }

  trackTask(promise) {
    this.tasks.add(promise);
    promise.then(
      () => this.tasks.delete(promise),
      (error) => {
        this.tasks.delete(promise);
        if (!this.signal.aborted || error !== this.signal.reason) this.cancel(error);
      },
    );
    return promise;
  }

  trackIo(promise) {
    this.io.add(promise);
    promise.then(
      () => this.io.delete(promise),
      () => this.io.delete(promise),
    );
    return promise;
  }

  async stopConsumers() {
    const results = await Promise.allSettled([
      ...[...this.children.keys()].map((child) => this.stopChild(child)),
      ...[...this.proxies.keys()].map((proxy) => this.closeProxy(proxy)),
    ]);
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Telegram consumer cleanup is unconfirmed.");
  }

  preserveEvidence(write) {
    this.evidence.add(write);
  }

  ownScratch(root, remove) {
    this.scratch.set(root, remove);
  }

  close() {
    this.closing ??= this.finish();
    return this.closing;
  }

  async finish() {
    this.closeAdmission(this.failure ?? new Error("Telegram run completed."));
    try {
      if (this.acquisition) await this.acquisition.catch(() => {});
      const cleanup = await Promise.allSettled([this.stopConsumers(), ...this.tasks, ...this.io]);
      const consumerResult = cleanup[0];
      // A signalled process is not necessarily a stopped process. Keep ownership
      // and the lease when a consumer could still use it; the host must reconcile.
      const errors = [];
      for (const write of this.evidence) {
        try {
          await write();
        } catch (error) {
          errors.push(error);
        }
      }
      if (consumerResult.status === "rejected") {
        throw new AggregateError(
          [consumerResult.reason, ...errors],
          "Telegram consumers remain unconfirmed.",
        );
      }
      for (const [root, remove] of this.scratch) {
        try {
          await remove(root);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.credential?.release();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Telegram final cleanup failed.");
    } finally {
      this.finalized = true;
      this.externalSignal?.removeEventListener("abort", this.externalAbort);
    }
  }
}

export async function withTelegramRun(operation, { signal, leaseHealth } = {}) {
  const scope = new TelegramRunScope(signal);
  if (leaseHealth) {
    scope.leaseCheck = () => leaseHealth.assertHealthy();
    leaseHealth.whenUnhealthy.then((error) => {
      if (error.code !== "LEASE_RELEASED") scope.cancel(error);
    });
  }
  return await runs.run(scope, async () => {
    let value;
    let failure;
    try {
      value = await operation(scope);
    } catch (error) {
      failure = error;
      scope.cancel(error);
    }
    try {
      await scope.close();
    } catch (error) {
      failure ??= scope.failure;
      if (failure && error !== failure)
        throw new AggregateError([failure, error], "Telegram run and cleanup failed.");
      throw error;
    }
    failure ??= scope.failure;
    if (failure) throw failure;
    return value;
  });
}

export async function runTelegramCli(operation) {
  const controller = new AbortController();
  let exitCode;
  const handlers = new Map(
    [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ].map(([signal, code]) => [
      signal,
      () => {
        exitCode ??= code;
        controller.abort(new Error(`Telegram run stopped by ${signal}.`));
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.once(signal, handler);
  try {
    return await operation(controller.signal);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (exitCode) process.exitCode = exitCode;
  }
}
