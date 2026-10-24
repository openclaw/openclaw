import { DatabaseSync, StatementSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectConversationBindingAsync } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import {
  registerSessionBindingAdapter as registerAdapter,
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

const prepareOwners = matrixPlugin.messaging?.prepareConversationRouteOwnersAsync;
if (!prepareOwners) {
  throw new Error("Matrix conversation route owner is not registered");
}
type RouteParams = Parameters<NonNullable<typeof prepareOwners>>[0][number];
async function resolveOwner(
  cfg: OpenClawConfig,
  accountId: string,
  conversation: RouteParams["conversation"],
) {
  const params = { cfg, accountId, conversation };
  const [resolve] = await prepareOwners!([params], async (refs) => {
    const inspections = await Promise.all(refs.map(inspectConversationBindingAsync));
    return () => inspections;
  });
  return resolve!(params);
}
type Conversation = RouteParams["conversation"];
type Owner = Awaited<ReturnType<typeof resolveOwner>>;
type CaseOptions = {
  conversation?: Conversation;
  target?: string;
  metadata?: SessionBindingRecord["metadata"];
  unavailable?: boolean;
  configuredAcp?: boolean;
};
type Case = [name: string, conversation: Conversation, expected: Owner, options?: CaseOptions];
const dm: Conversation = {
  kind: "direct",
  peerId: "@alice:example.org",
  nativeChannelId: "!dm:example.org",
};
const channel = (peerId: string): Conversation => ({ kind: "channel", peerId });
const adapterBase = { channel: "matrix", listBySession: () => [] };
const agentIds = ["main", "ops-agent", "sender-agent", "room-agent", "acp-agent", "finance"];
function agentBinding(
  agentId: string,
  accountId: string,
  peer?: { kind: "channel" | "direct"; id: string },
) {
  return { agentId, match: { channel: "matrix", accountId, ...(peer ? { peer } : {}) } };
}
function routeCase(name: string, expected: Owner, options: CaseOptions = {}): Case {
  return [name, options.conversation ?? dm, expected, options];
}
function agentCase(name: string, agentId: string, options: CaseOptions = {}): Case {
  return routeCase(name, { kind: "agent", agentId }, options);
}
function resetRuntime(closeDatabase: boolean) {
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests({ closeDatabase });
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
  );
}
const cases: Case[] = [
  agentCase("native DM runtime agent", "finance", { target: "agent:finance:bound" }),
  agentCase("canonical channel runtime agent", "finance", {
    conversation: channel("!Room:example.org"),
    target: "agent:finance:bound",
  }),
  agentCase("global session metadata owner", "finance", {
    target: "global",
    metadata: { agentId: "finance" },
  }),
  routeCase(
    "plugin thread owner and account fallback",
    { kind: "plugin", pluginId: "demo-plugin", fallbackAgentId: "sender-agent" },
    {
      conversation: { ...dm, threadId: "$Thread:example.org" },
      target: "plugin-thread-1",
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/synthetic/demo-plugin",
      },
    },
  ),
  routeCase("unavailable binding owner", { kind: "unavailable" }, { unavailable: true }),
  routeCase("DM without a native room", null, {
    conversation: { kind: "direct", peerId: "@alice:example.org" },
  }),
  agentCase("sender binding before room fallback", "sender-agent"),
  agentCase("room fallback before account binding", "room-agent", {
    conversation: { ...dm, peerId: "@bob:example.org" },
  }),
  agentCase("configured ACP before sender binding", "acp-agent", { configuredAcp: true }),
  agentCase("thread retains the selected account agent", "ops-agent", {
    conversation: {
      kind: "group",
      peerId: "!Unbound:example.org",
      threadId: "$Thread:example.org",
    },
  }),
];

describe.each(["per-user", "per-room"] as const)(
  "registered Matrix route owner with DM scope %s",
  (sessionScope) => {
    let cfg: OpenClawConfig;
    beforeEach(async () => {
      const stateDir = tempDirs.make("matrix-route-owner-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      resetRuntime(false);
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
          entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
        },
        bindings: [
          agentBinding("main", "default"),
          agentBinding("ops-agent", "ops"),
          agentBinding("room-agent", "ops", { kind: "channel", id: "!dm:example.org" }),
          agentBinding("sender-agent", "ops", { kind: "direct", id: "@alice:example.org" }),
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

    it.each(cases)(
      "preserves %s without credential SQL",
      async (_name, conversation, expected, testCase = {}) => {
        const touch = vi.fn();
        const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(
          (bindingConversation) =>
            testCase.target
              ? {
                  bindingId: "synthetic-binding",
                  targetSessionKey: testCase.target,
                  targetKind: "session",
                  conversation: bindingConversation,
                  status: "active",
                  boundAt: 1,
                  ...(testCase.metadata ? { metadata: testCase.metadata } : {}),
                }
              : null,
        );
        registerAdapter({
          ...adapterBase,
          accountId: "default",
          resolveByConversation: () => {
            throw new Error("Default account must not supply ops ownership");
          },
        });
        if (!testCase.unavailable) {
          registerAdapter({ ...adapterBase, accountId: "ops", resolveByConversation, touch });
        }
        if (testCase.configuredAcp) {
          cfg = {
            ...cfg,
            bindings: [
              ...(cfg.bindings ?? []),
              {
                type: "acp",
                ...agentBinding("acp-agent", "ops", { kind: "channel", id: "!dm:example.org" }),
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
        expect(await resolveOwner(cfg, "ops", conversation)).toEqual(expected);
        expect(touch).not.toHaveBeenCalled();
        if (
          !testCase.unavailable &&
          (conversation.kind !== "direct" || conversation.nativeChannelId)
        ) {
          const roomId = conversation.nativeChannelId ?? conversation.peerId;
          expect(resolveByConversation).toHaveBeenCalledWith({
            channel: "matrix",
            accountId: "ops",
            conversationId: conversation.threadId ?? roomId,
            ...(conversation.threadId ? { parentConversationId: roomId } : {}),
          });
        }
        expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      },
    );
  },
);

type MatrixConfig = NonNullable<OpenClawConfig["channels"]>["matrix"];
type InactiveCase = [string, string, MatrixConfig, Owner?, boolean?];
describe("inactive Matrix account scopes", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env).filter((name) => name.startsWith("MATRIX_"))) {
      vi.stubEnv(key, undefined);
    }
    resetRuntime(true);
  });

  it.each<InactiveCase>([
    ["removed account", "retired", { accounts: { default: {} } }],
    ["removed default", "default", { enabled: true, accounts: { secondary: {} } }],
    ["disabled account", "default", { accounts: { default: { enabled: false } } }],
    ["disabled channel", "default", { enabled: false, accounts: { default: { enabled: true } } }],
    [
      "cached-credential-capable default",
      "default",
      {
        homeserver: "https://matrix.example.org",
        userId: "@proof:example.org",
        accounts: { secondary: {} },
      },
      { kind: "unavailable" },
    ],
    ["empty scoped environment", "retired", { accounts: { secondary: {} } }, null, true],
  ] satisfies InactiveCase[])(
    "resolves %s without a runtime binding owner",
    async (_name, accountId, matrix, expected = null, emptyEnv = false) => {
      if (emptyEnv) {
        vi.stubEnv("MATRIX_RETIRED_HOMESERVER", "");
      }
      const cfg: OpenClawConfig = { channels: { matrix } };
      installMatrixTestRuntime({ cfg });

      expect(await resolveOwner(cfg, accountId, channel("!room:example.org"))).toEqual(expected);
    },
  );
});
