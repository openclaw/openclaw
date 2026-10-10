import type { PendingApprovalSnapshot } from "../../packages/gateway-protocol/src/index.ts";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.ts";
import type { UserProfile } from "../../packages/gateway-protocol/src/schema/users.ts";
import { computeBaseConfigSchemaResponse } from "../../src/config/schema-base.ts";
import type { UsageSummary } from "../../src/infra/provider-usage.types.ts";
import type { ControlUiLinkReaderDocument } from "../../src/shared/control-ui-link-reader.ts";
import type { SessionsUsageResult } from "../../src/shared/usage-types.ts";
import {
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../../ui/src/test-helpers/control-ui-session-fixtures.ts";
import { workboardUi } from "../../ui/src/test-helpers/control-ui-workboard-fixture.ts";
import { buildWorkboardMocks } from "../../ui/src/test-helpers/control-ui-workboard-fixtures.ts";
import { TEST_LINK_READER, testLinkPreview } from "../../ui/src/test-helpers/link-reader.ts";

export const fixedTime = Date.parse("2026-09-01T12:00:00Z");
export const sessionKey = "agent:main:parity";

const profiles: UserProfile[] = Array.from({ length: 30 }, (_, index) => ({
  id: `person-${index}`,
  displayName: `Person ${String(index).padStart(2, "0")} with a long display name`,
  emails: [`person-${index}@example.invalid`],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: fixedTime - 86_400_000,
  updatedAt: fixedTime - 60_000,
}));
const actor = {
  type: "human" as const,
  id: profiles[0]!.id,
  label: profiles[0]!.displayName!,
  identity: { type: "profile" as const, id: profiles[0]!.id },
};
const session = createControlUiSessionRow(sessionKey, "Visual parity", fixedTime - 60_000, {
  sharingRole: "owner",
  visibility: "draft",
  createdActor: actor,
  owner: { actor },
  icon: "🦞",
  color: "blue",
});
const config = {
  browser: { enabled: true, mode: "local" },
  agents: { defaults: { model: "openai/gpt-5.5" } },
  plugins: { entries: { workboard: { enabled: true } } },
};
const totals = {
  input: 7_000,
  output: 3_500,
  cacheRead: 1_750,
  cacheWrite: 0,
  totalTokens: 12_250,
  totalCost: 0.35,
  inputCost: 0.14,
  outputCost: 0.175,
  cacheReadCost: 0.035,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};
const daily = Array.from({ length: 7 }, (_, index) => ({
  date: new Date(fixedTime - (6 - index) * 86_400_000).toISOString().slice(0, 10),
  input: 1_000,
  output: 500,
  cacheRead: 250,
  cacheWrite: 0,
  totalTokens: 1_750,
  totalCost: 0.05,
  inputCost: 0.02,
  outputCost: 0.025,
  cacheReadCost: 0.005,
  cacheWriteCost: 0,
  missingCostEntries: 0,
}));
const usage = {
  updatedAt: fixedTime,
  startDate: daily[0]!.date,
  endDate: daily[6]!.date,
  sessions: [
    {
      key: sessionKey,
      label: "Visual parity",
      agentId: "main",
      modelProvider: "openai",
      model: "gpt-5.5",
      usage: {
        ...totals,
        firstActivity: fixedTime - 6 * 86_400_000,
        lastActivity: fixedTime,
        durationMs: 120_000,
        dailyBreakdown: daily.map((day) => ({
          ...day,
          tokens: day.totalTokens,
          cost: day.totalCost,
        })),
      },
    },
  ],
  totals,
  aggregates: {
    sessionCount: 1,
    messages: { total: 14, user: 7, assistant: 7, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [{ provider: "openai", model: "gpt-5.5", count: 1, totals }],
    byProvider: [{ provider: "openai", count: 1, totals }],
    byAgent: [{ agentId: "main", totals }],
    byChannel: [],
    daily: daily.map((day) => ({
      date: day.date,
      tokens: day.totalTokens,
      cost: day.totalCost,
      messages: 2,
      toolCalls: 0,
      errors: 0,
    })),
    costDaily: daily,
  },
} satisfies SessionsUsageResult;
const providerUsage = {
  updatedAt: fixedTime,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "Daily", usedPercent: 24, resetAt: fixedTime + 12 * 3_600_000 }],
      summary: "Synthetic usage for visual comparison",
    },
  ],
} satisfies UsageSummary;

export const settingsControlsScenario: ControlUiMockGatewayScenario = {
  methodResponses: {
    "config.schema": {
      generatedAt: new Date(fixedTime).toISOString(),
      version: "parity",
      uiHints: {},
      schema: {
        type: "object",
        properties: {
          browser: {
            type: "object",
            title: "Browser",
            properties: {
              enabled: { type: "boolean", title: "Browser Enabled" },
              mode: { type: "string", title: "Mode", enum: ["local", "remote", "disabled"] },
            },
          },
        },
      },
    },
  },
};

export const parityBaseScenario: ControlUiMockGatewayScenario = {
  sessionKey,
  sessions: [session],
  // Bootstrap reads must retain the same principal when users.self resolves.
  presenceUsers: [
    {
      self: true,
      id: profiles[0]!.id,
      identity: { type: "profile", id: profiles[0]!.id },
      name: profiles[0]!.displayName!,
      email: profiles[0]!.emails[0],
      ts: fixedTime,
    },
  ],
  allowedSessionVisibilities: ["shared", "read-only", "suggest", "draft"],
  hasMultipleSessionSharingIdentities: true,
  operatorScopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
  featureMethods: [
    ...defaultControlUiFeatureMethods,
    "config.get",
    "channels.status",
    "channels.pairing.list",
    "doctor.memory.status",
    "backup.status",
    "models.list",
    "models.authStatus",
    "plugins.list",
    "plugins.catalog.browse",
    "plugins.catalog.categories",
    "secrets.store.list",
    "sessions.usage",
    "usage.status",
    "users.self",
    "users.list",
    "forge.preview",
    "forge.detail",
    "webSearch.status",
    "openclaw.chat",
    "openclaw.chat.history",
  ],
  models: [
    { id: "gpt-5.5", name: "gpt-5.5", provider: "openai" },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `parity-model-${index}`,
      name: `Model ${index}`,
      provider: "openai",
    })),
  ],
  historyMessages: [
    {
      role: "user",
      content: [{ type: "text", text: "Review the release checklist." }],
      timestamp: fixedTime - 60_000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "## Release checklist\n\n- Build verified\n- Mobile review pending\n\n| Check | Result |\n| --- | --- |\n| Unit | Passed |\n| Browser | Passed |\n\n```ts\nconst ready = true;\n```",
        },
      ],
      timestamp: fixedTime - 30_000,
    },
  ],
  methodResponses: {
    "config.get": {
      config,
      raw: JSON.stringify(config),
      hash: "parity-config",
      valid: true,
      issues: [],
    },
    "config.schema": computeBaseConfigSchemaResponse({
      generatedAt: new Date(fixedTime).toISOString(),
    }),
    "users.self": { profile: profiles[0] },
    "users.list": { profiles },
    "plugins.list": { plugins: [] },
    "plugins.catalog.browse": { items: [] },
    "plugins.catalog.categories": { categories: [] },
    "doctor.memory.status": {
      agentId: "main",
      provider: "none",
      embedding: { ok: false, checked: false },
    },
    "backup.status": { targets: [], schedules: [], locations: [] },
    "secrets.store.list": { entries: [] },
    "channels.pairing.list": {
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    },
    "session.members.listEvidence": {
      sessionKey,
      members: [],
      role: "owner",
      allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      identities: profiles.map((profile) => ({
        type: "human",
        id: profile.id,
        label: profile.displayName,
      })),
    },
    "models.authStatus": {
      ts: fixedTime,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [{ profileId: "openai:parity", type: "oauth", status: "ok" }],
        },
      ],
    },
    "sessions.usage": usage,
    "usage.status": providerUsage,
    "cron.list": {
      jobs: [],
      snapshotRevision: "parity",
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
    "openclaw.chat": {
      sessionId: "parity-custodian",
      reply: "How can I help with your OpenClaw setup?",
      action: "none",
    },
    "openclaw.chat.history": { turns: [] },
    "webSearch.status": {
      enabled: true,
      provider: null,
      agentId: "main",
      model: { provider: "openai", id: "gpt-5.5", runtime: "openclaw", runtimeLabel: "OpenClaw" },
      route: {
        kind: "managed",
        provider: "parallel-free",
        label: "Parallel Search (Free)",
        testable: true,
      },
      providers: [
        {
          id: "parallel-free",
          pluginId: "parallel",
          label: "Parallel Search (Free)",
          hint: "Free hosted web search",
          configured: true,
          installed: true,
          available: true,
          requiresCredential: false,
          credentialSource: "none",
          configPath: [],
        },
      ],
    },
    "cron.status": { enabled: true, jobs: 0, storePath: "/mock/cron", nextWakeAtMs: null },
    "logs.tail": {
      file: "/mock/gateway.log",
      cursor: 0,
      size: 0,
      lines: [],
      truncated: false,
      reset: false,
    },
    "worktrees.list": { worktrees: [] },
    "worktrees.branches": { branches: [] },
    "node.list": { nodes: [] },
    "device.pair.list": { pending: [], paired: [] },
    "approval.history": { items: [] },
    "exec.approval.grants.list": { grants: [] },
    "transcripts.list": { sessions: [], nextCursor: null },
    "migrations.memory.plan": { agentId: "main", workspace: "/mock/workspace", providers: [] },
    "environments.list": { environments: [], profiles: [] },
    "portal.list": { portals: [] },
    "system.info": {
      machineName: "Parity workstation",
      hostname: "parity.example.invalid",
      platform: "linux",
      release: "6.8.0",
      arch: "x64",
      osLabel: "Linux",
      nodeVersion: "24.15.0",
      pid: 4242,
      uptimeMs: 3_600_000,
      cpuCount: 8,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryFreeBytes: 8 * 1024 ** 3,
    },
    "last-heartbeat": {
      __mockError: {
        code: "UNAVAILABLE",
        message: "Round-trip measurement is unavailable in this deterministic fixture.",
      },
    },
    "system-presence": [],
    "channels.status": {
      ts: fixedTime,
      channelOrder: [],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
    },
  },
};

const workboard = buildWorkboardMocks(fixedTime, actor);
export const parityWorkboardScenario: ControlUiMockGatewayScenario = {
  ...workboardUi,
  sessions: [session, ...workboard.cardSessions],
  sessionTranscripts: workboard.cardSessionHistories,
  featureMethods: [
    ...parityBaseScenario.featureMethods!,
    "board.get",
    "cron.get",
    "workboard.boards.list",
    "workboard.cards.list",
    "workboard.cards.stats",
    "progressCard.get",
  ],
  methodResponses: workboard.methodResponses,
};
export const parityPluginPath = "/plugin?plugin=workboard&id=workboard";

export const parityReaderDocuments: ControlUiLinkReaderDocument[] = Array.from(
  { length: 10 },
  (_, index) => ({
    ...testLinkPreview({
      url: `https://github.com/synthetic/parity/pull/${index + 1}`,
      title: `Visual parity review ${index + 1}: keyboard, layout, and retained content`,
      subtitle: `synthetic/parity #${index + 1}`,
      author: "Synthetic reviewer",
      authorUrl: "https://github.com/synthetic",
      createdAt: new Date(fixedTime - 3_600_000).toISOString(),
      updatedAt: new Date(fixedTime - 60_000).toISOString(),
      badge: { label: "Ready for review", tone: "accent" },
      coAuthors: [{ name: "Reviewer One" }, { name: "Reviewer Two" }],
      coAuthorCount: 3,
      metadata: [
        { label: "Checks", value: "12 passed", tone: "positive" },
        { label: "Files", value: "8" },
      ],
    }),
    body: "## Visual parity review\n\nConfirm the desktop and mobile layouts, readable typography, and keyboard focus.\n\n- Navigation remains visible\n- Controls preserve their selected state\n- Long content wraps within the panel",
    comments: [],
    commentsTotal: 0,
  }),
);
const readerResponses = {
  "forge.preview": {
    cases: parityReaderDocuments.map(
      ({ body: _body, comments: _comments, commentsTotal: _count, ...preview }) => ({
        match: { url: preview.url },
        response: preview,
      }),
    ),
  },
  "forge.detail": {
    cases: parityReaderDocuments.map((document) => ({
      match: { url: document.url },
      response: document,
    })),
  },
};
export const parityHovercardScenario: ControlUiMockGatewayScenario = {
  controlUiLinkReaders: [TEST_LINK_READER],
  historyMessages: [
    {
      role: "assistant",
      timestamp: fixedTime - 30_000,
      content: [
        {
          type: "text",
          text: `Review [the visual parity proposal](${parityReaderDocuments[0]!.url}) before continuing.`,
        },
      ],
    },
  ],
  methodResponses: readerResponses,
};
export const parityTabOverflowScenario: ControlUiMockGatewayScenario = {
  ...parityHovercardScenario,
  historyMessages: [
    {
      role: "assistant",
      timestamp: fixedTime - 30_000,
      content: [
        {
          type: "text",
          text: parityReaderDocuments
            .map((document, index) => `[Review ${index + 1}](${document.url})`)
            .join(" · "),
        },
      ],
    },
  ],
};

const approval: PendingApprovalSnapshot = {
  id: "parity",
  status: "pending",
  urlPath: "/approve/parity",
  createdAtMs: fixedTime - 30_000,
  expiresAtMs: fixedTime + 15 * 60_000,
  presentation: {
    kind: "exec",
    commandText: "pnpm test",
    host: "gateway",
    agentId: "main",
    allowedDecisions: ["allow-once", "deny"],
  },
};
export const standaloneApprovalScenario: ControlUiMockGatewayScenario = {
  featureMethods: ["approval.get", "approval.resolve"],
  operatorScopes: ["operator.read", "operator.approvals"],
  methodResponses: { "approval.get": { approval } },
};
const question: QuestionRecord = {
  id: "parity",
  agentId: "main",
  sessionKey,
  createdAtMs: fixedTime - 30_000,
  expiresAtMs: fixedTime + 15 * 60_000,
  status: "pending",
  questions: [
    {
      questionId: "layout",
      header: "Layout",
      question: "Which layout should the preview use?",
      options: [
        { label: "Comfortable", description: "Keep more space between controls." },
        { label: "Compact", description: "Fit more content within the viewport." },
      ],
      isOther: true,
    },
  ],
};
export const standaloneQuestionScenario: ControlUiMockGatewayScenario = {
  featureMethods: ["question.get", "question.list", "question.resolve"],
  methodResponses: { "question.get": { question }, "question.list": { questions: [question] } },
};
