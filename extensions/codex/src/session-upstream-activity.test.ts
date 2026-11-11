import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionUpstreamProbe } from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./app-server/client.js";
import type { CodexTurn } from "./app-server/protocol.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "./session-catalog-types.js";
import { createChecker } from "./session-upstream-activity.js";

function probe(overrides: Partial<SessionUpstreamProbe> = {}): SessionUpstreamProbe {
  return {
    sessionKey: "agent:main:adopted:codex",
    agentId: "main",
    threadId: "thread-1",
    hostId: "gateway:local",
    upstreamKind: "codex-app-server",
    upstreamRef: { connectionFingerprint: "connection-1", threadId: "thread-1" },
    marker: { turnId: "turn-1", userMessageCount: 1 },
    ownRecentUserTexts: [],
    ...overrides,
  };
}

function turn(
  id: string,
  itemTypes: Array<string | { type: string; text: string; content: unknown[] }>,
  startedAt: number,
): CodexTurn {
  return {
    id,
    startedAt,
    items: itemTypes.map((item, index) => ({
      id: `${id}-item-${index}`,
      ...(typeof item === "string"
        ? { type: item, text: item === "userMessage" ? `${id} prompt ${index}` : "" }
        : item),
    })) as CodexTurn["items"],
  };
}

function createActivityChecker(overrides: Partial<CodexSessionCatalogControl>, linked = false) {
  const control = {
    connectionFingerprint: "connection-1",
    async withPinnedConnection<T>(run: (value: CodexSessionCatalogControl) => Promise<T>) {
      return run(control);
    },
    ...overrides,
  } as CodexSessionCatalogControl;
  const session = {
    resolveStorePath: () => "/activity-store",
    getSessionEntryAsync: async () => (linked ? { sessionId: "session-1" } : undefined),
  };
  const bindingStore = {
    readAsync: async () =>
      linked
        ? {
            threadId: "thread-canonical",
            connectionScope: "supervision",
            supervisionSourceThreadId: "thread-1",
          }
        : undefined,
  } as unknown as CodexAppServerBindingStore;
  return createChecker({
    api: { runtime: { agent: { session } } } as unknown as OpenClawPluginApi,
    bindingStore,
    control: {
      hasActiveWork: () => false,
      disconnect: async () => {},
      forRequest: () => control,
      forNode: async () => {
        throw new Error("Node source is outside this local activity fixture");
      },
      homesForAgent: async () => [],
      forUpstream: async () => control,
    } satisfies CodexSessionCatalogControlFactory,
    getRuntimeConfig: () => undefined,
  });
}

describe("Codex upstream activity", () => {
  it.each([false, true])(
    "verifies an empty turn-page result with thread/read (missing=%s)",
    async (missing) => {
      const fail = (method: string) => {
        throw new CodexAppServerRpcError(
          { code: -32600, message: "thread not loaded: thread-1" },
          method,
        );
      };
      const readThread = vi.fn(async () =>
        missing ? fail("thread/read") : { id: "thread-canonical", projectId: null },
      );
      const check = createActivityChecker(
        {
          listTurnPage: async () => (missing ? fail("thread/turns/list") : { data: [] }),
          readThread,
        },
        !missing,
      );
      await expect(check([probe()])).resolves.toEqual(
        missing ? [{ kind: "missing", sessionKey: "agent:main:adopted:codex" }] : [],
      );
      expect(readThread).toHaveBeenCalledWith(missing ? "thread-1" : "thread-canonical", false);
    },
  );

  it("keeps a failed turns read inconclusive without another request", async () => {
    const readThread = vi.fn();
    const check = createActivityChecker({
      listTurnPage: async ({ threadId }) => {
        if (threadId === "thread-stale") {
          throw new CodexAppServerRpcError(
            { code: -32603, message: "store hiccup" },
            "thread/turns/list",
          );
        }
        return { data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)] };
      },
      readThread,
    });

    await expect(
      check([probe({ threadId: "thread-stale" }), probe({ sessionKey: "healthy" })]),
    ).resolves.toEqual([expect.objectContaining({ sessionKey: "healthy" })]);
    expect(readThread).not.toHaveBeenCalled();
  });

  it.each(["legacy", "batched"])(
    "advances %s steer marker without reporting OpenClaw activity",
    async (kind) => {
      const batched = kind === "batched";
      const activityProbe = probe({
        marker: { turnId: "turn-1", ...(batched ? { userMessageCount: 0 } : {}) },
        ownRecentUserTexts: batched ? ["first steer", "second steer"] : [],
      });
      const items = batched
        ? [
            {
              type: "userMessage",
              text: "",
              content: [
                { type: "text", text: " first   steer ", text_elements: [] },
                { type: "text", text: "second steer", text_elements: [] },
              ],
            },
          ]
        : ["userMessage", "agentMessage", "userMessage"];
      const check = createActivityChecker({
        listTurnPage: async () => ({ data: [turn("turn-1", items, 100)] }),
      });
      await expect(check([activityProbe])).resolves.toEqual([
        {
          kind: "activity",
          sessionKey: "agent:main:adopted:codex",
          humanTurns: 0,
          nextMarker: { turnId: "turn-1", userMessageCount: batched ? 1 : 2 },
        },
      ]);
    },
  );
});
