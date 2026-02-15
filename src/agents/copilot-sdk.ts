import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  ModelInfo,
  SessionConfig,
} from "@github/copilot-sdk";
import { execFileSync } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/copilot-sdk");

/**
 * Check whether the `copilot` CLI binary is available on PATH.
 */
export function isCopilotCliInstalled(options?: { execFileSync?: typeof execFileSync }): boolean {
  const exec = options?.execFileSync ?? execFileSync;
  try {
    exec("copilot", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
  execFileSync?: typeof execFileSync;
}): CopilotAvailability {
  if (options) {
    // Custom execFileSync — skip cache (used in tests)
    return isCopilotCliInstalled(options)
      ? { available: true }
      : { available: false, reason: "copilot CLI not found on PATH" };
  }
  if (cachedAvailability) {
    return cachedAvailability;
  }
  cachedAvailability = isCopilotCliInstalled()
    ? { available: true }
    : { available: false, reason: "copilot CLI not found on PATH" };
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
    };

    if (options.systemPrompt) {
      sessionConfig.systemMessage = {
        mode: "append",
        content: options.systemPrompt,
      };
    }

    // Auto-approve all permission requests so the agent can work autonomously.
    sessionConfig.onPermissionRequest = async () => ({
      kind: "approved",
    });

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
