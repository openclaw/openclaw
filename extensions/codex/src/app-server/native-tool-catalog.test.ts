import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCodexNativeToolCatalog, parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    cleanup();
  }),
);

const threadId = "native-thread";
const tool = {
  type: "function" as const,
  name: "example",
  description: "Synthetic tool",
  inputSchema: { type: "object" },
};

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

describe("loadCodexNativeToolCatalog", () => {
  it("requires exact supervised connection fingerprints when codexHome, homeScope, or cwd differs", async () => {
    const root = tempDirs.make("codex-native-tool-catalog-");
    const agentDir = path.join(root, "agent");
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    const rolloutA = path.join(homeA, "sessions", "rollout-native.jsonl");
    const rolloutB = path.join(homeB, "sessions", "rollout-native.jsonl");
    const sessionMetaLine = `${JSON.stringify({
      type: "session_meta",
      payload: { id: threadId, dynamic_tools: [tool] },
    })}\n`;
    await mkdir(path.dirname(rolloutA), { recursive: true });
    await mkdir(path.dirname(rolloutB), { recursive: true });
    await writeFile(rolloutA, sessionMetaLine, "utf8");
    await writeFile(rolloutB, sessionMetaLine, "utf8");

    const baseAppServer = {
      ...createAppServerOptions(),
      connectionClass: "local-loopback" as const,
      start: {
        ...createAppServerOptions().start,
        homeScope: "user" as const,
        codexHome: homeA,
        cwd: path.join(root, "ws-a"),
      },
    };
    const binding = {
      threadId,
      cwd: path.join(root, "ws-a"),
      connectionScope: "supervision" as const,
      supervisionSourceThreadId: threadId,
      rolloutPath: rolloutA,
      dynamicToolsFingerprint: codexDynamicToolsFingerprint([tool]),
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        baseAppServer,
        agentDir,
      ),
    };

    const wireA = await createLeasedCodexLifecycleHarness({
      agentDir,
      codexHome: homeA,
      respond: async () => ({}),
    });
    expect(
      await loadCodexNativeToolCatalog({
        client: wireA.client,
        binding,
        appServer: baseAppServer,
        agentDir,
        assertCurrent: () => undefined,
      }),
    ).toEqual([tool]);

    const otherScopeAppServer = {
      ...baseAppServer,
      start: { ...baseAppServer.start, homeScope: undefined },
    };
    await expect(
      loadCodexNativeToolCatalog({
        client: wireA.client,
        binding,
        appServer: otherScopeAppServer,
        agentDir,
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow("Saved Codex declarations require the original verified local binding");

    const otherCwdAppServer = {
      ...baseAppServer,
      start: { ...baseAppServer.start, cwd: path.join(root, "ws-b") },
    };
    await expect(
      loadCodexNativeToolCatalog({
        client: wireA.client,
        binding,
        appServer: otherCwdAppServer,
        agentDir,
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow("Saved Codex declarations require the original verified local binding");

    const otherHomeAppServer = {
      ...baseAppServer,
      start: { ...baseAppServer.start, codexHome: homeB },
    };
    const wireB = await createLeasedCodexLifecycleHarness({
      agentDir,
      codexHome: homeB,
      respond: async () => ({}),
    });
    await expect(
      loadCodexNativeToolCatalog({
        client: wireB.client,
        binding: { ...binding, rolloutPath: rolloutB },
        appServer: otherHomeAppServer,
        agentDir,
        assertCurrent: () => undefined,
      }),
    ).rejects.toThrow("Saved Codex declarations require the original verified local binding");
  });
});
