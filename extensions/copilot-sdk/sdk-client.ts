/**
 * Singleton wrapper around `@github/copilot-sdk`'s CopilotClient.
 *
 * Responsibilities:
 *   - Lazy-load the SDK (it's a runtime dep; may be absent in minimal installs)
 *   - Maintain one client per process lifetime
 *   - Keep the permission handler locked to "deny everything" so the Copilot
 *     CLI never executes tools on behalf of OpenClaw (that is OpenClaw's job)
 *   - Provide `listModels` and `runPrompt` helpers the shim server uses
 *
 * The SDK is in public preview; every SDK call is wrapped so failures surface
 * as plain Error instances the shim can convert into HTTP 500 responses.
 */

export type RunPromptOptions = {
  model: string;
  prompt: string;
  timeoutMs?: number;
};

export type RunPromptResult = {
  content: string;
};

export type SdkClientOptions = {
  cliPath?: string;
  /** Override the start() timeout (ms). Default: 15 000. */
  startTimeoutMs?: number;
  /** Hook for tests to inject a fake SDK factory. */
  sdkFactory?: () => Promise<SdkModule>;
};

export type SdkModelInfo = {
  id: string;
  name?: string;
};

export type SdkClient = {
  listModels(): Promise<SdkModelInfo[]>;
  runPrompt(options: RunPromptOptions): Promise<RunPromptResult>;
  close(): Promise<void>;
};

/**
 * Minimal surface of `@github/copilot-sdk` that the wrapper depends on.
 * Keeping it structural (no `import type` from the SDK) avoids a build-time
 * dependency on the SDK's declaration files and keeps mocking trivial.
 */
export type SdkModule = {
  CopilotClient: new (options?: {
    cliPath?: string;
    useLoggedInUser?: boolean;
    useStdio?: boolean;
    port?: number;
    telemetry?: { enabled?: boolean };
  }) => SdkClientInstance;
};

export type SdkClientInstance = {
  start(): Promise<void>;
  listModels(): Promise<Array<{ id: string; name?: string; capabilities?: unknown }>>;
  createSession(options: {
    model: string;
    onPermissionRequest: (request: unknown) => PermissionResult | Promise<PermissionResult>;
  }): Promise<SdkSession>;
  dispose?(): Promise<void> | void;
  close?(): Promise<void> | void;
};

/**
 * Matches the real AssistantMessageEvent shape from @github/copilot-sdk:
 *   { type: "assistant.message",
 *     data: { messageId, content, toolRequests?, outputTokens?, requestId?, ... },
 *     id, timestamp, parentId }
 */
export type SdkSession = {
  sendAndWait(
    options: { prompt: string },
    timeoutMs?: number,
  ): Promise<
    | {
        type: string;
        data: {
          messageId?: string;
          content: string;
          toolRequests?: unknown[];
          outputTokens?: number;
        };
        id?: string;
        timestamp?: string;
        parentId?: string | null;
      }
    | undefined
  >;
  dispose?(): Promise<void> | void;
  close?(): Promise<void> | void;
};

export type PermissionResult = {
  kind:
    | "approved"
    | "denied-by-rules"
    | "denied-no-approval-rule-and-could-not-request-from-user"
    | "denied-interactively-by-user"
    | "denied-by-content-exclusion-policy";
  rules?: unknown[];
};

/**
 * Permission handler that denies every request, forcing the Copilot CLI to
 * treat itself as a pure LLM. OpenClaw retains exclusive ownership of tool
 * dispatch through its own runtime.
 */
export const denyAllPermissionHandler = (): PermissionResult => ({
  kind: "denied-by-rules",
  rules: [],
});

/** How long to wait for the SDK client to start (spawn CLI + JSON-RPC handshake). */
const START_TIMEOUT_MS = 15_000;

/** How long to wait for a listModels call to return. */
const LIST_MODELS_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Note: concurrent getSdkClient() calls with different option fingerprints can race.
// This is acceptable for catalog-only use but would need per-fingerprint tracking
// if used more broadly.
let cachedClient: SdkClient | undefined;
let cachedOptionsFingerprint = "";
let inflightInit: Promise<SdkClient> | undefined;

function fingerprint(options: SdkClientOptions): string {
  return JSON.stringify({
    cliPath: options.cliPath ?? null,
    startTimeoutMs: options.startTimeoutMs ?? null,
  });
}

/**
 * Returns the singleton SDK client, creating it on first use. A new client is
 * rebuilt when options change (rare; only `cliPath` is mutable today).
 *
 * Concurrent callers with the same options share a single in-flight init
 * promise so only one CLI subprocess is ever spawned.
 */
export async function getSdkClient(options: SdkClientOptions = {}): Promise<SdkClient> {
  const key = fingerprint(options);
  if (cachedClient && cachedOptionsFingerprint === key) {
    return cachedClient;
  }

  // If another caller is already initializing with the same key, coalesce.
  if (inflightInit && cachedOptionsFingerprint === key) {
    return inflightInit;
  }

  // Options changed — tear down old client before rebuilding.
  if (cachedClient) {
    await cachedClient.close().catch(() => undefined);
    cachedClient = undefined;
  }

  cachedOptionsFingerprint = key;
  inflightInit = initClient(options, key);
  try {
    return await inflightInit;
  } finally {
    inflightInit = undefined;
  }
}

/**
 * Unref the child process spawned by `@github/copilot-sdk` so it doesn't
 * prevent Node from exiting in short-lived commands (e.g. `models list`).
 * The field is private (`cliProcess`) so we access it via the runtime object.
 */
function unrefSdkChildProcess(instance: unknown): void {
  try {
    const inst = instance as Record<string, unknown>;
    const cp = inst.cliProcess;
    if (cp && typeof cp === "object") {
      const proc = cp as Record<string, unknown>;
      if (typeof proc.unref === "function") {
        (proc.unref as () => void)();
      }
      // Also unref stdio streams — they can independently keep the loop alive.
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        if (
          stream &&
          typeof stream === "object" &&
          typeof (stream as Record<string, unknown>).unref === "function"
        ) {
          ((stream as Record<string, unknown>).unref as () => void)();
        }
      }
    }
  } catch {
    // Best-effort; don't crash if the SDK internals change.
  }
}

/**
 * Core init logic shared by the singleton (`getSdkClient`) and dedicated
 * (`createDedicatedClient`) paths. Returns a raw `SdkClient` whose `close()`
 * only tears down the underlying SDK instance — callers that need singleton
 * cache management wrap it themselves.
 */
async function buildClient(options: SdkClientOptions): Promise<SdkClient> {
  const sdk = options.sdkFactory
    ? await options.sdkFactory()
    : ((await import("@github/copilot-sdk")) as unknown as SdkModule);

  const instance = new sdk.CopilotClient({
    cliPath: options.cliPath,
    useLoggedInUser: true,
    useStdio: true,
    telemetry: { enabled: false },
  });

  // The SDK requires an explicit start() call to spawn the CLI subprocess and
  // establish the JSON-RPC connection before any other method can be used.
  try {
    await withTimeout(
      instance.start(),
      options.startTimeoutMs ?? START_TIMEOUT_MS,
      "CopilotClient.start()",
    );
  } catch (startErr) {
    // Clean up the spawned subprocess so it doesn't leak on timeout/failure.
    const inst = instance as Record<string, unknown>;
    if (typeof inst.stop === "function") {
      await Promise.resolve((inst.stop as () => unknown)()).catch(() => undefined);
    } else if (typeof inst.dispose === "function") {
      await Promise.resolve((inst.dispose as () => unknown)()).catch(() => undefined);
    }
    throw startErr;
  }

  // The SDK's spawned CLI subprocess keeps the Node event loop alive,
  // preventing short-lived commands (e.g. `models list`) from exiting.
  // Unref the child process so it doesn't block process exit. The
  // subprocess stays alive as long as we hold a reference and send RPCs;
  // it's cleaned up by close()/stop() when the client is torn down.
  unrefSdkChildProcess(instance);

  return {
    async listModels() {
      const list = await withTimeout(
        instance.listModels(),
        LIST_MODELS_TIMEOUT_MS,
        "CopilotClient.listModels()",
      );
      return list.map((entry) => ({ id: entry.id, name: entry.name }));
    },
    async runPrompt({ model, prompt, timeoutMs }) {
      const session = await instance.createSession({
        model,
        onPermissionRequest: denyAllPermissionHandler,
      });
      try {
        const result = await session.sendAndWait({ prompt }, timeoutMs);
        // AssistantMessageEvent shape: { type: "assistant.message", data: { content } }
        const content = result?.data?.content ?? "";
        return { content };
      } finally {
        if (session.dispose) {
          await Promise.resolve(session.dispose()).catch(() => undefined);
        } else if (session.close) {
          await Promise.resolve(session.close()).catch(() => undefined);
        }
      }
    },
    async close() {
      // The SDK exposes stop()/forceStop() to terminate the CLI subprocess.
      // Fall back to dispose()/close() for compat with test mocks.
      const inst = instance as Record<string, unknown>;
      if (typeof inst.stop === "function") {
        await Promise.resolve((inst.stop as () => unknown)()).catch(() => undefined);
      } else if (instance.dispose) {
        await Promise.resolve(instance.dispose()).catch(() => undefined);
      } else if (instance.close) {
        await Promise.resolve(instance.close()).catch(() => undefined);
      }
    },
  };
}

async function initClient(options: SdkClientOptions, key: string): Promise<SdkClient> {
  const inner = await buildClient(options);

  // Wrap close() to also clear the singleton cache.
  const wrapper: SdkClient = {
    listModels: (...args) => inner.listModels(...args),
    runPrompt: (...args) => inner.runPrompt(...args),
    async close() {
      await inner.close();
      cachedClient = undefined;
      cachedOptionsFingerprint = "";
    },
  };

  cachedClient = wrapper;
  cachedOptionsFingerprint = key;
  return wrapper;
}

/**
 * Creates a fresh, non-singleton SDK client. Each call spawns a new CLI
 * subprocess. The returned client's `close()` tears down only its own
 * resources and does not affect the singleton cache used by `getSdkClient`.
 *
 * Use this when the caller needs a long-lived connection that must not be
 * interrupted by catalog or other code that closes the singleton.
 */
export async function createDedicatedClient(options: SdkClientOptions = {}): Promise<SdkClient> {
  return buildClient(options);
}

/** Test-only helper to reset the cached singleton between cases. */
export function __resetSdkClientForTests(): void {
  cachedClient = undefined;
  cachedOptionsFingerprint = "";
  inflightInit = undefined;
}
