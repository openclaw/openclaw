import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./app-server/plugin-app-cache-key.js";
import type {
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import { createCodexTaskHistory } from "./session-catalog-task-history.js";
import type {
  CodexCatalogHome,
  CodexSessionCatalogControlFactory,
} from "./session-catalog-types.js";
import { catalogThreadItem, createControl, idleThread } from "./session-catalog.test-helpers.js";

function fixture(supervised = false, homeScope?: "user") {
  const config = {};
  const pluginConfig = { appServer: { homeScope } };
  const agentDir = "/fixture/agent";
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig, config, agentDir });
  const runtimeIdentity = { codexHome: "/fixture/codex", serverVersion: "test-server" };
  const client = {
    getRuntimeIdentity: () => runtimeIdentity,
    getServerVersion: () => "test-server",
  } as CodexAppServerClient;
  const fingerprint = supervised
    ? buildCodexAppServerConnectionFingerprint(appServer, agentDir)
    : buildCodexAppServerRuntimeFingerprint({ appServer, runtimeIdentity });
  let binding: CodexAppServerThreadBinding | undefined = {
    threadId: "parent-thread",
    appServerRuntimeFingerprint: fingerprint,
    ...(supervised ? { connectionScope: "supervision" } : {}),
  } as CodexAppServerThreadBinding;
  let sessionId = "parent-session";
  const api = {
    runtime: { agent: { session: { getSessionEntry: () => ({ sessionId, updatedAt: 1 }) } } },
  } as unknown as OpenClawPluginApi;
  const source = { subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } } };
  const readThread = vi.fn(async () =>
    idleThread({ id: "child-thread", historyMode: "paginated", source }),
  );
  const listItemPage = vi.fn(async () => ({
    data: [
      { turnId: "turn", item: catalogThreadItem("message", { text: "Child output" }) },
      {
        turnId: "turn",
        item: catalogThreadItem("reasoning", { type: "reasoning", text: "Private reasoning" }),
      },
    ],
    nextCursor: "native-older",
  }));
  const requireEligibleThread = vi.fn(async () => {
    throw new Error("Native children are not catalog eligible");
  });
  const control = createControl({
    connectionFingerprint: fingerprint,
    forkContext: { client, appServer, pluginConfig, agentDir },
    requireEligibleThread,
    readThread,
    listItemPage,
  });
  const home: CodexCatalogHome = {
    sourceHomeId: "home",
    hostId: "local",
    label: "Fixture",
    appServer,
    agentDir,
    usesProcessHomeFallback: false,
  };
  let homes = [home];
  const factory: CodexSessionCatalogControlFactory = {
    forRequest: () => control,
    homesForAgent: () => homes,
    forUpstream: () => control,
  };
  const reader = createCodexTaskHistory({
    api,
    control: factory,
    bindingStore: { read: () => binding } as unknown as CodexAppServerBindingStore,
    getRuntimeConfig: () => config,
    getPluginConfig: () => pluginConfig,
  });
  const request = {
    taskId: "task",
    taskKind: "codex-native",
    runId: "codex-thread:child-thread",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    ownerKey: "agent:main:main",
    allowProcessHomeFallback: false,
    limit: 10,
  };
  return {
    reader,
    request,
    readThread,
    listItemPage,
    requireEligibleThread,
    control,
    home,
    setBinding: (next: typeof binding) => {
      binding = next;
    },
    resetSession: () => {
      sessionId = "replacement-session";
    },
    removeHome: () => {
      homes = [];
    },
  };
}

describe("Codex task transcript admission", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not recover a managed binding through an isolated process home", async () => {
    vi.stubEnv("CODEX_HOME", "");
    const f = fixture(false, "user");
    await expect(f.reader.read(f.request)).rejects.toThrow("source home is unavailable");
    expect(f.readThread).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reads child lineage using the %s supervision binding without admitting it to catalog",
    async (supervised) => {
      const f = fixture(supervised);
      const page = await f.reader.read(f.request);
      expect(page.items).toEqual([{ id: "message", type: "agentMessage", text: "Child output" }]);
      expect(page.nextCursor).toBe("native-older");
      expect(f.requireEligibleThread).not.toHaveBeenCalled();
      await f.reader.read({ ...f.request, cursor: page.nextCursor });
      expect(f.listItemPage).toHaveBeenLastCalledWith({
        threadId: "child-thread",
        limit: 10,
        cursor: "native-older",
        sortDirection: "desc",
      });
    },
  );

  it.each(["wrong-parent", "wrong-thread", "not-a-child"])(
    "rejects %s metadata before history I/O",
    async (kind) => {
      const f = fixture();
      f.readThread.mockResolvedValueOnce(
        idleThread({
          id: kind === "wrong-thread" ? "other-thread" : "child-thread",
          source:
            kind === "not-a-child"
              ? "cli"
              : { subAgent: { thread_spawn: { parent_thread_id: "other-parent", depth: 1 } } },
        }),
      );
      await expect(f.reader.read(f.request)).rejects.toThrow("does not belong");
      expect(f.listItemPage).not.toHaveBeenCalled();
    },
  );

  it.each(["missing-binding", "changed-connection", "missing-home", "isolated-home"])(
    "rejects %s before reading a native thread",
    async (kind) => {
      const f = fixture(true);
      if (kind === "missing-binding") {
        f.setBinding(undefined);
      }
      if (kind === "changed-connection") {
        f.control.connectionFingerprint = "other-source";
      }
      if (kind === "missing-home") {
        f.removeHome();
      }
      if (kind === "isolated-home") {
        f.home.usesProcessHomeFallback = true;
      }
      await expect(f.reader.read(f.request)).rejects.toThrow();
      expect(f.readThread).not.toHaveBeenCalled();
    },
  );

  it("checks the managed runtime identity instead of a same-id thread in another home", async () => {
    const f = fixture();
    vi.spyOn(f.control.forkContext!.client, "getRuntimeIdentity").mockReturnValue({
      codexHome: "/fixture/other",
      serverVersion: "test-server",
    });
    await expect(f.reader.read(f.request)).rejects.toThrow("connection changed");
    expect(f.readThread).not.toHaveBeenCalled();
  });

  it.each(["reset", "rebound", "home-retired"])(
    "discards history when parent authority is %s during I/O",
    async (kind) => {
      const f = fixture(true);
      f.listItemPage.mockImplementationOnce(async () => {
        if (kind === "reset") {
          f.resetSession();
        }
        if (kind === "rebound") {
          f.setBinding(undefined);
        }
        if (kind === "home-retired") {
          f.removeHome();
        }
        return { data: [], nextCursor: "older" };
      });
      await expect(f.reader.read(f.request)).rejects.toThrow("binding changed");
    },
  );
});
