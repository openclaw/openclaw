import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { resolveRuntimeForTest } from "./config.test-support.js";
import { loadCodexNativeToolCatalog, parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./plugin-app-cache-key.js";
import { createClientHarness } from "./test-support.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const threadId = "native-thread";
const tool = {
  type: "function" as const,
  name: "example",
  description: "Synthetic tool",
  inputSchema: { type: "object" },
};

it.each(["managed", "supervision"] as const)(
  "loads %s native declarations only from the original scoped runtime",
  async (scope) => {
    await withTempDir("codex-catalog-runtime-", async (agentDir) => {
      const appServer = resolveRuntimeForTest();
      const { client, writes } = createClientHarness();
      const codexHome = resolveCodexAppServerLocalHomeDir(appServer.start, agentDir);
      const runtimeIdentity = { serverVersion: CODEX_APP_SERVER_VERSION, codexHome };
      const identity = vi.spyOn(client, "getRuntimeIdentity").mockReturnValue(runtimeIdentity);
      ensureCodexAppServerClientRuntime(client, { agentDir });
      try {
        const rolloutPath = path.join(codexHome, "sessions", `rollout-${threadId}.jsonl`);
        await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
        await fs.writeFile(
          rolloutPath,
          JSON.stringify({
            type: "session_meta",
            payload: { id: threadId, dynamic_tools: [tool] },
          }) + "\n",
        );
        const connectionFingerprint = buildCodexAppServerConnectionFingerprint(appServer, agentDir);
        const runtimeFingerprint = buildCodexAppServerRuntimeFingerprint({
          appServer,
          appServerVersion: client.getServerVersion(),
          runtimeIdentity,
        });
        const binding = {
          threadId,
          cwd: agentDir,
          clientId: client.getInstanceId(),
          rolloutPath,
          ...(scope === "supervision" ? { connectionScope: "supervision" as const } : {}),
          dynamicToolsFingerprint: codexDynamicToolsFingerprint([tool]),
          appServerRuntimeFingerprint:
            scope === "supervision" ? connectionFingerprint : runtimeFingerprint,
        };
        const params = { client, binding, appServer, agentDir, assertCurrent: () => {} };
        for (const dynamicToolsFingerprint of [
          binding.dynamicToolsFingerprint,
          codexLegacyDynamicToolsFingerprint([tool]),
        ]) {
          await expect(
            loadCodexNativeToolCatalog({
              ...params,
              binding: { ...binding, dynamicToolsFingerprint },
            }),
          ).resolves.toEqual([tool]);
        }
        for (const wrongFingerprint of [
          scope === "supervision" ? runtimeFingerprint : connectionFingerprint,
          buildCodexAppServerRuntimeFingerprint({
            appServer,
            appServerVersion: "0.0.0",
            runtimeIdentity,
          }),
        ]) {
          await expect(
            loadCodexNativeToolCatalog({
              ...params,
              binding: { ...binding, appServerRuntimeFingerprint: wrongFingerprint },
            }),
          ).rejects.toThrow("original verified local binding");
        }
        expect(writes).toEqual([]);
      } finally {
        identity.mockRestore();
        await client.closeAndWait();
      }
    });
  },
);

describe("parseCodexNativeToolCatalog", () => {
  it.each([{}, { dynamic_tools: null }, { dynamic_tools: [] }])(
    "restores the native empty representation %j without accepting a missing nonempty catalog",
    (catalog) => {
      const metadata = { id: threadId, ...catalog };
      expect(
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([])),
      ).toEqual([]);
      expect(() =>
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([tool])),
      ).toThrow("native tool catalog is missing, corrupt, or changed");
    },
  );

  it.each([
    null,
    {},
    { id: "other" },
    ...[{}, [null]].map((dynamic_tools) => ({ id: threadId, dynamic_tools })),
  ])("rejects invalid metadata %j", (metadata) => {
    expect(() => parseCodexNativeToolCatalog(metadata, threadId)).toThrow(
      "native tool catalog is missing, corrupt, or changed",
    );
  });

  it("retains nonempty declarations and the pinned false-defer omission", () => {
    expect(
      parseCodexNativeToolCatalog(
        { id: threadId, dynamic_tools: [{ ...tool, deferLoading: false }] },
        threadId,
        codexDynamicToolsFingerprint([tool]),
      ),
    ).toEqual([tool]);
  });
});
