import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntryAsync,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  useSessionStoreTempDirs,
  useSqliteWorkerFault,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { resolveMSTeamsAccountConfig, withAccountScopedMSTeamsConfig } from "../accounts.js";
import { createMSTeamsConversationStoreState } from "../conversation-store-state.js";
import type { StoredConversationReference } from "../conversation-store.js";
import { createMSTeamsActivityHandler } from "../monitor-handler.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "../monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { getMSTeamsRuntime, setMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { msteamsRuntimeStub } from "../test-support/runtime.js";
import { createMSTeamsHandlerConfigReader } from "./config.js";

// mock-isolation: Removal dispatch does not create message turns or provider requests.
vi.mock("./message-handler.js", () => ({ createMSTeamsMessageHandler: () => vi.fn() }));
// mock-isolation: Reaction delivery is unrelated to installation removal and session persistence.
vi.mock("./reaction-handler.js", () => ({ createMSTeamsReactionHandler: () => vi.fn() }));

const deleteFault = useSqliteWorkerFault([
  {
    name: "refuse_teams_session_delete",
    match: /^delete from session_nodes\b/u,
    sql: `CREATE TEMP TRIGGER refuse_teams_session_delete BEFORE DELETE ON main.session_nodes
      BEGIN SELECT RAISE(ABORT, 'synthetic Teams session delete failure'); END;`,
  },
]);
const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-msteams-removal-");
const conversationId = "19:personal-installation";
const storedUser = "aad-dm-owner";
let stateDir: string;

beforeEach(() => {
  stateDir = tempDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  resetPluginStateStoreForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function config(
  params: {
    dmScope?: NonNullable<OpenClawConfig["session"]>["dmScope"];
    sameAgent?: boolean;
    singleAccount?: boolean;
  } = {},
): OpenClawConfig {
  return {
    agents: { entries: { home: {}, office: {}, research: {} } },
    session: {
      dmScope: params.dmScope ?? "per-channel-peer",
      store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
    bindings: [
      { agentId: "office", match: { channel: "msteams", accountId: "office" } },
      {
        agentId: params.sameAgent ? "office" : "research",
        match: { channel: "msteams", accountId: "research" },
      },
    ],
    channels: {
      msteams: {
        welcomeCard: false,
        accounts: {
          office: { appId: "office-app" },
          ...(params.singleAccount ? {} : { research: { appId: "research-app" } }),
        },
      },
    },
  };
}

function reference(): StoredConversationReference {
  return {
    user: { id: "bf-dm-owner", aadObjectId: storedUser },
    agent: { id: "office-bot" },
    conversation: { id: conversationId, conversationType: "personal" },
    serviceUrl: "https://teams.example.test",
  };
}

function removal(overrides: Partial<MSTeamsTurnContext["activity"]> = {}): MSTeamsTurnContext {
  return {
    activity: {
      id: "installation-removed",
      type: "installationUpdate",
      action: "remove",
      // Teams may attribute an uninstall to an administrator instead of the DM owner.
      from: { id: "bf-admin", aadObjectId: "aad-admin" },
      recipient: { id: "office-bot" },
      conversation: { id: conversationId, conversationType: "personal" },
      ...overrides,
    },
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  };
}

async function fixture(cfg = config(), storedReference = reference()) {
  installMSTeamsTestRuntime();
  const runtime = getMSTeamsRuntime();
  setMSTeamsRuntime({
    ...runtime,
    channel: {
      ...runtime.channel,
      routing: { ...runtime.channel.routing, resolveAgentRoute },
    },
    state: msteamsRuntimeStub.state,
  });
  const accountCfg = withAccountScopedMSTeamsConfig({
    cfg,
    accountId: "office",
    accountConfig: resolveMSTeamsAccountConfig(cfg, "office"),
  });
  const conversationStore = createMSTeamsConversationStoreState({ accountId: "office" });
  await conversationStore.upsert(conversationId, storedReference);
  const deps: MSTeamsMessageHandlerDeps = {
    ...createMSTeamsMessageHandlerDeps({ cfg: accountCfg }),
    accountPolicyCfg: cfg,
    accountId: "office",
    appId: "office-app",
    conversationStore,
  };
  deps.readConfig = createMSTeamsHandlerConfigReader(deps);
  return { deps, conversationStore, handle: createMSTeamsActivityHandler(deps) };
}

async function seed(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  text: string;
  locked?: boolean;
}) {
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
  };
  await upsertSessionEntry({
    ...scope,
    entry: {
      sessionId: params.sessionId,
      updatedAt: 1_000,
      ...(params.locked ? { modelSelectionLocked: true } : {}),
    },
  });
  const transcript = { ...scope, sessionId: params.sessionId };
  await appendSessionTranscriptMessageByIdentity({
    ...transcript,
    message: { role: "user", content: params.text },
  });
  return { scope, transcript };
}

async function expectHistory(
  target: Parameters<typeof readSessionTranscriptEvents>[0],
  text: string,
) {
  const events = await readSessionTranscriptEvents(target);
  const headers = events.filter(
    (event) =>
      event !== null && typeof event === "object" && "type" in event && event.type === "session",
  );
  expect(headers).toEqual([expect.objectContaining({ type: "session", id: target.sessionId })]);
  const messages = events.flatMap((event) => {
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      event.type === "message" &&
      "message" in event
    ) {
      return [event.message];
    }
    return [];
  });
  expect(messages).toEqual([expect.objectContaining({ role: "user", content: text })]);
}

describe("Microsoft Teams installation removal through the activity handler", () => {
  it.each([
    { name: "separate agent stores", dmScope: "per-channel-peer" as const, sameAgent: false },
    {
      name: "account-scoped sessions in one agent",
      dmScope: "per-account-channel-peer" as const,
      sameAgent: true,
    },
  ])("retires only the removed account's DM with $name", async (testCase) => {
    const cfg = config(testCase);
    const { handle, conversationStore } = await fixture(cfg);
    const accountSegment = testCase.sameAgent ? "office:" : "";
    const removed = await seed({
      cfg,
      agentId: "office",
      sessionKey: `agent:office:msteams:${accountSegment}direct:${storedUser}`,
      sessionId: "removed-session",
      text: "OLD_OFFICE_HISTORY",
    });
    const sibling = await seed({
      cfg,
      agentId: testCase.sameAgent ? "office" : "research",
      sessionKey: testCase.sameAgent
        ? `agent:office:msteams:research:direct:${storedUser}`
        : `agent:research:msteams:direct:${storedUser}`,
      sessionId: "research-session",
      text: "RESEARCH_HISTORY",
    });
    const fallback = await seed({
      cfg,
      agentId: "home",
      sessionKey: testCase.sameAgent
        ? `agent:home:msteams:default:direct:${storedUser}`
        : `agent:home:msteams:direct:${storedUser}`,
      sessionId: "fallback-session",
      text: "DEFAULT_ROUTE_HISTORY",
    });
    const otherStore = createMSTeamsConversationStoreState({ accountId: "research" });
    await otherStore.upsert(conversationId, { ...reference(), agent: { id: "research-bot" } });
    await expectHistory(removed.transcript, "OLD_OFFICE_HISTORY");

    await handle(removal());

    expect(await getSessionEntryAsync(removed.scope)).toBeUndefined();
    expect(await readSessionTranscriptEvents(removed.transcript)).toEqual([]);
    expect(await conversationStore.get(conversationId)).toBeNull();
    await expectHistory(sibling.transcript, "RESEARCH_HISTORY");
    await expectHistory(fallback.transcript, "DEFAULT_ROUTE_HISTORY");
    expect(await otherStore.get(conversationId)).toMatchObject({ agent: { id: "research-bot" } });
    expect(
      (await fs.readdir(path.dirname(removed.scope.storePath))).some((name) =>
        name.includes(".deleted."),
      ),
    ).toBe(true);

    // A second Bot Framework removal event cannot erase newly allocated context
    // after the installation reference was retired.
    const fresh = await seed({
      cfg,
      agentId: "office",
      sessionKey: removed.scope.sessionKey,
      sessionId: "fresh-session",
      text: "FRESH_OFFICE_HISTORY",
    });
    await handle(removal({ type: "conversationUpdate", membersRemoved: [{ id: "office-bot" }] }));
    await expectHistory(fresh.transcript, "FRESH_OFFICE_HISTORY");
    await conversationStore.upsert(conversationId, reference());
    await handle(removal({ id: "installation-readded", action: "add" }));
    await expectHistory(fresh.transcript, "FRESH_OFFICE_HISTORY");
  });

  it.each([
    { name: "manifest removal", activity: { action: "remove-upgrade" } },
    {
      name: "bot member removal",
      activity: { type: "conversationUpdate", membersRemoved: [{ id: "office-bot" }] },
    },
  ])("handles $name as an installation boundary", async ({ activity }) => {
    const cfg = config({ singleAccount: true });
    const { handle } = await fixture(cfg);
    const session = await seed({
      cfg,
      agentId: "office",
      sessionKey: `agent:office:msteams:direct:${storedUser}`,
      sessionId: "before-removal",
      text: "PRIOR_CONTEXT",
    });
    await handle(removal(activity));
    expect(await getSessionEntryAsync(session.scope)).toBeUndefined();
  });

  it.each([
    {
      name: "another member leaving",
      activity: { type: "conversationUpdate", membersRemoved: [{ id: "other-member" }] },
    },
    { name: "ordinary app upgrade", activity: { action: "add-upgrade" } },
    { name: "another bot's installation", activity: { recipient: { id: "another-bot" } } },
    {
      name: "group installation",
      activity: {
        conversation: { id: conversationId, conversationType: "groupChat", isGroup: true },
      },
    },
    { name: "team installation", activity: { channelData: { team: { id: "team-1" } } } },
  ])("preserves DM context for $name", async ({ activity }) => {
    const cfg = config();
    const { handle } = await fixture(cfg);
    const session = await seed({
      cfg,
      agentId: "office",
      sessionKey: `agent:office:msteams:direct:${storedUser}`,
      sessionId: "preserved-session",
      text: "KEEP_CONTEXT",
    });
    await handle(removal(activity));
    expect(await getSessionEntryAsync(session.scope)).toMatchObject({
      sessionId: "preserved-session",
    });
    await expectHistory(session.transcript, "KEEP_CONTEXT");
  });

  it.each([
    { name: "main", dmScope: "main" as const, sessionKey: "agent:office:main" },
    {
      name: "peer across channels",
      dmScope: "per-peer" as const,
      sessionKey: `agent:office:direct:${storedUser}`,
    },
    {
      name: "peer across bot accounts",
      dmScope: "per-channel-peer" as const,
      sessionKey: `agent:office:msteams:direct:${storedUser}`,
    },
  ])("preserves sessions shared by $name", async ({ dmScope, sessionKey }) => {
    const cfg = config({ dmScope, sameAgent: true });
    const { handle, conversationStore } = await fixture(cfg);
    const session = await seed({
      cfg,
      agentId: "office",
      sessionKey,
      sessionId: "shared-session",
      text: "SHARED_HISTORY",
    });
    await handle(removal());
    await expectHistory(session.transcript, "SHARED_HISTORY");
    expect(await conversationStore.get(conversationId)).toBeNull();
  });

  it("preserves a locked session while retiring its installation reference", async () => {
    const cfg = config();
    const { handle, conversationStore } = await fixture(cfg);
    const session = await seed({
      cfg,
      agentId: "office",
      sessionKey: `agent:office:msteams:direct:${storedUser}`,
      sessionId: "locked-session",
      text: "LOCKED_HISTORY",
      locked: true,
    });
    await handle(removal());
    expect(await getSessionEntryAsync(session.scope)).toMatchObject({
      sessionId: "locked-session",
      modelSelectionLocked: true,
    });
    await expectHistory(session.transcript, "LOCKED_HISTORY");
    expect(await conversationStore.get(conversationId)).toBeNull();
  });

  it("propagates a real session-store failure and retains the reference for retry", async () => {
    const cfg = config();
    const { handle, conversationStore } = await fixture(cfg);
    const session = await seed({
      cfg,
      agentId: "office",
      sessionKey: `agent:office:msteams:direct:${storedUser}`,
      sessionId: "retry-session",
      text: "RETRY_HISTORY",
    });
    deleteFault.enable();
    try {
      await expect(handle(removal())).rejects.toThrow("synthetic Teams session delete failure");
      expect(await conversationStore.get(conversationId)).toMatchObject({
        user: { aadObjectId: storedUser },
      });
      expect(await getSessionEntryAsync(session.scope)).toMatchObject({
        sessionId: "retry-session",
      });
    } finally {
      deleteFault.disable();
    }
    await handle(removal());
    expect(await getSessionEntryAsync(session.scope)).toBeUndefined();
    expect(await conversationStore.get(conversationId)).toBeNull();
  });
});
