import type { CodexAppServerStartOptions } from "./config.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

// Capture reads runtime files before startup; respond when initialize reaches the wire.
export function createInitializingClientHarness(
  userAgent = `codex-cli/${CODEX_APP_SERVER_VERSION}`,
) {
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "initialize") {
        send({ id: request.id, result: { userAgent } });
      }
    },
  });
}

export function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return { transport: "stdio", command: "codex", args: ["app-server"], headers: {}, ...overrides };
}
