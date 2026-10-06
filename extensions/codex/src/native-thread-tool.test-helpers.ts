import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import type { Mock } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./app-server/client-runtime.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import type { codexControlRequest } from "./command-rpc.js";

export type CodexNativeThreadToolFixture = {
  root: string;
  sessionFile: string;
  client: CodexAppServerClient;
};

export function wrapCodexNativeThreadToolRequest(
  request: Mock,
  client: CodexAppServerClient,
): typeof codexControlRequest {
  return async (...args: Parameters<typeof codexControlRequest>) => {
    const response = await request(...args);
    const options = args[3];
    if (options?.onResponse) {
      await options.onResponse(response, client, {
        assertCurrent: options.assertCurrent ?? (() => undefined),
      });
    } else {
      options?.assertCurrent?.();
    }
    return response;
  };
}

export async function withCodexNativeThreadToolFixture(
  run: (fixture: CodexNativeThreadToolFixture) => void | Promise<void>,
): Promise<void> {
  await withTempDir("openclaw-codex-threads-", async (root) => {
    const sessionFile = path.join(root, "sessions", "session-id.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "");
    resetCodexTestBindingStore();
    registerCodexTestSessionIdentity(
      "session-id",
      "session-id",
      "agent:main:telegram:direct:owner",
    );
    const { client } = createClientHarness({
      onWrite: (line, send) => {
        // SAFETY: the harness receives requests serialized by CodexAppServerClient.
        const request = JSON.parse(line) as { id: number };
        send({ id: request.id, result: {} });
      },
    });
    ensureCodexAppServerClientRuntime(client, { agentDir: path.join(root, "agent") });
    try {
      await run({ root, sessionFile, client });
    } finally {
      client.close();
    }
  });
}
