import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import * as clientRuntime from "./client-runtime.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import * as monitorRuntime from "./native-subagent-monitor-runtime.js";
import {
  loadCodexAttemptNativeToolCatalog,
  loadCodexNativeToolCatalog,
  parseCodexNativeToolCatalog,
} from "./native-tool-catalog.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./plugin-app-cache-key.js";
import * as sharedClientLifecycle from "./shared-client-lifecycle.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import { createAppServerOptions } from "./thread-lifecycle.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

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

it.each(["current", "revoked during read", "changed runtime", "ordinary turn", "missing custody"])(
  "restores an unprotected completion catalog only with current custody: %s",
  async (mode) => {
    const native = createFakeCodexAppServerClient();
    const appServer = createAppServerOptions();
    const agentDir = "/workspace/agent";
    const identity = {
      serverVersion: CODEX_APP_SERVER_VERSION,
      codexHome: resolveCodexAppServerHomeDir(agentDir),
    };
    vi.spyOn(native.client, "getRuntimeIdentity").mockReturnValue(identity);
    const release = vi.fn();
    vi.spyOn(
      sharedClientLifecycle,
      "retainSharedCodexAppServerClientByInstanceId",
    ).mockResolvedValue({
      client: native.client,
      release,
    });
    let current = true;
    const assertCompletionCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("completion custody retired");
      }
    });
    const capture = vi
      .spyOn(monitorRuntime, "captureCodexNativeCompletionCatalog")
      .mockReturnValue(mode === "missing custody" ? undefined : assertCompletionCurrent);
    const readMetadata = vi
      .spyOn(clientRuntime, "readCodexClientSessionMeta")
      .mockImplementation(async () => {
        current = mode !== "revoked during read";
        return { id: threadId, dynamic_tools: [tool] };
      });
    const binding = {
      threadId,
      cwd: "/workspace",
      clientId: native.client.getInstanceId(),
      dynamicToolsFingerprint: codexDynamicToolsFingerprint([tool]),
      appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({
        appServer,
        appServerVersion: native.client.getServerVersion(),
        runtimeIdentity: identity,
      }),
    };
    if (mode === "changed runtime") {
      binding.appServerRuntimeFingerprint = "retired-runtime";
    }
    expect(clientRuntime.isCodexAppServerLiveThreadProtected(native.client, threadId)).toBe(false);
    const result = loadCodexAttemptNativeToolCatalog({
      binding,
      appServer,
      agentDir,
      completion:
        mode === "ordinary turn"
          ? undefined
          : {
              requesterSessionKey: "agent:main:parent",
              sourceSessionKey: "codex-thread:child",
              runId: "announce:codex-native:parent:child:succeeded",
            },
      signal: new AbortController().signal,
      acquireClient: vi.fn(),
      releaseClient: vi.fn(),
      assertCurrent: () => {},
    });
    if (mode === "current") {
      await expect(result).resolves.toEqual([tool]);
    } else if (mode === "ordinary turn" || mode === "missing custody") {
      await expect(result).resolves.toBeUndefined();
    } else {
      await expect(result).rejects.toThrow(
        mode === "changed runtime"
          ? "original verified local binding"
          : "completion custody retired",
      );
    }
    expect(readMetadata).toHaveBeenCalledTimes(
      ["changed runtime", "ordinary turn", "missing custody"].includes(mode) ? 0 : 1,
    );
    expect(capture).toHaveBeenCalledTimes(mode === "ordinary turn" ? 0 : 1);
    expect(release).toHaveBeenCalledOnce();
  },
);
