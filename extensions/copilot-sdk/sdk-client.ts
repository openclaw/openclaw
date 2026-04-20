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
  listModels(): Promise<Array<{ id: string; name?: string }>>;
  createSession(options: {
    model: string;
    onPermissionRequest: (request: unknown) => PermissionResult | Promise<PermissionResult>;
  }): Promise<SdkSession>;
  dispose?(): Promise<void> | void;
  close?(): Promise<void> | void;
};

export type SdkSession = {
  sendAndWait(
    options: { prompt: string },
    timeoutMs?: number,
  ): Promise<{ content?: string; message?: { content?: string } } | undefined>;
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

let cachedClient: SdkClient | undefined;
let cachedOptionsFingerprint = "";

function fingerprint(options: SdkClientOptions): string {
  return JSON.stringify({
    cliPath: options.cliPath ?? null,
    startTimeoutMs: options.startTimeoutMs ?? null,
  });
}

/**
 * Returns the singleton SDK client, creating it on first use. A new client is
 * rebuilt when options change (rare; only `cliPath` is mutable today).
 */
export async function getSdkClient(options: SdkClientOptions = {}): Promise<SdkClient> {
  const key = fingerprint(options);
  if (cachedClient && cachedOptionsFingerprint === key) {
    return cachedClient;
  }
  if (cachedClient) {
    await cachedClient.close().catch(() => undefined);
    cachedClient = undefined;
  }

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
  await withTimeout(
    instance.start(),
    options.startTimeoutMs ?? START_TIMEOUT_MS,
    "CopilotClient.start()",
  );

  const wrapper: SdkClient = {
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
        const content = result?.content ?? result?.message?.content ?? "";
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
      cachedClient = undefined;
      cachedOptionsFingerprint = "";
    },
  };

  cachedClient = wrapper;
  cachedOptionsFingerprint = key;
  return wrapper;
}

/** Test-only helper to reset the cached singleton between cases. */
export function __resetSdkClientForTests(): void {
  cachedClient = undefined;
  cachedOptionsFingerprint = "";
}
