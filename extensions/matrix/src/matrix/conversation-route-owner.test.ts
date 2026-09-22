import { DatabaseSync, StatementSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../channel.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { loadMatrixCredentials, saveMatrixCredentials } from "./credentials.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    // Binding reset writes state; close its handle before removing the fixture.
    const resetDatabase = openOpenClawStateDatabase();
    await closeOpenClawStateDatabaseAsync();
    expect(resetDatabase.db.isOpen).toBe(false);
    cleanup();
    vi.unstubAllEnvs();
  });
});

const resolveOwner = matrixPlugin.messaging?.resolveConversationRouteOwner;
if (!resolveOwner) {
  throw new Error("Matrix conversation route owner is not registered");
}
type Conversation = Parameters<typeof resolveOwner>[0]["conversation"];
type Owner = ReturnType<typeof resolveOwner>;
type Case = {
  name: string;
  conversation: Conversation;
  target?: string;
  metadata?: SessionBindingRecord["metadata"];
  unavailable?: boolean;
  configuredAcp?: boolean;
  expected: Owner;
};
const dm: Conversation = {
  kind: "direct",
  peerId: "@alice:example.org",
  nativeChannelId: "!dm:example.org",
};
const cases: Case[] = [
  {
    name: "native DM runtime agent",
    conversation: dm,
    target: "agent:finance:bound",
    expected: { kind: "agent", agentId: "finance" },
  },
  {
    name: "canonical channel runtime agent",
    conversation: { kind: "channel", peerId: "!Room:example.org" },
    target: "agent:finance:bound",
    expected: { kind: "agent", agentId: "finance" },
  },
  {
    name: "global session metadata owner",
    conversation: dm,
    target: "global",
    metadata: { agentId: "finance" },
    expected: { kind: "agent", agentId: "finance" },
  },
  {
    name: "plugin thread owner and account fallback",
    conversation: { ...dm, threadId: "$Thread:example.org" },
    target: "plugin-thread-1",
    metadata: {
      pluginBindingOwner: "plugin",
      pluginId: "demo-plugin",
      pluginRoot: "/synthetic/demo-plugin",
    },
    expected: { kind: "plugin", pluginId: "demo-plugin", fallbackAgentId: "sender-agent" },
  },
  {
    name: "unavailable binding owner",
    conversation: dm,
    unavailable: true,
    expected: { kind: "unavailable" },
  },
  {
    name: "DM without a native room",
    conversation: { kind: "direct", peerId: "@alice:example.org" },
    expected: null,
  },
  {
    name: "sender binding before room fallback",
    conversation: dm,
    expected: { kind: "agent", agentId: "sender-agent" },
  },
  {
    name: "room fallback before account binding",
    conversation: { ...dm, peerId: "@bob:example.org" },
    expected: { kind: "agent", agentId: "room-agent" },
  },
  {
    name: "configured ACP before sender binding",
    conversation: dm,
    configuredAcp: true,
    expected: { kind: "agent", agentId: "acp-agent" },
  },
  {
    name: "thread retains the selected account agent",
    conversation: {
      kind: "group",
      peerId: "!Unbound:example.org",
      threadId: "$Thread:example.org",
    },
    expected: { kind: "agent", agentId: "ops-agent" },
  },
];

describe.each(["per-user", "per-room"] as const)(
  "registered Matrix route owner with DM scope %s",
  (sessionScope) => {
    let cfg: OpenClawConfig;
    beforeEach(async () => {
      const stateDir = tempDirs.make("matrix-route-owner-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      resetPluginRuntimeStateForTest();
      resetPluginStateStoreForTests({ closeDatabase: false });
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
      );
      cfg = {
        channels: {
          matrix: {
            defaultAccount: "default",
            homeserver: "https://matrix.example.org",
            dm: { sessionScope: sessionScope === "per-user" ? "per-room" : "per-user" },
            accounts: {
              default: { userId: "@default:example.org" },
              ops: { userId: "@ops:example.org", dm: { sessionScope } },
            },
          },
        },
        agents: {
          ownership: "explicit",
          entries: {
            main: { default: true },
            "ops-agent": {},
            "sender-agent": {},
            "room-agent": {},
            "acp-agent": {},
            finance: {},
          },
        },
        bindings: [
          { agentId: "main", match: { channel: "matrix", accountId: "default" } },
          { agentId: "ops-agent", match: { channel: "matrix", accountId: "ops" } },
          {
            agentId: "room-agent",
            match: {
              channel: "matrix",
              accountId: "ops",
              peer: { kind: "channel", id: "!dm:example.org" },
            },
          },
          {
            agentId: "sender-agent",
            match: {
              channel: "matrix",
              accountId: "ops",
              peer: { kind: "direct", id: "@alice:example.org" },
            },
          },
        ],
      };
      installMatrixTestRuntime({ cfg, stateDir });
      await saveMatrixCredentials(
        {
          homeserver: "https://matrix.example.org",
          userId: "@ops:example.org",
          accessToken: "synthetic-route-owner-token",
        },
        process.env,
        "ops",
      );
      expect(loadMatrixCredentials(process.env, "ops")?.userId).toBe("@ops:example.org");
    });

    it.each(cases)("preserves $name without credential SQL", (testCase) => {
      const touch = vi.fn();
      const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(
        (conversation) =>
          testCase.target
            ? {
                bindingId: "synthetic-binding",
                targetSessionKey: testCase.target,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
                ...(testCase.metadata ? { metadata: testCase.metadata } : {}),
              }
            : null,
      );
      registerSessionBindingAdapter({
        channel: "matrix",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: () => {
          throw new Error("Default account must not supply ops ownership");
        },
      });
      if (!testCase.unavailable) {
        registerSessionBindingAdapter({
          channel: "matrix",
          accountId: "ops",
          listBySession: () => [],
          resolveByConversation,
          touch,
        });
      }
      if (testCase.configuredAcp) {
        cfg = {
          ...cfg,
          bindings: [
            ...(cfg.bindings ?? []),
            {
              type: "acp",
              agentId: "acp-agent",
              match: {
                channel: "matrix",
                accountId: "ops",
                peer: { kind: "channel", id: "!dm:example.org" },
              },
            },
          ],
        };
      }
      const counters = [
        vi.spyOn(DatabaseSync.prototype, "prepare"),
        vi.spyOn(DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        ),
      ];
      try {
        const owner = resolveOwner({ cfg, accountId: "ops", conversation: testCase.conversation });
        const counts = counters.map((counter) => counter.mock.calls.length);
        expect(owner).toEqual(testCase.expected);
        expect(touch).not.toHaveBeenCalled();
        if (testCase.conversation.kind !== "direct" || testCase.conversation.nativeChannelId) {
          if (!testCase.unavailable) {
            expect(resolveByConversation).toHaveBeenCalledWith({
              channel: "matrix",
              accountId: "ops",
              conversationId:
                testCase.conversation.threadId ??
                testCase.conversation.nativeChannelId ??
                testCase.conversation.peerId,
              ...(testCase.conversation.threadId
                ? {
                    parentConversationId:
                      testCase.conversation.nativeChannelId ?? testCase.conversation.peerId,
                  }
                : {}),
            });
          }
        }
        console.info(
          "MATRIX_ROUTE_OWNER_SQL",
          JSON.stringify({ case: testCase.name, sessionScope, counts, owner }),
        );
        expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        counters.forEach((counter) => counter.mockRestore());
      }
    });
  },
);

describe("inactive Matrix account scopes", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env).filter((name) => name.startsWith("MATRIX_"))) {
      vi.stubEnv(key, undefined);
    }
    resetPluginRuntimeStateForTest();
    resetPluginStateStoreForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it.each([
    {
      name: "removed account",
      accountId: "retired",
      matrix: { accounts: { default: {} } },
    },
    {
      name: "removed default account",
      accountId: "default",
      matrix: { enabled: true, accounts: { secondary: {} } },
    },
    {
      name: "disabled account",
      accountId: "default",
      matrix: { accounts: { default: { enabled: false } } },
    },
    {
      name: "disabled channel",
      accountId: "default",
      matrix: { enabled: false, accounts: { default: { enabled: true } } },
    },
  ] satisfies Array<{
    name: string;
    accountId: string;
    matrix: NonNullable<OpenClawConfig["channels"]>["matrix"];
  }>)("rejects a $name without requiring a runtime binding owner", ({ accountId, matrix }) => {
    const cfg: OpenClawConfig = { channels: { matrix } };
    installMatrixTestRuntime({ cfg });

    expect(
      resolveOwner({
        cfg,
        accountId,
        conversation: { kind: "channel", peerId: "!room:example.org" },
      }),
    ).toBeNull();
  });

  it("keeps a cached-credential-capable default without reading credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@proof:example.org",
          accounts: { secondary: {} },
        },
      },
    };
    installMatrixTestRuntime({ cfg });
    expect(
      resolveOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "channel", peerId: "!room:example.org" },
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("rejects an empty scoped environment account", () => {
    vi.stubEnv("MATRIX_RETIRED_HOMESERVER", "");
    const cfg: OpenClawConfig = { channels: { matrix: { accounts: { secondary: {} } } } };
    installMatrixTestRuntime({ cfg });
    expect(
      resolveOwner({
        cfg,
        accountId: "retired",
        conversation: { kind: "channel", peerId: "!room:example.org" },
      }),
    ).toBeNull();
  });
});
