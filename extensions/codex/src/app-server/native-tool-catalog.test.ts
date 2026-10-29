import { afterEach, describe, expect, it, vi } from "vitest";
import * as clientRuntime from "./client-runtime.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  loadCodexAttemptNativeToolCatalog,
  loadCodexNativeToolCatalog,
  parseCodexNativeToolCatalog,
} from "./native-tool-catalog.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import { createAppServerOptions } from "./thread-lifecycle.test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

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

it("rejects revoked current authority before acquiring a client or reading a native catalog", async () => {
  const acquireClient = vi.fn();
  const releaseClient = vi.fn();
  await expect(
    loadCodexAttemptNativeToolCatalog({
      binding: {
        threadId,
        cwd: "/workspace",
        connectionScope: "supervision",
        dynamicToolsFingerprint: codexDynamicToolsFingerprint([tool]),
      },
      appServer: createAppServerOptions(),
      agentDir: "/workspace/agent",
      signal: new AbortController().signal,
      acquireClient,
      releaseClient,
      assertCurrent: () => {
        throw new Error("current owner authority revoked");
      },
    }),
  ).rejects.toThrow("current owner authority revoked");
  expect(acquireClient).not.toHaveBeenCalled();
  expect(releaseClient).not.toHaveBeenCalled();
});

it("does not read retained declarations through an identityless native connection", async () => {
  const native = createFakeCodexAppServerClient(async () => ({}));
  const readMetadata = vi.spyOn(clientRuntime, "readCodexClientSessionMeta");
  const appServer = createAppServerOptions();
  const agentDir = "/workspace/agent";
  await expect(
    loadCodexNativeToolCatalog({
      client: native.client,
      binding: {
        threadId,
        cwd: "/workspace",
        connectionScope: "supervision",
        dynamicToolsFingerprint: codexDynamicToolsFingerprint([tool]),
        appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(appServer, agentDir),
      },
      appServer,
      agentDir,
      assertCurrent: () => {},
    }),
  ).rejects.toThrow("original verified local binding and selected native connection");
  expect(readMetadata).not.toHaveBeenCalled();
  expect(native.request).not.toHaveBeenCalled();
});
