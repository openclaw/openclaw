/** Selects a transport while preserving synchronous reader admission before registration. */
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { createStdioTransport } from "./transport-stdio.js";
import { createWebSocketTransport } from "./transport-websocket.js";
import type { CodexAppServerTransport } from "./transport.js";

export async function createCodexAppServerTransport(
  options: Partial<CodexAppServerStartOptions> | undefined,
  assertCurrent: (() => void) | undefined,
  onSpawn: (child: CodexAppServerTransport, options: CodexAppServerStartOptions) => void,
  processScope?: { signal: AbortSignal; ownership: "retained-tree" },
): Promise<void> {
  const defaults = resolveCodexAppServerRuntimeOptions().start;
  const startOptions = { ...defaults, ...options, headers: options?.headers ?? defaults.headers };
  if (startOptions.transport === "stdio" && startOptions.commandSource === "managed") {
    throw new Error("Managed Codex app-server start options must be resolved before spawn.");
  }
  if (startOptions.transport === "websocket" || startOptions.transport === "unix") {
    onSpawn(createWebSocketTransport(startOptions), startOptions);
    return;
  }
  const admitted = (child: CodexAppServerTransport) => onSpawn(child, startOptions);
  if (processScope) {
    const { createOwnedCodexStdioTransport } = await import("./transport-owned.js");
    await createOwnedCodexStdioTransport(
      startOptions,
      processScope.signal,
      assertCurrent,
      admitted,
    );
  } else {
    await createStdioTransport(startOptions, process.env, assertCurrent, admitted);
  }
}
