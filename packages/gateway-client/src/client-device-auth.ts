export type DeviceAuthTokenRecord = {
  token?: string;
  scopes?: string[];
};

export type DeviceAuthTokenObservation = {
  // Null records a completed load without a token; undefined means no load completed.
  token: string | null | undefined;
  receiptToken?: string;
  persistence?: Promise<void>;
};

export type MaybePromise<T> = T | Promise<T>;

type DeviceAuthOperation = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

export type GatewayClientDeviceAuthStorage = {
  loadDeviceAuthToken?: (
    params: DeviceAuthOperation & {
      deviceId: string;
      role: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => MaybePromise<DeviceAuthTokenRecord | null>;
  storeDeviceAuthToken?: (
    params: DeviceAuthOperation & {
      deviceId: string;
      role: string;
      token: string;
      scopes: string[];
      env?: NodeJS.ProcessEnv;
      expectedToken?: string | null;
    },
  ) => unknown;
  clearDeviceAuthToken?: (
    params: DeviceAuthOperation & {
      deviceId: string;
      role: string;
      env?: NodeJS.ProcessEnv;
      expectedToken?: string;
    },
  ) => unknown;
};

/** Owns pending host storage work for one client across connection generations. */
export class GatewayClientDeviceAuth {
  private readonly operations = new Set<Promise<unknown>>();
  private unreportedPersistenceFailure: Error | undefined;

  constructor(private readonly storage: Required<GatewayClientDeviceAuthStorage>) {}

  load(params: Parameters<NonNullable<GatewayClientDeviceAuthStorage["loadDeviceAuthToken"]>>[0]) {
    const load = () => {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      return this.track(this.storage.loadDeviceAuthToken(params));
    };
    // A retired connection's accepted store/clear must settle before the next read.
    return this.operations.size > 0 ? this.settle().then(load) : load();
  }

  store(
    params: Parameters<NonNullable<GatewayClientDeviceAuthStorage["storeDeviceAuthToken"]>>[0],
    onStored: () => void,
    onFailed: (error: Error) => boolean,
  ) {
    const failed = (error: unknown): never => {
      const failure = error instanceof Error ? error : new Error(String(error));
      let reported = false;
      try {
        reported = onFailed(failure);
      } catch {
        // A broken reporter must not replace or discard the original storage error.
      }
      if (!reported) {
        this.unreportedPersistenceFailure ??= failure;
      }
      throw failure;
    };
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    const stored = this.storage.storeDeviceAuthToken(params);
    return stored instanceof Promise ? this.track(stored.then(onStored).catch(failed)) : onStored();
  }

  clear(
    params: Parameters<NonNullable<GatewayClientDeviceAuthStorage["clearDeviceAuthToken"]>>[0],
    observation: DeviceAuthTokenObservation,
    canClear: () => boolean,
  ): MaybePromise<void> {
    const clear = () => {
      if (!canClear()) {
        return undefined;
      }
      // A rejected result may follow a committed write. Reconcile only the sampled
      // and received token identities; never clear an unrelated replacement.
      const knownTokens = [observation.token, observation.receiptToken].filter(
        (token): token is string => typeof token === "string",
      );
      const expectedTokens: Array<string | undefined> = [...new Set(knownTokens)];
      if (observation.token === undefined && expectedTokens.length === 0) {
        expectedTokens.push(undefined);
      }
      const clearToken = (expectedToken: string | undefined) => {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
        const cleared = this.storage.clearDeviceAuthToken({
          ...params,
          ...(expectedToken === undefined ? {} : { expectedToken }),
        });
        return cleared instanceof Promise ? cleared.then(() => {}) : undefined;
      };
      let pending: Promise<void> | undefined;
      for (const expectedToken of expectedTokens) {
        pending = pending
          ? pending.then(() => clearToken(expectedToken))
          : clearToken(expectedToken);
      }
      return pending;
    };
    // Register the entire cleanup now so reconnect and shutdown also join deferred clearing.
    return this.track(
      observation.persistence ? observation.persistence.then(clear, clear) : clear(),
    );
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.operations);
  }

  async drain(): Promise<void> {
    await this.settle();
    const failure = this.unreportedPersistenceFailure;
    this.unreportedPersistenceFailure = undefined;
    if (failure) {
      throw failure;
    }
  }

  private track<T>(operation: MaybePromise<T>): MaybePromise<T> {
    if (!(operation instanceof Promise)) {
      return operation;
    }
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
}
