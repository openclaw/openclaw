import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  ModelInfo,
  SessionConfig,
} from "@github/copilot-sdk";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/copilot-sdk");

/**
 * Check whether the `@github/copilot-sdk` package is resolvable.
 * The SDK bundles its own `@github/copilot` native binary, so a global
 * `copilot` on PATH is not required.
 */
export function isCopilotCliInstalled(options?: { resolveFn?: (id: string) => string }): boolean {
  const resolve = options?.resolveFn ?? ((id: string) => import.meta.resolve(id));
  try {
    resolve("@github/copilot-sdk");
    return true;
  } catch {
    return false;
  }
}

export type CopilotAvailability = {
  available: boolean;
  reason?: string;
};

let cachedAvailability: CopilotAvailability | undefined;

/**
 * Check whether the Copilot CLI binary is installed (sync, fast).
 * Result is cached for the lifetime of the process.
 * Auth is validated later via the SDK's `getAuthStatus()` during client startup.
 */
export function checkCopilotAvailable(options?: {
  resolveFn?: (id: string) => string;
}): CopilotAvailability {
  if (options) {
    // Custom resolveFn — skip cache (used in tests)
    return isCopilotCliInstalled(options)
      ? { available: true }
      : { available: false, reason: "@github/copilot-sdk is not installed" };
  }
  if (cachedAvailability) {
    return cachedAvailability;
  }
  cachedAvailability = isCopilotCliInstalled()
    ? { available: true }
    : { available: false, reason: "@github/copilot-sdk is not installed" };
  return cachedAvailability;
}

/**
 * Lazily import and create a CopilotClient. The SDK is only loaded when actually used.
 */
export async function createCopilotClient(options?: CopilotClientOptions): Promise<CopilotClient> {
  const { CopilotClient: ClientClass } = await import("@github/copilot-sdk");
  const client = new ClientClass({
    useStdio: true,
    autoStart: true,
    logLevel: "warning",
    ...options,
  });
  return client;
}

/**
 * Verify the client is authenticated. Throws if not.
 */
async function ensureAuthenticated(client: CopilotClient): Promise<void> {
  const authStatus = await client.getAuthStatus();
  if (!authStatus.isAuthenticated) {
    throw new Error(
      `copilot CLI not authenticated (run: copilot login). ${authStatus.statusMessage ?? ""}`.trim(),
    );
  }
  log.info("copilot auth verified", {
    authType: authStatus.authType,
    login: authStatus.login,
  });
}

/**
 * List available models from the Copilot SDK.
 * Requires an authenticated client. Returns null if listing fails.
 */
export async function listCopilotModels(options?: { cwd?: string }): Promise<ModelInfo[] | null> {
  let client: CopilotClient | undefined;
  try {
    client = await createCopilotClient({ cwd: options?.cwd });
    await ensureAuthenticated(client);
    const models = await client.listModels();
    return models;
  } catch (error) {
    log.warn("failed to list copilot models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {}
    }
  }
}

export type CopilotAgentRunOptions = {
  prompt: string;
  model?: string;
  workspaceDir?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  sessionId?: string;
};

export type CopilotAgentRunResult = {
  text: string;
  sessionId: string;
};

/**
 * Run a single prompt through the Copilot SDK and return the final response.
 * Creates a client, session, sends the message, waits for idle, and cleans up.
 */
export async function runCopilotAgent(
  options: CopilotAgentRunOptions,
): Promise<CopilotAgentRunResult> {
  const client = await createCopilotClient({
    cwd: options.workspaceDir,
  });

  let session: CopilotSession | undefined;

  try {
    await ensureAuthenticated(client);

    const sessionConfig: SessionConfig = {
      model: options.model,
      workingDirectory: options.workspaceDir,
      streaming: true,
      // Deny tool-use permission requests by default (security: callers must
      // opt-in to specific capabilities through session configuration).
      onPermissionRequest: async () => ({
        kind: "denied-interactively-by-user",
        feedback: "Tool use is not permitted in this session.",
      }),
    };

    if (options.systemPrompt) {
      sessionConfig.systemMessage = {
        mode: "append",
        content: options.systemPrompt,
      };
    }

    if (options.sessionId) {
      session = await client.resumeSession(options.sessionId, sessionConfig);
    } else {
      session = await client.createSession(sessionConfig);
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const response = await session.sendAndWait({ prompt: options.prompt }, timeoutMs);

    const text = response?.data?.content ?? "";
    const sessionId = session.sessionId;

    log.info(`copilot agent run completed`, {
      sessionId,
      model: options.model,
      responseLength: text.length,
    });

    return { text, sessionId };
  } finally {
    if (session) {
      try {
        await session.destroy();
      } catch (err) {
        log.warn("failed to destroy copilot session", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await client.stop();
    } catch (err) {
      log.warn("failed to stop copilot client", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
