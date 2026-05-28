import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pushMessageMock: vi.fn(),
  getActiveChatIdMock: vi.fn(),
  setActiveChatIdMock: vi.fn(),
  editMessageMock: vi.fn(),
  callGatewayCompatMock: vi.fn(),
  gatewayRpcMock: {
    fetchHealth: vi.fn(),
    fetchUsage: vi.fn(),
    fetchSystemSnapshot: vi.fn(),
    fetchCronJobs: vi.fn(),
    fetchModels: vi.fn(),
    fetchCurrentModel: vi.fn(),
    fetchAgents: vi.fn(),
    fetchActiveAgentId: vi.fn(),
    fetchSessions: vi.fn(),
    fetchSessionDetail: vi.fn(),
    abortSession: vi.fn(),
    compactSession: vi.fn(),
    deleteSession: vi.fn(),
    tailLogsWithStatus: vi.fn(),
  },
}));

vi.mock("./telegram-push.js", () => ({
  pushMessage: mocks.pushMessageMock,
  getActiveChatId: mocks.getActiveChatIdMock,
  setActiveChatId: mocks.setActiveChatIdMock,
  editMessage: mocks.editMessageMock,
}));

vi.mock("../gateway-rpc.js", () => ({
  callGatewayCompat: mocks.callGatewayCompatMock,
  getGatewayRPC: () => mocks.gatewayRpcMock,
}));

import {
  interactiveReplyToTelegramMessage,
  normalizeLegacyTelegramButtonLabel,
  registerSuperClawInteractiveHandler,
  resetTelegramEditNoopCacheForTests,
} from "./callback-router.js";
import { buildMorePanel } from "./more-panel.js";
import { buildTradingPanel } from "./trading-panel.js";

type SubagentRunResult = { runId: string };
type SubagentWaitResult =
  | { status: "ok" }
  | { status: "timeout" }
  | { status: "error"; error?: string };

type SubagentMock = {
  run: ReturnType<typeof vi.fn<[unknown], Promise<SubagentRunResult>>>;
  waitForRun: ReturnType<typeof vi.fn<[unknown], Promise<SubagentWaitResult>>>;
  getSessionMessages: ReturnType<typeof vi.fn<[unknown], Promise<{ messages: unknown[] }>>>;
  deleteSession: ReturnType<typeof vi.fn<[unknown], Promise<void>>>;
};

type TelegramResponderMock = {
  editMessage: ReturnType<typeof vi.fn<[unknown], Promise<void>>>;
  reply: ReturnType<typeof vi.fn<[unknown], Promise<void>>>;
};

function createResponder(): TelegramResponderMock {
  return {
    editMessage: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

describe("legacy telegram button label localization", () => {
  it("normalizes known English labels into Chinese equivalents", () => {
    expect(normalizeLegacyTelegramButtonLabel("🔄 Workflow")).toBe("🔄 工作流程");
    expect(normalizeLegacyTelegramButtonLabel("🔄 Workfl...")).toBe("🔄 工作流程");
    expect(normalizeLegacyTelegramButtonLabel("🚀 DevOps")).toBe("🚀 維運");
    expect(normalizeLegacyTelegramButtonLabel("🚀 DevOp...")).toBe("🚀 維運");
    expect(normalizeLegacyTelegramButtonLabel("📊 Agent 管理")).toBe("📊 智能體 管理");
    expect(normalizeLegacyTelegramButtonLabel("📊 Agen... 管理")).toBe("📊 智能體 管理");
    expect(normalizeLegacyTelegramButtonLabel("💻 Codex")).toBe("💻 寫碼");
    expect(normalizeLegacyTelegramButtonLabel("🖥️ Dashboard")).toBe("🖥️ 儀表板");
    expect(normalizeLegacyTelegramButtonLabel("🖥️ Dash...")).toBe("🖥️ 儀表板");
  });

  it("normalizes legacy English labels when converting panel to telegram message", () => {
    const message = interactiveReplyToTelegramMessage({
      blocks: [
        { type: "text", text: "panel" },
        {
          type: "buttons",
          buttons: [
            { label: "🔄 Workflow", value: "sc:wf", style: "primary" },
            { label: "🔄 Workfl...", value: "sc:wf2", style: "primary" },
            { label: "🚀 DevOps", value: "sc:devops", style: "primary" },
            { label: "🚀 DevOp...", value: "sc:devops2", style: "primary" },
            { label: "📊 Agent", value: "sc:agents", style: "primary" },
            { label: "📊 Agen...", value: "sc:agents2", style: "primary" },
            { label: "💻 Codex", value: "sc:code", style: "primary" },
            { label: "🖥️ Dashboard", value: "sc:dash", style: "primary" },
            { label: "🖥️ Dash...", value: "sc:dash2", style: "primary" },
          ],
        },
      ],
    });
    const labels = (message.buttons ?? []).flat().map((btn) => btn.text);
    expect(labels).toEqual(
      expect.arrayContaining(["🔄 工作流程", "🚀 維運", "📊 智能體", "💻 寫碼", "🖥️ 儀表板"]),
    );
    for (const label of labels) {
      expect(label).not.toMatch(/\b(Workflow|DevOps|Agent|Codex|Dashboard)\b/i);
      expect(label).not.toMatch(/\b(Workfl|DevOp|Agen|Dash)\b/i);
    }
  });

  it("normalizes legacy English labels inside overrides.buttons", () => {
    const message = interactiveReplyToTelegramMessage(
      {
        blocks: [{ type: "text", text: "panel" }],
      },
      {
        buttons: [
          [
            { text: "🔄 Workflow", callback_data: "sc:wf" },
            { text: "🔄 Workfl...", callback_data: "sc:wf2" },
            { text: "🚀 DevOps", callback_data: "sc:devops" },
            { text: "🚀 DevOp...", callback_data: "sc:devops2" },
            { text: "📊 Agent", callback_data: "sc:agents" },
            { text: "📊 Agen...", callback_data: "sc:agents2" },
            { text: "💻 Codex", callback_data: "sc:code" },
            { text: "🖥️ Dashboard", callback_data: "sc:dash" },
            { text: "🖥️ Dash...", callback_data: "sc:dash2" },
          ],
        ],
      },
    );
    const labels = (message.buttons ?? []).flat().map((btn) => btn.text);
    expect(labels).toEqual([
      "🔄 工作流程",
      "🔄 工作流程",
      "🚀 維運",
      "🚀 維運",
      "📊 智能體",
      "📊 智能體",
      "💻 寫碼",
      "🖥️ 儀表板",
      "🖥️ 儀表板",
    ]);
  });
});

function createSubagent(waitResult: SubagentWaitResult, assistantContent = "完成"): SubagentMock {
  return {
    run: vi.fn(async () => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => waitResult),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: assistantContent }],
    })),
    deleteSession: vi.fn(async () => {}),
  };
}

async function triggerDoTestTask(subagent: SubagentMock, respond: TelegramResponderMock) {
  let handler: ((ctx: unknown) => Promise<{ handled: boolean }>) | undefined;
  const api = {
    runtime: { subagent },
    registerInteractiveHandler: vi.fn(
      (registered: { handler: (ctx: unknown) => Promise<{ handled: boolean }> }) => {
        handler = registered.handler;
      },
    ),
  };

  registerSuperClawInteractiveHandler(api as never);
  expect(handler).toBeDefined();

  const result = await handler!({
    senderId: 42,
    callback: { payload: "do:test", chatId: 5566 },
    respond,
  });

  expect(result).toEqual({ handled: true });
}

async function triggerCallback(
  subagent: SubagentMock,
  respond: TelegramResponderMock,
  payload: string,
  senderId = 42,
) {
  let handler: ((ctx: unknown) => Promise<{ handled: boolean }>) | undefined;
  const api = {
    runtime: { subagent },
    registerInteractiveHandler: vi.fn(
      (registered: { handler: (ctx: unknown) => Promise<{ handled: boolean }> }) => {
        handler = registered.handler;
      },
    ),
  };

  registerSuperClawInteractiveHandler(api as never);
  expect(handler).toBeDefined();

  const result = await handler!({
    senderId,
    callback: { payload, chatId: 5566 },
    respond,
  });
  expect(result).toEqual({ handled: true });
}

function extractInlineCallbacks(message: unknown): string[] {
  const rows = (
    message as {
      buttons?: Array<Array<{ callback_data?: string }>>;
    }
  )?.buttons;
  return (rows ?? [])
    .flat()
    .map((button) => button.callback_data)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function extractInlineTexts(message: unknown): string[] {
  const rows = (
    message as {
      buttons?: Array<Array<{ text?: string }>>;
    }
  )?.buttons;
  return (rows ?? [])
    .flat()
    .map((button) => button.text)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function extractTradingPanelCallbacks(): string[] {
  const panel = buildTradingPanel({
    mode: "paper",
    connected: true,
    quoteStatus: "fresh",
    positions: [],
    quotes: [],
    blockers: [],
  });
  const callbacks = panel.blocks
    .flatMap((block) =>
      block.type === "buttons" ? block.buttons.map((button) => button.value) : [],
    )
    .filter((value): value is string => typeof value === "string" && value.startsWith("sc:tr:"))
    .map((value) => value.slice("sc:".length));
  return [...new Set(callbacks)];
}

const SHORTCUT_GATE_REPORT_FILENAME = "openclaw-telegram-trading-shortcuts-latest.json";
const OKX_HEARTBEAT_OPERATION_REPORT_FILENAME =
  "openclaw-okx-current-readiness-heartbeat-operation-latest.json";
const OKX_REFRESH_WORKFLOW_REPORT_FILENAME =
  "openclaw-okx-current-readiness-refresh-workflow-latest.json";
const CAPITAL_HIGH_CONFIDENCE_PAPER_RERUN_REPORT_FILENAME =
  "openclaw-capital-high-confidence-paper-rerun-gate-latest.json";
const CAPITAL_STRATEGY_PLATFORM_REPORT_FILENAME =
  "openclaw-capital-direct-strategy-platform-gate-latest.json";

function buildShortcutGateReportFixture(
  generatedAt = "2026-05-24T14:31:35.781Z",
): Record<string, unknown> {
  return {
    generatedAt,
    status: "pass",
    summary: {
      shortcuts: 8,
      checks: 145,
      failed: 0,
      fixtureCoverage: {
        status: "pass",
        checkId: "fast-ticket-audit:callback-learning-summary-shared-formatter-fixture",
        targets: ["callback-router.test.ts", "trading-panel.test.ts"],
      },
      assistantClosure: {
        callback: "sc:tr:assist",
        quickLinks: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop"],
        quickLinksVerifiedByChecks: ["sc:tr:audit", "sc:tr:learn", "sc:tr:paperloop"],
        quickLinksMatchPassedChecks: true,
        paperOnlySafetyVisible: true,
        paperLoopLearningRefresh: {
          callback: "sc:tr:paperloop",
          visibleInPaperLoop: true,
          visibleInAssistant: true,
          visibleInShortcutGate: true,
          brokerCommandLocked: true,
        },
        assistantLearningHint: {
          callback: "sc:tr:assist",
          nextSafeCommand: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
          nextCommandShortRow: {
            command: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
            gateVerified: true,
            buttons: ["sc:tr:learn", "sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
            machineLine:
              "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
          },
          quickLinks: ["sc:tr:audit", "sc:tr:paperloop", "sc:tr:assist"],
          quickLinksVerifiedByChecks: ["sc:tr:assist", "sc:tr:audit", "sc:tr:paperloop"],
          quickLinksMatchPassedChecks: true,
          brokerCommandLocked: true,
        },
      },
    },
    failedChecks: [],
  };
}

function writeShortcutGateReportFixture(repoRoot: string, generatedAt?: string): void {
  const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, SHORTCUT_GATE_REPORT_FILENAME),
    JSON.stringify(buildShortcutGateReportFixture(generatedAt), null, 2),
  );
}

function writeCapitalHighConfidencePaperRerunReportFixture(repoRoot: string): void {
  const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, CAPITAL_HIGH_CONFIDENCE_PAPER_RERUN_REPORT_FILENAME),
    JSON.stringify(
      {
        schema: "openclaw.capital.high-confidence-paper-rerun-gate.v1",
        generatedAt: "2026-05-25T12:43:10.274Z",
        status: "high_confidence_rerun_completed_still_blocked",
        confidenceGate: {
          threshold: 0.6,
          requiredConfidenceForPositiveP05: 1.306666,
          requiredConfidenceStatus: "impossible_under_current_signal_model",
        },
        passCount: 0,
        blockedCount: 5,
        blockers: ["required_confidence_above_one"],
        candidates: [
          { symbol: "CD0000" },
          { symbol: "YM0000" },
          { symbol: "ES0000" },
          { symbol: "GC0000" },
          { symbol: "NQ0000" },
        ],
        safetyLock: {
          paperOnly: true,
          simulatedOnly: true,
          liveTradingEnabled: false,
          writeBrokerOrders: false,
          sentOrder: false,
          noLiveOrderSent: true,
        },
        noOrderWrite: true,
        machineLine:
          "highConfidencePaperRerun=high_confidence_rerun_completed_still_blocked;threshold=0.6;requiredConfidence=1.306666;candidates=CD0000|YM0000|ES0000|GC0000|NQ0000;pass=0;blocked=5;noOrderWrite=true",
      },
      null,
      2,
    ),
  );
}

function writeCapitalStrategyPlatformReportFixture(repoRoot: string): void {
  const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, CAPITAL_STRATEGY_PLATFORM_REPORT_FILENAME),
    JSON.stringify(
      {
        schema: "openclaw.capital.direct-strategy-platform-gate.v1",
        generatedAt: "2026-05-25T12:57:53.346Z",
        status: "blocked_paper_strategy_not_promoted",
        positionDecision: {
          status: "verified",
          usable: true,
          path: "D:\\OpenClaw\\config\\capital-verified-position-snapshot.json",
          verifiedAt: "2026-05-25T00:34:10.000Z",
          verifiedBy: "telegram-owner",
          verifiedAgeSeconds: 44623,
          maxFreshSeconds: 43200,
          freshnessStatus: "stale",
          hasOpenPosition: false,
          netContracts: 0,
          decisionStatus: "verified_flat_no_exit_required",
        },
        execution: {
          noLiveOrderSent: true,
          sentOrder: false,
          activeTargets: {
            verifiedPositionSnapshot: {
              usable: true,
              freshnessStatus: "stale",
              verifiedAgeSeconds: 44623,
              maxFreshSeconds: 43200,
              path: "D:\\OpenClaw\\config\\capital-verified-position-snapshot.json",
            },
          },
        },
        safety: {
          noLiveOrderSent: true,
          no_live_order_sent: true,
          sentOrder: false,
          writeBrokerOrders: false,
        },
      },
      null,
      2,
    ),
  );
}

function writeOkxHeartbeatOperationReportFixture(
  repoRoot: string,
  refreshRun: Record<string, unknown> | null = null,
  options: {
    status?: string;
    code?: string;
    machineLine?: string;
    schedulerNextRunAt?: string;
    executeRequired?: boolean;
    nextSafeTask?: string;
  } = {},
): void {
  const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  const status = options.status ?? "ready_idle_read_only";
  const code =
    options.code ??
    (status === "refresh_available_read_only"
      ? "okx_current_readiness_heartbeat_refresh_available"
      : "okx_current_readiness_heartbeat_ready_idle");
  const schedulerNextRunAt = options.schedulerNextRunAt ?? "2026-05-24T20:15:00.000Z";
  const machineLine =
    options.machineLine ??
    (status === "refresh_available_read_only"
      ? `okxCurrentReadinessHeartbeat=refresh_available current=blocked refresh=available telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=${schedulerNextRunAt} inventoryProbe=ready noOrderWrite=true`
      : `okxCurrentReadinessHeartbeat=idle current=ready refresh=not_needed telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=${schedulerNextRunAt} inventoryProbe=ready noOrderWrite=true`);
  const executeRequired =
    typeof options.executeRequired === "boolean"
      ? options.executeRequired
      : status === "refresh_available_read_only";
  const nextSafeTask =
    options.nextSafeTask ??
    (status === "refresh_available_read_only"
      ? "OKX current-readiness 偵測 stale/blocker；使用 sc:tr:okxrefresh 執行安全刷新。"
      : "OKX current-readiness 已 ready；維持 heartbeat 監看，必要時從 sc:tr:okxrefresh 觸發安全刷新。");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, OKX_HEARTBEAT_OPERATION_REPORT_FILENAME),
    JSON.stringify(
      {
        schema: "openclaw.okx.current-readiness-heartbeat-operation.v1",
        generatedAt: "2026-05-24T20:59:18.902Z",
        status,
        code,
        machineLine,
        action: {
          telegramCallback: "sc:tr:okxrefresh",
          heartbeatCommand: "pnpm okx:current-readiness:heartbeat",
          executeCommand: "pnpm okx:current-readiness:heartbeat:execute",
          refreshCommand: "pnpm okx:current-readiness:refresh",
          oneClickRefresh: true,
          executeRequired,
        },
        nextSafeTask,
        safety: {
          readOnly: true,
          summaryOnly: true,
          heartbeatOnly: !executeRequired,
          orderPlacementEnabled: false,
          cancelOrderEnabled: false,
          noOrderWrite: true,
        },
        reports: {
          currentReadiness: {
            schedulerNextRunAt,
            schedulerNextRunWithinGrace: true,
          },
          inventoryProbe: {
            status: "ready",
            ready: true,
            machineLine:
              "okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true",
            publishProbeCount: 16,
            missingTokens: [],
            noOrderWrite: true,
            publishBridgeStatus: {
              ready: true,
              status: "dry_run_ok",
              machineLine:
                "publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1",
              upstreamStatus: "dry_run_ok",
              upstreamNoOrderWriteVerified: true,
              upstreamNoOrderWriteCount: 4,
              upstreamExecuteRequiredCount: 1,
              upstreamOkxContractVerified: true,
              upstreamOkxContractCount: 1,
              upstreamDmadGateVerified: true,
              upstreamDmadGateCount: 1,
              upstreamMessageTokenCountsSummaryZhTw:
                "messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1",
            },
          },
        },
        refreshRun,
      },
      null,
      2,
    ),
  );
}

function writeControlledRunnerTelegramPublishReportFixture(repoRoot: string): void {
  const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, "openclaw-controlled-task-runner-telegram-publish-latest.json"),
    JSON.stringify(
      {
        schema: "openclaw.controlled-task-runner.telegram-publish.report.v1",
        status: "dry_run_ok",
        dryRun: true,
        dryRunNoSend: true,
        messageTokenCounts: {
          shortcutChecks: 1,
          localExecutorDispatch: 1,
          okxRefresh: 1,
          okxHeartbeat: 1,
          okxContract: 1,
          positionSnapshot: 1,
          executeRequired: 1,
          noOrderWrite: 4,
          nextCommand: 1,
          dmadGate: 1,
        },
        messageTokenCountsSummaryZhTw:
          "messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1",
        commandErrorCode: "DRY_RUN_NO_SEND",
      },
      null,
      2,
    ),
  );
}

function writeOkxRefreshWorkflowReportFixture(
  repoRoot: string,
  failedStepIds: string[] = [],
): void {
  const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
  const failedSteps = new Set(failedStepIds);
  const stepIds = [
    "market_snapshot",
    "market_snapshot_scheduler",
    "demo_simulation",
    "paper_audit_log",
    "paper_audit_summary",
    "telegram_shortcuts",
    "current_readiness_summary",
  ];
  const passedSteps = stepIds.filter((id) => !failedSteps.has(id)).length;
  const blocked = failedSteps.size > 0;
  const schedulerNextRunAt = "2026-05-24T20:15:00.000Z";
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, OKX_REFRESH_WORKFLOW_REPORT_FILENAME),
    JSON.stringify(
      {
        schema: "openclaw.okx.current-readiness-refresh-workflow.v1",
        generatedAt: "2026-05-24T20:59:02.883Z",
        status: blocked ? "blocked_read_only" : "ready_read_only",
        code: blocked
          ? "okx_current_readiness_refresh_blocked"
          : "okx_current_readiness_refresh_ready",
        machineLine: `okxCurrentReadinessRefresh=${blocked ? "fail" : "pass"} steps=${passedSteps}/${stepIds.length} freshness=${blocked ? "stale" : "ok"} schedulerNextRunAt=${schedulerNextRunAt} noOrderWrite=true`,
        schedulerNextRunAt,
        steps: stepIds.map((id) => ({
          id,
          status: failedSteps.has(id) ? "fail" : "pass",
          exitCode: failedSteps.has(id) ? 1 : 0,
        })),
        safety: {
          readOnly: true,
          paperOnly: true,
          summaryOnly: true,
          refreshOnly: true,
          orderPlacementEnabled: false,
          writeTradingEnabled: false,
          submittedOrder: false,
          exchangeWriteAttempted: false,
          orderStatusQueryExecuted: false,
          cancelOrderEnabled: false,
          cancelSubmitted: false,
          noOrderWrite: true,
        },
      },
      null,
      2,
    ),
  );
}

describe("telegram callback router task-thread bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGatewayCompatMock.mockReset();
    resetTelegramEditNoopCacheForTests();
    mocks.getActiveChatIdMock.mockReturnValue(5566);
    mocks.pushMessageMock.mockResolvedValue(null);
    mocks.gatewayRpcMock.fetchHealth.mockResolvedValue({ ok: true });
    mocks.gatewayRpcMock.fetchUsage.mockResolvedValue({ tokensToday: 1234, costToday: 1.23 });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockResolvedValue({
      agentStatus: "待命中",
      activeWorkflows: 0,
      pendingApprovals: 0,
      cronJobsEnabled: 2,
    });
    mocks.gatewayRpcMock.fetchCronJobs.mockResolvedValue([]);
    mocks.gatewayRpcMock.fetchModels.mockResolvedValue([
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    ]);
    mocks.gatewayRpcMock.fetchCurrentModel.mockResolvedValue("claude-sonnet-4-5");
    mocks.gatewayRpcMock.fetchAgents.mockResolvedValue([
      { id: "codex", name: "codex-mini", model: "codex-mini", provider: "openai" },
    ]);
    mocks.gatewayRpcMock.fetchActiveAgentId.mockResolvedValue("codex");
    mocks.gatewayRpcMock.fetchSessions.mockResolvedValue([]);
    mocks.gatewayRpcMock.fetchSessionDetail.mockResolvedValue(null);
    mocks.gatewayRpcMock.abortSession.mockResolvedValue(false);
    mocks.gatewayRpcMock.compactSession.mockResolvedValue(false);
    mocks.gatewayRpcMock.deleteSession.mockResolvedValue(false);
    mocks.gatewayRpcMock.tailLogsWithStatus.mockResolvedValue({ ok: true, logs: [] });
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("pushes timeout completion message when subagent run times out", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "timeout" });

    await triggerDoTestTask(subagent, respond);

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const initialMessage = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(initialMessage.text).toContain("🔄 啟動中");
    expect(initialMessage.text).toContain("跑測試");

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("跑測試");
    expect(pushed.text).toContain("— 失敗");
    expect(pushed.text).toContain("未完成");
  });

  it("pushes error completion message when subagent run returns error", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "error", error: "boom<bad>" });

    await triggerDoTestTask(subagent, respond);

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("跑測試");
    expect(pushed.text).toContain("— 失敗");
    expect(pushed.text).toContain("boom&lt;bad&gt;");
  });

  it("pushes success completion message with assistant summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "完成：測試已全綠");

    await triggerDoTestTask(subagent, respond);

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("跑測試");
    expect(pushed.text).toContain("— 完成");
    expect(pushed.text).toContain("完成：測試已全綠");
  });

  it("filters message delivery warning from subagent completion summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent(
      { status: "ok" },
      "完成：測試已全綠\n⚠️ ✉️ Message failed\n- ⚠️ ✉️ Message failed: retry send",
    );

    await triggerDoTestTask(subagent, respond);

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("完成：測試已全綠");
    expect(pushed.text).not.toContain("Message failed");
  });

  it("falls back to refresh hint when subagent summary only contains delivery warning", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "⚠️ ✉️ Message failed");

    await triggerDoTestTask(subagent, respond);

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("通知回傳異常");
    expect(pushed.text).not.toContain("Message failed");
  });

  it("runs analyze callback as background subagent task", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "分析完成：根因是 timeout");

    await triggerCallback(subagent, respond, "analyze:task-123");

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const initialMessage = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(initialMessage.text).toContain("🔄 啟動中");
    expect(initialMessage.text).toContain("分析錯誤");

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("分析錯誤");
    expect(pushed.text).toContain("分析完成");
  });

  it("runs retry callback as background subagent task", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "重試完成：已修復並驗證");

    await triggerCallback(subagent, respond, "retry:task-456");

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const initialMessage = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(initialMessage.text).toContain("🔄 啟動中");
    expect(initialMessage.text).toContain("重試任務");

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as { text?: string };
    expect(pushed.text).toContain("重試任務");
    expect(pushed.text).toContain("重試完成");
  });

  it("shows editable approval guidance for edit callback", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "edit:task-777");

    expect(mocks.pushMessageMock).not.toHaveBeenCalled();
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("修改後批准");
    expect(firstEdit.text).toContain("task-777");
    expect(firstEdit.buttons?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: "sc:approve:task-777" }),
        expect.objectContaining({ callback_data: "sc:analyze:task-777" }),
      ]),
    );
  });

  it("shows pro panel for pro callback", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "pro");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("升級 SuperClaw Pro");
    expect(firstEdit.text).toContain("授權來源：<code>none</code>");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:buy")).toBe(true);
  });

  it("shows activated pro panel when sender is listed in OPENCLAW_TELEGRAM_PRO_USERS", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42,100");

    await triggerCallback(subagent, respond, "pro");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("你目前已啟用 Pro");
    expect(firstEdit.text).toContain("授權來源：<code>PRO_USERS</code>");
    expect(firstEdit.text).not.toContain("立即升級");
  });

  it("treats wildcard OPENCLAW_TELEGRAM_PRO_USERS=* as pro for all users", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "*");

    await triggerCallback(subagent, respond, "pro");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("你目前已啟用 Pro");
  });

  it("shows guidance when pro buy is triggered without TELEGRAM_BOT_TOKEN", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "pro:buy");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("尚未設定 TELEGRAM_BOT_TOKEN");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:env")).toBe(true);
  });

  it("shows pro env examples when pro env callback is triggered", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("會員設定範例");
    expect(firstEdit.text).toContain("設定檢查");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：❌ 未設定");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：❌ 未設定");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:buy")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro")).toBe(true);
  });

  it("shows configured status in pro env when wildcard users and bot token are set", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "*");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 全部用戶 (*)");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:buy")).toBe(true);
  });

  it("treats whitespace-wrapped wildcard PRO_USERS as all users in pro env summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "  *  ");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_USERS</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 全部用戶 (*)");
  });

  it("does not treat mixed wildcard token list as full wildcard in pro env summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "* ,42");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_USERS</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 1 個 ID");
    expect(firstEdit.text).not.toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 全部用戶 (*)");
  });

  it("shows free non-member status for mixed wildcard token list in pro env summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "* ,42");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：🆓 Free");
    expect(firstEdit.text).toContain("目前授權來源：<code>none</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 1 個 ID");
    expect(firstEdit.text).not.toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 全部用戶 (*)");
  });

  it("shows deduplicated PRO_USERS id count in pro env summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42,42,42");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 1 個 ID");
  });

  it("shows deduplicated PRO_USERS count with mixed separators", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42, 42;42|77");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 2 個 ID");
  });

  it("ignores blank tokens when counting PRO_USERS ids in pro env summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", ", ,42, ,");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 1 個 ID");
  });

  it("counts only valid ids from mixed PRO_USERS values in pro env summary", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42,abc,-1,0");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_USERS</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 1 個 ID");
  });

  it("parses PRO_USERS correctly with spaces and newline separators", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", " 42 \n, 77 ");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_USERS</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 2 個 ID");
  });

  it("keeps deduplicated PRO_USERS count stable for long repeated lists", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repeatedUsers = Array.from({ length: 120 }, () => "42")
      .concat(Array.from({ length: 80 }, () => "77"))
      .join(",");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", repeatedUsers);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_USERS</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 2 個 ID");
  });

  it("shows fail-closed warning when PRO_USERS contains only separators", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", ", , ; |");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：🆓 Free");
    expect(firstEdit.text).toContain("目前授權來源：<code>none</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：⚠️ 已設定但目前無有效 ID");
  });

  it("shows fail-closed warning when OPENCLAW_TELEGRAM_PRO_USERS has no valid ids", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "abc,-1,0");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：🆓 Free");
    expect(firstEdit.text).toContain("目前授權來源：<code>none</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：⚠️ 已設定但目前無有效 ID");
  });

  it("shows PRO_ALL source in pro env for true/1/yes aliases", async () => {
    for (const alias of ["true", "1", "yes"]) {
      const respond = createResponder();
      const subagent = createSubagent({ status: "ok" });
      vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", alias);
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");
      resetTelegramEditNoopCacheForTests();

      await triggerCallback(subagent, respond, "pro:env");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("目前授權：⭐ Pro");
      expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
      expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
    }
  });

  it("shows PRO_ALL source in pro env when OPENCLAW_TELEGRAM_PRO_ALL is uppercase YES", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "YES");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
  });

  it("shows PRO_ALL source in pro env when OPENCLAW_TELEGRAM_PRO_ALL has surrounding whitespace", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", " true ");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
  });

  it("shows PRO_ALL source in pro env when OPENCLAW_TELEGRAM_PRO_ALL is spaced yes alias", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", " yes ");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
  });

  it("shows PRO_ALL source in pro env when OPENCLAW_TELEGRAM_PRO_ALL is spaced numeric alias", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", " 1 ");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
  });

  it("shows PRO_ALL source in pro env when OPENCLAW_TELEGRAM_PRO_ALL is mixed-case true alias", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "TrUe");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
  });

  it("shows PRO_ALL source in pro env when OPENCLAW_TELEGRAM_PRO_ALL includes newline and tab whitespace", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "\ntrue\t");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("TELEGRAM_BOT_TOKEN：✅ 已設定");
  });

  it("prioritizes PRO_ALL over invalid PRO_USERS values", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "true");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "abc,-1,0");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：⚠️ 已設定但目前無有效 ID");
  });

  it("prioritizes PRO_ALL over mixed wildcard PRO_USERS list", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", "true");
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "* ,42");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");

    await triggerCallback(subagent, respond, "pro:env", 77);

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("目前授權：⭐ Pro");
    expect(firstEdit.text).toContain("目前授權來源：<code>PRO_ALL</code>");
    expect(firstEdit.text).toContain("OPENCLAW_TELEGRAM_PRO_USERS：✅ 已設定 1 個 ID");
  });

  it("keeps PRO_ALL disabled for false/no/0 aliases", async () => {
    for (const alias of ["false", "no", "0", " no ", " false ", "\t0\n"]) {
      const respond = createResponder();
      const subagent = createSubagent({ status: "ok" });
      vi.stubEnv("OPENCLAW_TELEGRAM_PRO_ALL", alias);
      vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");
      resetTelegramEditNoopCacheForTests();

      await triggerCallback(subagent, respond, "pro:env");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("目前授權：🆓 Free");
      expect(firstEdit.text).toContain("目前授權來源：<code>none</code>");
    }
  });

  it("creates invoice and renders pro panel link when pro buy succeeds", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: "https://t.me/invoice/abc" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerCallback(subagent, respond, "pro:buy");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0])).toContain("/createInvoiceLink");
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("付款連結");
    expect(firstEdit.text).toContain("https://t.me/invoice/abc");
  });

  it("shows retryable error panel when pro buy invoice creation fails", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "invoice disabled" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerCallback(subagent, respond, "pro:buy");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("操作失敗");
    expect(firstEdit.text).toContain("UNKNOWN");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:buy")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:env")).toBe(true);
  });

  it("swallows not-modified with line breaks inside pro-buy error-panel fallback", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "invoice disabled" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    respond.editMessage.mockRejectedValueOnce(
      new Error("Call to 'editMessageText' failed! (400: Bad Request: message is\nnot modified)"),
    );

    await triggerCallback(subagent, respond, "pro:buy");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when telegram edit returns 'message is not modified'", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
      ),
    );

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when not-modified message has line breaks", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error("Call to 'editMessageText' failed! (400: Bad Request: message is\nnot modified)"),
    );

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when not-modified token includes zero-width separators", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: message\u200Bis\u200Bnot\u200Bmodified)",
      ),
    );

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when not-modified token includes ANSI color codes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: \u001b[31mmessage is not modified\u001b[0m)",
      ),
    );

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when not-modified appears only in Error.stack", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const error = new Error("Call to 'editMessageText' failed!");
    Object.defineProperty(error, "stack", {
      value:
        "Error: Call to 'editMessageText' failed!\n" +
        "    at callback-router.ts:1:1\n" +
        "Caused by: 400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      configurable: true,
    });
    respond.editMessage.mockRejectedValueOnce(error);

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when not-modified message uses escaped newline token", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error("Call to 'editMessageText' failed! (400: Bad Request: message is\\nnot modified)"),
    );

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when not-modified message uses double-escaped newline token", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: message is\\\\nnot modified)",
      ),
    );

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("skips duplicate home-panel edit on repeated same callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "home");
    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate status-panel edit on repeated status callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "stat");
    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate more-panel edit on repeated more callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "more");
    await triggerCallback(subagent, respond, "more");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate trading-panel edit on repeated trade callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "trade");
    await triggerCallback(subagent, respond, "trade");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("renders trading home with fast order audit summary without dispatching subagent", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockImplementation(async (_api: unknown, method: string) => {
      if (method !== "trading.fastOrderAudit.snapshot") {
        return null;
      }
      return {
        status: "loaded",
        safety: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
        },
        latestIntent: {
          status: "written_broker_locked",
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          blockers: ["broker-command-disabled"],
        },
        latestReview: {
          status: "paper_execution_recorded",
          decision: "approve_paper",
          audit: {
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
            blockers: ["broker-command-disabled"],
          },
        },
        latestPaperExecution: {
          recorded: true,
          paperOnly: true,
          symbol: "TX00",
          side: "buy",
          quantity: 1,
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
        },
        history: {
          filter: "all",
          total: 3,
          returned: 3,
        },
      };
    });

    await triggerCallback(subagent, respond, "trade");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
      expect.anything(),
      "trading.fastOrderAudit.snapshot",
      { filter: "all", offset: 0, limit: 3 },
    );
    expect(firstEdit.text).toContain("快速進出場審核摘要");
    expect(firstEdit.text).toContain("paper_execution_recorded");
    expect(firstEdit.text).toContain("approve_paper");
    expect(firstEdit.text).toContain("歷史 總筆=3 回傳=3");
    expect(firstEdit.text).toContain("券商指令可用=❌");
    expect(firstEdit.text).toContain("已送券商單=❌");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:audit")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:paperloop")).toBe(
      true,
    );
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:write")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:approve")).toBe(
      true,
    );
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:deny")).toBe(true);
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("skips duplicate quote-panel edit on repeated tr:quote callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:quote");
    await triggerCallback(subagent, respond, "tr:quote");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate paper-panel edit on repeated tr:paper callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:paper");
    await triggerCallback(subagent, respond, "tr:paper");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate strategy-panel edit on repeated tr:strat callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:strat");
    await triggerCallback(subagent, respond, "tr:strat");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate learning-panel edit on repeated tr:learn callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:learn");
    await triggerCallback(subagent, respond, "tr:learn");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate platform-panel edit on repeated tr:platform callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:platform");
    await triggerCallback(subagent, respond, "tr:platform");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate okx-panel edit on repeated tr:okx callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:okx");
    await triggerCallback(subagent, respond, "tr:okx");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate okx-order-proposal panel edit on repeated tr:okxord callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:okxord");
    await triggerCallback(subagent, respond, "tr:okxord");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate okx-order-status panel edit on repeated tr:okxstat callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:okxstat");
    await triggerCallback(subagent, respond, "tr:okxstat");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate fast-order-write panel edit on repeated tr:write callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:write");
    await triggerCallback(subagent, respond, "tr:write");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("寫入結果已是最新狀態"),
      }),
    );
  });

  it("skips duplicate fast-order-audit panel edit on repeated tr:audit:all_0 callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:audit:all_0");
    await triggerCallback(subagent, respond, "tr:audit:all_0");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("審核紀錄已是最新狀態"),
      }),
    );
  });

  it("skips duplicate fast-order-approve panel edit on repeated tr:approve callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:approve");
    await triggerCallback(subagent, respond, "tr:approve");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("核准結果已是最新狀態"),
      }),
    );
  });

  it("shows approve-specific up-to-date notice when tr:approve edit returns 'message is not modified'", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
      ),
    );

    await triggerCallback(subagent, respond, "tr:approve");

    expect(respond.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("核准結果已是最新狀態"),
      }),
    );
  });

  it("shows audit-specific up-to-date notice when tr:audit edit returns 'message is not modified'", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
      ),
    );

    await triggerCallback(subagent, respond, "tr:audit:all_0");

    expect(respond.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("審核紀錄已是最新狀態"),
      }),
    );
  });

  it("skips duplicate buy-panel edit on repeated tr:buy callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:buy");
    await triggerCallback(subagent, respond, "tr:buy");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate sell-panel edit on repeated tr:sell callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:sell");
    await triggerCallback(subagent, respond, "tr:sell");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate close-all panel edit on repeated tr:closeall callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:closeall");
    await triggerCallback(subagent, respond, "tr:closeall");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("skips duplicate capital-status panel edit on repeated tr:cap callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockResolvedValue(undefined);

    await triggerCallback(subagent, respond, "tr:cap");
    await triggerCallback(subagent, respond, "tr:cap");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("supports legacy trading status callback aliases (tr:status / tr:capital)", async () => {
    const subagent = createSubagent({ status: "ok" });
    for (const payload of ["tr:status", "tr:capital"]) {
      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);
      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
      expect(allMessages.join("\n")).toContain("群益 API 狀態");
    }
  });

  it("shows up-to-date notice for nested not-modified error payload", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce({
      response: {
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
    });

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice for nested not-modified payload with escaped newline token", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce({
      response: {
        description: "Bad Request: message is\\\\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice for nested not-modified payload with single-escaped newline token", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce({
      response: {
        description: "Bad Request: message is\\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice for nested not-modified payload with literal newline token", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    respond.editMessage.mockRejectedValueOnce({
      response: {
        description: "Bad Request: message is\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice for circular not-modified error payload", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const circular: Record<string, unknown> = {
      payload: {
        detail:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
    };
    circular.self = circular;
    respond.editMessage.mockRejectedValueOnce(circular);

    await triggerCallback(subagent, respond, "home");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice for bubbled not-modified error", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce(
      new Error(
        "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
      ),
    );

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice for MESSAGE_NOT_MODIFIED token payload", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        code: "MESSAGE_NOT_MODIFIED",
        message: "MESSAGE_NOT_MODIFIED",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when cause.message has escaped newline not-modified text", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        message: "Bad Request: message is\\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when cause.message has double-escaped newline not-modified text", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        message: "Bad Request: message is\\\\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when cause.message has literal newline not-modified text", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        message: "Bad Request: message is\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when cause.description has escaped newline not-modified text", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        description: "Bad Request: message is\\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when cause.description has literal newline not-modified text", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        description: "Bad Request: message is\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice when cause.description has double-escaped newline not-modified text", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce({
      cause: {
        description: "Bad Request: message is\\\\nnot modified",
      },
    });

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("shows up-to-date notice on stat route when not-modified appears only in Error.stack", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const error = new Error("fetchSystemSnapshot failed");
    Object.defineProperty(error, "stack", {
      value:
        "Error: fetchSystemSnapshot failed\n" +
        "    at callback-router.ts:1:1\n" +
        "Caused by: 400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      configurable: true,
    });
    mocks.gatewayRpcMock.fetchSystemSnapshot.mockRejectedValueOnce(error);

    await triggerCallback(subagent, respond, "stat");

    expect(respond.editMessage).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("畫面已是最新狀態");
  });

  it("does not create invoice when pro user clicks pro buy", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await triggerCallback(subagent, respond, "pro:buy");

    expect(fetchMock).not.toHaveBeenCalled();
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("你目前已啟用 Pro");
  });

  it("does not create invoice when wildcard pro user clicks pro buy", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "*");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await triggerCallback(subagent, respond, "pro:buy");

    expect(fetchMock).not.toHaveBeenCalled();
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("你目前已啟用 Pro");
  });

  it("shows pro badge in stat panel when user is pro", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42");

    await triggerCallback(subagent, respond, "stat");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("授權: ⭐ Pro");
    expect(firstEdit.text).toContain("授權來源: <code>PRO_USERS</code>");
    expect(firstEdit.text).toContain("今日權杖:");
    expect(firstEdit.text).not.toContain("今日 Token:");
    expect(firstEdit.text).toContain("智能體:");
    expect(firstEdit.text).not.toContain("Agent:");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:pro:env")).toBe(true);
  });

  it("shows free badge in stat panel when user is not pro", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "stat");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("授權: 🆓 Free");
    expect(firstEdit.text).toContain("授權來源: <code>none</code>");
    expect(firstEdit.text).toContain("今日權杖:");
    expect(firstEdit.text).not.toContain("今日 Token:");
    expect(firstEdit.text).toContain("智能體:");
    expect(firstEdit.text).not.toContain("Agent:");
  });

  it("covers main-menu and more-panel callbacks with non-empty response", async () => {
    const subagent = createSubagent({ status: "ok" });
    const menuCallbacks = [
      "home",
      "chat",
      "code",
      "wf",
      "cron",
      "model",
      "stat",
      "devops",
      "trade",
      "dash",
      "more",
      "agents",
      "build",
      "sess",
      "history",
      "reset",
      "pro",
    ];

    for (const payload of menuCallbacks) {
      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
    }
  });

  it("covers more-panel callbacks with namespaced payloads", async () => {
    const subagent = createSubagent({ status: "ok" });
    const callbacks = buildMorePanel()
      .blocks.flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .map((button) => button.value)
      .filter((value): value is string => typeof value === "string" && value.startsWith("sc:"));

    for (const payload of callbacks) {
      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
    }
  });

  it("locks namespaced more-panel callback whitelist", () => {
    const callbacks = buildMorePanel()
      .blocks.flatMap((block) => (block.type === "buttons" ? block.buttons : []))
      .map((button) => button.value)
      .filter((value): value is string => typeof value === "string" && value.startsWith("sc:"));

    expect(callbacks).toEqual([
      "sc:wf",
      "sc:cron",
      "sc:model",
      "sc:trade",
      "sc:devops",
      "sc:agents",
      "sc:dash",
      "sc:build",
      "sc:sess",
      "sc:history",
      "sc:reset",
      "sc:pro",
      "sc:home",
    ]);
  });

  it("crawls namespaced more callback graph and keeps discovered callbacks responsive", async () => {
    const subagent = createSubagent({ status: "ok" });
    const queue = ["sc:more"];
    const visited = new Set<string>();
    const discoveredCallbacks = new Set<string>();
    const allowedCallbacks = new Set([
      "sc:home",
      "sc:more",
      "sc:wf",
      "sc:cron",
      "sc:model",
      "sc:trade",
      "sc:devops",
      "sc:agents",
      "sc:dash",
      "sc:build",
      "sc:sess",
      "sc:history",
      "sc:reset",
      "sc:pro",
      "sc:chat",
      "sc:code",
      "sc:stat",
    ]);
    const maxTraversal = 120;

    while (queue.length > 0 && visited.size < maxTraversal) {
      const payload = queue.shift();
      if (!payload || visited.has(payload)) {
        continue;
      }
      visited.add(payload);

      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);

      const allPanels = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => call[0],
      );
      for (const panel of allPanels) {
        for (const callback of extractInlineCallbacks(panel)) {
          if (!allowedCallbacks.has(callback)) {
            continue;
          }
          discoveredCallbacks.add(callback);
          if (!visited.has(callback)) {
            queue.push(callback);
          }
        }
      }
    }

    expect(discoveredCallbacks.size).toBeGreaterThan(8);
    expect([...visited]).toEqual(
      expect.arrayContaining([
        "sc:more",
        "sc:wf",
        "sc:cron",
        "sc:model",
        "sc:trade",
        "sc:devops",
        "sc:agents",
        "sc:dash",
        "sc:build",
        "sc:sess",
        "sc:history",
        "sc:reset",
        "sc:pro",
      ]),
    );
  });

  it("renders trading home panel with non-empty content", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "trade");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(typeof firstEdit.text).toBe("string");
    expect((firstEdit.text ?? "").trim().length).toBeGreaterThan(0);
    expect(firstEdit.text).toContain("交易");
    expect(firstEdit.text).toContain("模擬交易");
  });

  it("renders Telegram shortcut gate summary on the trading panel", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-shortcuts-report-"));
    try {
      writeShortcutGateReportFixture(repoRoot);
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "trade");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("Telegram 快捷 Gate");
      expect(firstEdit.text).toContain("status=<code>pass</code> checks=145 failed=0");
      expect(firstEdit.text).toContain("assistantClosure=✅");
      expect(firstEdit.text).toContain("sc:tr:learn / sc:tr:audit / sc:tr:paperloop");
      expect(firstEdit.text).toContain("verified=sc:tr:audit / sc:tr:learn / sc:tr:paperloop");
      expect(firstEdit.text).toContain(
        "fixtureCoverage=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      );
      expect(firstEdit.text).toContain("paperOnly=✅");
      expect(firstEdit.text).toContain("paperLoop=✅ assistant=✅ brokerLocked=✅");
      expect(firstEdit.text).toContain(
        "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      );
      expect(firstEdit.text).toContain(
        "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> brokerLocked=✅",
      );
      expect(subagent.run).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("follows menu to trading callback chain and keeps sub-actions responsive", async () => {
    const subagent = createSubagent({ status: "ok" });
    const menuRespond = createResponder();

    await triggerCallback(subagent, menuRespond, "more");

    const menuMessage = menuRespond.editMessage.mock.calls[0]?.[0];
    const menuCallbacks = extractInlineCallbacks(menuMessage);
    expect(menuCallbacks).toContain("sc:trade");

    const tradeRespond = createResponder();
    await triggerCallback(subagent, tradeRespond, "trade");

    const tradeMessage = tradeRespond.editMessage.mock.calls[0]?.[0];
    const tradeCallbacks = extractInlineCallbacks(tradeMessage);
    expect(tradeCallbacks).toEqual(
      expect.arrayContaining([
        "sc:tr:platform",
        "sc:tr:quote",
        "sc:tr:corequote",
        "sc:tr:paper",
        "sc:tr:strat",
        "sc:tr:learn",
      ]),
    );

    for (const callbackData of [
      "sc:tr:platform",
      "sc:tr:quote",
      "sc:tr:corequote",
      "sc:tr:paper",
      "sc:tr:strat",
      "sc:tr:learn",
    ]) {
      const respond = createResponder();
      const payload = callbackData.replace(/^sc:/, "");
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
    }
  });

  it("renders more panel callback route with Chinese button labels", async () => {
    const subagent = createSubagent({ status: "ok" });
    const respond = createResponder();

    await triggerCallback(subagent, respond, "more");

    const menuMessage = respond.editMessage.mock.calls[0]?.[0];
    const labels = extractInlineTexts(menuMessage);
    expect(labels).toEqual(
      expect.arrayContaining([
        "🔄 工作流程",
        "⏰ 排程",
        "🧠 切換模型",
        "📈 交易",
        "🚀 維運",
        "📊 智能體管理",
        "🖥️ 儀表板",
        "🔨 程式建置",
        "💬 工作階段",
        "📜 對話歷史",
        "🗑️ 重置對話",
        "⭐ 升級專業版",
        "← 首頁",
      ]),
    );
    for (const label of labels) {
      expect(label).not.toMatch(/\b(Workflow|DevOps|Agent|Codex|Session|Model|More|Dashboard)\b/i);
      expect(label).not.toMatch(/\b(Workfl|DevOp|Agen|Sess|Mod|Mor|Dash)\b/i);
    }
  });

  it("keeps trading main-panel callbacks responsive and non-error", async () => {
    const subagent = createSubagent({ status: "ok" });
    const tradingCallbacks = extractTradingPanelCallbacks();
    expect(tradingCallbacks.length).toBeGreaterThan(0);
    expect(tradingCallbacks).toEqual(
      expect.arrayContaining([
        "tr:platform",
        "tr:quote",
        "tr:corequote",
        "tr:paper",
        "tr:strat",
        "tr:learn",
        "tr:okx",
      ]),
    );

    for (const payload of tradingCallbacks) {
      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
    }
  });

  it("keeps namespaced trading main-panel callbacks responsive and non-error", async () => {
    const subagent = createSubagent({ status: "ok" });
    const tradingCallbacks = extractTradingPanelCallbacks().map((payload) => `sc:${payload}`);
    expect(tradingCallbacks.length).toBeGreaterThan(0);
    expect(tradingCallbacks).toEqual(
      expect.arrayContaining([
        "sc:tr:platform",
        "sc:tr:quote",
        "sc:tr:corequote",
        "sc:tr:paper",
        "sc:tr:strat",
        "sc:tr:learn",
        "sc:tr:okx",
      ]),
    );

    for (const payload of tradingCallbacks) {
      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
    }
  });

  it("keeps namespaced trading second-layer callbacks responsive and non-error", async () => {
    const subagent = createSubagent({ status: "ok" });
    const secondLayerCallbacks = [
      "sc:tr:buy",
      "sc:tr:sell",
      "sc:tr:closeall",
      "sc:tr:closeok",
      "sc:tr:ord:buy_TX00_1",
      "sc:tr:ord:sell_MCL0000_1",
      "sc:tr:audit:all_0",
      "sc:tr:paperloop",
      "sc:tr:assist",
      "sc:tr:rerun",
      "sc:tr:diag",
      "sc:tr:disp",
      "sc:tr:live",
      "sc:tr:directrun",
      "sc:tr:localexec",
      "sc:tr:directpos",
      "sc:tr:ackapply",
      "sc:tr:corequote",
      "sc:tr:receipt",
      "sc:tr:hft",
      "sc:tr:okxord",
      "sc:tr:okxstat",
      "sc:tr:cap",
      "sc:tr:pos",
    ] as const;

    for (const payload of secondLayerCallbacks) {
      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);
    }
  });

  it("crawls namespaced trading callback graph and keeps discovered callbacks responsive", async () => {
    const subagent = createSubagent({ status: "ok" });
    const queue = ["sc:trade"];
    const visited = new Set<string>();
    const discoveredTradingCallbacks = new Set<string>();
    const maxTraversal = 80;

    while (queue.length > 0 && visited.size < maxTraversal) {
      const payload = queue.shift();
      if (!payload || visited.has(payload)) {
        continue;
      }
      visited.add(payload);

      const respond = createResponder();
      await triggerCallback(subagent, respond, payload);

      const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => (call[0] as { text?: string }).text ?? "",
      );
      expect(allMessages.length).toBeGreaterThan(0);
      expect(allMessages.some((text) => text.includes("未知操作"))).toBe(false);
      expect(
        allMessages.some(
          (text) => text.includes("操作失敗") || text.includes("處理你的請求時發生錯誤"),
        ),
      ).toBe(false);

      const allPanels = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
        (call) => call[0],
      );
      for (const panel of allPanels) {
        for (const callback of extractInlineCallbacks(panel)) {
          if (!callback.startsWith("sc:tr:")) {
            continue;
          }
          discoveredTradingCallbacks.add(callback);
          if (!visited.has(callback)) {
            queue.push(callback);
          }
        }
      }
    }

    expect(discoveredTradingCallbacks.size).toBeGreaterThan(10);
    expect([...visited]).toEqual(
      expect.arrayContaining([
        "sc:trade",
        "sc:tr:platform",
        "sc:tr:quote",
        "sc:tr:corequote",
        "sc:tr:paper",
        "sc:tr:strat",
        "sc:tr:learn",
      ]),
    );
  });

  it("renders quote panel with non-empty fallback text when no quote data", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:quote");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(typeof firstEdit.text).toBe("string");
    expect((firstEdit.text ?? "").trim().length).toBeGreaterThan(0);
    expect(firstEdit.text).toContain("報價");
    expect(firstEdit.text).toContain("目前沒有報價資料");
  });

  it("renders paper order panel with non-empty content", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:paper");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(typeof firstEdit.text).toBe("string");
    expect((firstEdit.text ?? "").trim().length).toBeGreaterThan(0);
    expect(firstEdit.text).toContain("模擬下單");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:buy")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:sell")).toBe(true);
  });

  it("renders quote detail from assistant state latestQuote schema", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-quote-state-"));
    try {
      mkdirSync(path.join(stateDir, "ui"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "ui", "auto-trading-assistant-state.json"),
        JSON.stringify(
          {
            mode: "paper",
            summary: {
              quoteFreshnessStatus: "fresh",
            },
            quote: {
              status: "ready",
              diagnostics: {
                latestQuote: {
                  stockNo: "MCL0000",
                  stockName: "微輕原油熱2607",
                  close: "97.85",
                  bid: "97.84",
                  ask: "97.86",
                  qty: "261097",
                  receivedAt: "2026-05-20T00:06:42.1338548+08:00",
                },
              },
            },
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      await triggerCallback(subagent, respond, "tr:quote");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("即時報價");
      expect(firstEdit.text).toContain("MCL0000");
      expect(firstEdit.text).toContain("微輕原油熱2607");
      expect(firstEdit.text).not.toContain("目前沒有報價資料");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("renders chart strategy state from assistant state", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-chart-strategy-state-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-fill-simulation-state-"));
    try {
      mkdirSync(path.join(stateDir, "ui"), { recursive: true });
      mkdirSync(path.join(repoRoot, ".openclaw", "trading"), { recursive: true });
      mkdirSync(path.join(repoRoot, ".openclaw", "quote"), { recursive: true });
      mkdirSync(path.join(repoRoot, "reports", "hermes-agent", "state"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "ui", "auto-trading-assistant-state.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            status: "blocked_quote_stale",
            liveTradingEnabled: false,
            writeTradingEnabled: false,
            brokerOrderPathEnabled: false,
            loop: { status: "blocked_readiness" },
            chartStrategy: {
              status: "ready_waiting_fresh_quote",
              chartData: { ready: true },
              strategyBook: {
                ready: true,
                strategyCount: 17,
                enabledStrategyCount: 17,
              },
              simulation: {
                status: "pass",
                winRate: 0.5,
                paperIntentCount: 57,
                realQuoteVerified: false,
              },
              safety: {
                brokerWriteLocked: true,
              },
            },
            recommendation: {
              nextSafeTask: "等待新的 SKQuoteLib quote callback。",
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json"),
        JSON.stringify(
          {
            status: "stale",
            quoteProof: {
              latestStock: "TX00AM",
              freshnessAgeSeconds: 241,
              maxAllowedFreshAgeSeconds: 2,
            },
            diagnostics: {
              selectedStock: { targetStockNo: "TX00AM" },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(repoRoot, ".openclaw", "quote", "capital-reportable-quote-state.json"),
        JSON.stringify(
          {
            status: "partial_ready",
            summary: {
              reportableCount: 0,
              blockedCount: 57,
              blockedCategoryCounts: { session_closed: 57 },
            },
            blockedQuotes: [
              {
                blockedCategory: "session_closed",
                reason: "closed_session_stale",
                unblockCondition: "market session opens and a fresh matched callback arrives.",
                lastEvent: { receivedAt: "2026-05-24T00:49:59.6034796+08:00" },
              },
            ],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(repoRoot, ".openclaw", "quote", "capital-tick-diagnostic.json"),
        JSON.stringify(
          {
            status: "monitor_fresh_realtime_stale",
            monitorFreshness: { running: true },
            realtimeFreshness: { running: false },
            latestCallback: { receivedAt: "2026-05-24T11:58:17.3393555+08:00" },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(repoRoot, ".openclaw", "trading", "capital-paper-learning-summary.json"),
        JSON.stringify(
          {
            status: "blocked",
            paperEligible: false,
            summary: {
              consecutiveReadinessBlocks: 57,
              latestQuoteAgeSeconds: 241,
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(
          repoRoot,
          "reports",
          "hermes-agent",
          "state",
          "openclaw-capital-full-chain-simulation-gate-latest.json",
        ),
        JSON.stringify(
          {
            status: "blocked",
            summary: {
              stageFailedCount: 1,
              faultFailedCount: 112,
            },
            blockers: ["quote:domestic-and-overseas-fresh", "fault:normal_paper_chain"],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(
          repoRoot,
          "reports",
          "hermes-agent",
          "state",
          "openclaw-capital-live-trading-promotion-gate-latest.json",
        ),
        JSON.stringify(
          {
            status: "blocked",
            readyForManualReview: false,
            blockerCode: "LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED",
            blockers: ["live:full-chain-dryrun-fault-gate-clear"],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(repoRoot, ".openclaw", "trading", "capital-strategy-fill-simulation.json"),
        JSON.stringify(
          {
            status: "historical_simulated",
            recommendation: "hold",
            stats: {
              total_intents: 7,
              filled_count: 6,
              fill_rate: 0.8571,
              win_rate: 0.5,
              expected_value_pts: 98.59,
            },
            monteCarlo: {
              p05_total_pnl_pts: -234.8,
              p50_total_pnl_pts: 522.1,
              p95_total_pnl_pts: 1276.1,
              positive_rate: 0.824,
            },
            safetyLock: {
              paperOnly: true,
              executionEligible: false,
              promotionBlocked: true,
            },
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);
      mocks.callGatewayCompatMock.mockImplementation(async (_api: unknown, method: string) => {
        if (method === "trading.fastOrderAudit.snapshot") {
          return {
            latestReview: {
              status: "paper_execution_recorded",
              decision: "approve_paper",
            },
            latestPaperExecution: {
              recorded: true,
              paperOnly: true,
              sentBrokerOrder: false,
              brokerCommandEnabled: false,
            },
            history: {
              entries: [
                { kind: "paper", status: "paper_execution_recorded" },
                { kind: "review", decision: "deny", status: "denied" },
              ],
            },
          };
        }
        return null;
      });

      await triggerCallback(subagent, respond, "tr:strat");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("圖表策略");
      expect(firstEdit.text).toContain("ready_waiting_fresh_quote");
      expect(firstEdit.text).toContain("策略: 17/17 已啟用");
      expect(firstEdit.text).toContain("勝率 50.0%");
      expect(firstEdit.text).toContain("實單允許: ❌");
      expect(firstEdit.text).toContain("Broker 寫入鎖: ✅");
      expect(firstEdit.text).toContain("真報價驗證: ❌");
      expect(firstEdit.text).toContain("成交模擬");
      expect(firstEdit.text).toContain("期望值: 98.59 pts");
      expect(firstEdit.text).toContain("成交率 85.7%");
      expect(firstEdit.text).toContain("蒙地卡羅 p05/p50/p95: -234.8/522.1/1276.1 pts");
      expect(firstEdit.text).toContain("僅模擬: ✅");
      expect(firstEdit.text).toContain("升級阻擋: ✅");
      expect(firstEdit.text).toContain("即時阻擋");
      expect(firstEdit.text).toContain("報價: <code>stale</code> TX00AM 時效 241/2s");
      expect(firstEdit.text).toContain("可報價: 0 / 阻擋 57");
      expect(firstEdit.text).toContain("session_closed");
      expect(firstEdit.text).toContain("closed_session_stale");
      expect(firstEdit.text).toContain("學習: <code>blocked</code> 模擬 ❌");
      expect(firstEdit.text).toContain("全鏈路: <code>blocked</code> 階段/故障 1/112");
      expect(firstEdit.text).toContain("LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED");
      expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
        expect.anything(),
        "trading.fastOrderAudit.snapshot",
        { filter: "all", offset: 0, limit: 5 },
      );
      expect(firstEdit.text).toContain("快速進出場模擬模式");
      expect(firstEdit.text).toContain("學習模式: 成功=1 失敗=1");
      expect(firstEdit.text).toContain("mixed-paper-pattern");
      expect(firstEdit.text).toContain("brokerCommandEnabled=❌ sentBrokerOrder=❌");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders AI trading platform snapshot from gateway without dispatching a subagent task", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock
      .mockResolvedValueOnce({
        ts: 1_779_611_200_000,
        mode: "paper_only",
        safety: {
          liveTradingEnabled: false,
          paidProviderEnabled: false,
          writesEnabled: false,
          highRiskEnabled: false,
        },
        runtime: { totalFeeds: 2, connectedFeeds: 1, runningFeeds: 1 },
        platform: {
          status: "waiting_market",
          title: "AI trading platform waiting for fresh market quotes",
          providers: [
            {
              id: "capital",
              label: "Capital",
              status: "blocked",
              ready: false,
              blockerCount: 1,
              blockers: ["quote:domestic-and-overseas-fresh"],
              summary: "Capital full-chain blocked: stage=1, fault=0.",
            },
            {
              id: "okx",
              label: "OKX",
              status: "read_only_demo_verified_live_blocked",
              ready: false,
              blockerCount: 1,
              blockers: ["order_not_enabled"],
              summary: "OKX demo=demo_ok；live=live_401",
            },
          ],
          strategy: {
            status: "ready_waiting_fresh_quote",
            symbol: "TX00",
            quoteSymbol: "TX00AM",
            signalsGenerated: 57,
            intentsReady: 7,
            fillStatus: "historical_simulated",
            fillRecommendation: "hold",
            aiBrainReady: true,
            aiModuleCount: 6,
          },
          fastOrderTicket: {
            provider: "capital",
            mode: "gated_live_ticket",
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            entry: "market",
            exit: "SL=420 TP=440",
            brokerApi: "SendFutureOrder",
            executionAllowed: false,
            liveOrderAllowed: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
            blockerCount: 2,
            blockers: ["quote:domestic-and-overseas-fresh", "ui-high-risk-actions-locked"],
            nextCommand: "capital-hft:capital:full-chain",
          },
        },
      })
      .mockResolvedValueOnce({
        latestReview: {
          status: "paper_execution_recorded",
          decision: "approve_paper",
        },
        latestPaperExecution: {
          recorded: true,
          paperOnly: true,
          symbol: "TX00",
          side: "buy",
          quantity: 1,
        },
        history: {
          entries: [
            {
              kind: "paper_execution",
              status: "paper_execution_recorded",
              decision: "approve_paper",
            },
            { kind: "review", status: "denied", decision: "deny" },
          ],
        },
      });

    await triggerCallback(subagent, respond, "tr:platform");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(expect.anything(), "trading.snapshot");
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
      expect.anything(),
      "trading.fastOrderAudit.snapshot",
      { filter: "all", offset: 0, limit: 5 },
    );
    expect(firstEdit.text).toContain("AI 交易平台");
    expect(firstEdit.text).toContain("狀態: <code>等待市場報價</code>");
    expect(firstEdit.text).toContain("Capital");
    expect(firstEdit.text).toContain("OKX");
    expect(firstEdit.text).toContain("快速進出場學習");
    expect(firstEdit.text).toContain("學習模式: 成功=1 失敗=1");
    expect(firstEdit.text).toContain("快速進出場票");
    expect(firstEdit.text).toContain("可執行=❌ 允許實單=❌");
    expect(firstEdit.text).toContain("券商指令可用=❌ 送單指令=(空白)");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:platform")).toBe(
      true,
    );
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:paperloop")).toBe(
      true,
    );
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:live")).toBe(true);
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("writes fast order intent through gateway and renders broker-locked evidence", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce({
      schema: "openclaw.trading.fast-order-intent.v1",
      generatedAt: "2026-05-24T07:00:00.000Z",
      status: "written_broker_locked",
      intentId: "20260524070000000-capital-TX00-buy",
      source: "telegram.ai-platform",
      mode: "paper_only",
      ticket: {
        provider: "capital",
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        entry: "limit@40510",
        exit: "SL=40300 TP=40800",
        brokerApi: "SendFutureOrder",
        executionAllowed: false,
        liveOrderAllowed: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
        blockers: ["broker-command-disabled"],
      },
      blockers: ["broker-command-disabled", "telegram-manual-review-required"],
      brokerCommandEnabled: false,
      submissionCommand: "",
      sentBrokerOrder: false,
      writeTargets: {
        jsonl: ".openclaw/trading/telegram-fast-order-intents.jsonl",
        latestReport: "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
      },
      nextSafeTask: "人工審核此 OpenClaw intent。",
    });

    await triggerCallback(subagent, respond, "tr:write");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
      expect.anything(),
      "trading.fastOrderIntent.write",
    );
    expect(firstEdit.text).toContain("快速進出場審核票已寫入");
    expect(firstEdit.text).toContain("written_broker_locked");
    expect(firstEdit.text).toContain("brokerCommandEnabled=❌");
    expect(firstEdit.text).toContain("submissionCommand=(empty)");
    expect(firstEdit.text).toContain("sentBrokerOrder=❌");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:write")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:approve")).toBe(
      true,
    );
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:deny")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:platform")).toBe(
      true,
    );
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("approves fast order intent as paper execution through gateway only", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce({
      schema: "openclaw.trading.fast-order-review.v1",
      generatedAt: "2026-05-24T07:01:00.000Z",
      status: "paper_execution_recorded",
      decision: "approve_paper",
      intentId: "20260524070000000-capital-TX00-buy",
      ticket: {
        provider: "capital",
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        entry: "limit@40510",
        exit: "SL=40300 TP=40800",
        brokerApi: "SendFutureOrder",
        brokerCommandEnabled: false,
        submissionCommand: "",
      },
      paperExecution: {
        recorded: true,
        paperOnly: true,
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        entry: "limit@40510",
        exit: "SL=40300 TP=40800",
        brokerApi: "SendFutureOrder",
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
      },
      audit: {
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
        blockers: ["broker-command-disabled"],
        reason: "Telegram approve 只登錄 paper execution audit；broker write path remains locked.",
      },
      writeTargets: {
        latestReview: "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
        latestPaperExecution:
          "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json",
      },
      nextSafeTask: "檢查 paper execution audit。",
    });

    await triggerCallback(subagent, respond, "tr:approve");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
      expect.anything(),
      "trading.fastOrderIntent.approvePaper",
    );
    expect(firstEdit.text).toContain("已收到操作：核准模擬執行");
    expect(firstEdit.text).toContain("回執時間");
    expect(firstEdit.text).toContain("paper_execution_recorded");
    expect(firstEdit.text).toContain("approve_paper");
    expect(firstEdit.text).toContain("paperOnly=✅");
    expect(firstEdit.text).toContain("sentBrokerOrder=❌");
    expect(firstEdit.text).toContain("brokerCommandEnabled=❌");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:write")).toBe(true);
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("guides write-before-approve when approve response is still blocked by manual review", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce({
      schema: "openclaw.trading.fast-order-review.v1",
      generatedAt: "2026-05-25T10:01:00.000Z",
      status: "pending_manual_review",
      decision: "approve_paper",
      intentId: "20260525100000000-capital-TX00-buy",
      audit: {
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
        blockers: ["telegram-manual-review-required"],
        reason: "manual review gate is still active",
      },
      nextSafeTask: "先按寫入審核票再核准。",
    });

    await triggerCallback(subagent, respond, "tr:approve");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("核准前檢查未通過");
    expect(firstEdit.text).toContain("先按「✍️ 寫入審核票」");
    expect(firstEdit.text).toContain("pending_manual_review");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:write")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:audit")).toBe(true);
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("denies fast order intent through gateway without paper execution", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce({
      schema: "openclaw.trading.fast-order-review.v1",
      generatedAt: "2026-05-24T07:02:00.000Z",
      status: "denied",
      decision: "deny",
      intentId: "20260524070000000-capital-TX00-buy",
      audit: {
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
        blockers: ["broker-command-disabled"],
        reason: "Telegram deny recorded; no paper execution and no broker order.",
      },
      writeTargets: {
        latestReview: "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
      },
      nextSafeTask: "保留 deny audit；需要交易時重新寫入新的審核票。",
    });

    await triggerCallback(subagent, respond, "tr:deny");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
      expect.anything(),
      "trading.fastOrderIntent.deny",
    );
    expect(firstEdit.text).toContain("已收到操作：拒絕審核票");
    expect(firstEdit.text).toContain("回執時間");
    expect(firstEdit.text).toContain("denied");
    expect(firstEdit.text).toContain("deny");
    expect(firstEdit.text).toContain("sentBrokerOrder=❌");
    expect(firstEdit.text).toContain("brokerCommandEnabled=❌");
    expect(firstEdit.text).not.toContain("paperOnly=✅");
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("renders fast order audit snapshot from gateway without dispatching a subagent", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce({
      schema: "openclaw.trading.fast-order-audit-snapshot.v1",
      generatedAt: "2026-05-24T07:03:00.000Z",
      status: "loaded",
      safety: {
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
      },
      latestIntent: {
        status: "written_broker_locked",
        intentId: "20260524070000000-capital-TX00-buy",
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        blockers: ["broker-command-disabled"],
        ticket: {
          provider: "capital",
          symbol: "TX00",
          side: "buy",
          quantity: 1,
        },
      },
      latestReview: {
        status: "paper_execution_recorded",
        decision: "approve_paper",
        intentId: "20260524070000000-capital-TX00-buy",
        audit: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
          blockers: ["broker-command-disabled"],
          reason:
            "Telegram approve 只登錄 paper execution audit；broker write path remains locked.",
        },
      },
      latestPaperExecution: {
        recorded: true,
        paperOnly: true,
        symbol: "TX00",
        side: "buy",
        quantity: 1,
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
      },
      readTargets: {
        latestIntent: "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
        latestReview: "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
        latestPaperExecution:
          "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json",
        reviewsJsonl: ".openclaw/trading/telegram-fast-order-review-decisions.jsonl",
      },
      history: {
        filter: "paper",
        offset: 5,
        limit: 5,
        total: 7,
        returned: 2,
        hasPrevious: true,
        hasNext: false,
        entries: [
          {
            kind: "paper_execution",
            generatedAt: "2026-05-24T07:01:00.000Z",
            intentId: "20260524070000000-capital-TX00-buy",
            status: "paper_execution_recorded",
            decision: "approve_paper",
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          },
        ],
      },
      nextSafeTask: "依最新審核紀錄決定是否重新寫入審核票。",
    });

    await triggerCallback(subagent, respond, "tr:audit:paper_5");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
      expect.anything(),
      "trading.fastOrderAudit.snapshot",
      { filter: "paper", offset: 5, limit: 5 },
    );
    expect(firstEdit.text).toContain("快速進出場審核紀錄");
    expect(firstEdit.text).toContain("written_broker_locked");
    expect(firstEdit.text).toContain("paper_execution_recorded");
    expect(firstEdit.text).toContain("paperOnly=✅");
    expect(firstEdit.text).toContain("sentBrokerOrder=❌");
    expect(firstEdit.text).toContain("brokerCommandEnabled=❌");
    expect(firstEdit.text).toContain("filter=<code>paper</code>");
    expect(firstEdit.text).toContain("paper_execution");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:audit")).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:paperloop")).toBe(
      true,
    );
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:audit:all_0")).toBe(
      true,
    );
    expect(
      firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:audit:paper_10"),
    ).toBe(true);
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:write")).toBe(true);
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("runs fast order paper loop through write, approve, then audit only", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockImplementation(async (_api: unknown, method: string) => {
      if (method === "trading.fastOrderIntent.write") {
        return {
          schema: "openclaw.trading.fast-order-intent.v1",
          generatedAt: "2026-05-24T07:04:00.000Z",
          status: "written_broker_locked",
          intentId: "20260524070400000-capital-TX00-buy",
          source: "telegram.ai-platform",
          mode: "paper_only",
          ticket: {
            provider: "capital",
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            brokerCommandEnabled: false,
            submissionCommand: "",
          },
          brokerCommandEnabled: false,
          submissionCommand: "",
          sentBrokerOrder: false,
        };
      }
      if (method === "trading.fastOrderIntent.approvePaper") {
        return {
          schema: "openclaw.trading.fast-order-review.v1",
          generatedAt: "2026-05-24T07:04:01.000Z",
          status: "paper_execution_recorded",
          decision: "approve_paper",
          intentId: "20260524070400000-capital-TX00-buy",
          audit: {
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
            blockers: ["broker-command-disabled"],
          },
          paperExecution: {
            recorded: true,
            paperOnly: true,
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          },
        };
      }
      if (method === "trading.fastOrderLearningSnapshot.refresh") {
        return {
          status: "refreshed",
          assistantFastOrderPaperPattern: "paper-success",
          brokerCommandEnabled: false,
          sentBrokerOrder: false,
          submissionCommand: "",
          snapshotPath: ".openclaw/ui/auto-trading-learning-snapshot.json",
        };
      }
      if (method === "trading.fastOrderAudit.snapshot") {
        return {
          schema: "openclaw.trading.fast-order-audit-snapshot.v1",
          generatedAt: "2026-05-24T07:04:02.000Z",
          status: "loaded",
          safety: {
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
          },
          latestIntent: {
            status: "written_broker_locked",
            intentId: "20260524070400000-capital-TX00-buy",
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
            blockers: ["broker-command-disabled"],
            ticket: {
              provider: "capital",
              symbol: "TX00",
              side: "buy",
              quantity: 1,
            },
          },
          latestReview: {
            status: "paper_execution_recorded",
            decision: "approve_paper",
            intentId: "20260524070400000-capital-TX00-buy",
            audit: {
              sentBrokerOrder: false,
              brokerCommandEnabled: false,
              submissionCommand: "",
              blockers: ["broker-command-disabled"],
            },
          },
          latestPaperExecution: {
            recorded: true,
            paperOnly: true,
            symbol: "TX00",
            side: "buy",
            quantity: 1,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          },
          history: {
            filter: "all",
            offset: 0,
            limit: 5,
            total: 1,
            returned: 1,
            entries: [
              {
                kind: "paper_execution",
                generatedAt: "2026-05-24T07:04:01.000Z",
                intentId: "20260524070400000-capital-TX00-buy",
                status: "paper_execution_recorded",
                decision: "approve_paper",
                symbol: "TX00",
                side: "buy",
                quantity: 1,
                sentBrokerOrder: false,
                brokerCommandEnabled: false,
              },
            ],
          },
          readTargets: {
            latestIntent:
              "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
            latestReview:
              "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
            latestPaperExecution:
              "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json",
            reviewsJsonl: ".openclaw/trading/telegram-fast-order-review-decisions.jsonl",
          },
        };
      }
      return null;
    });

    await triggerCallback(subagent, respond, "tr:paperloop");

    const methods = mocks.callGatewayCompatMock.mock.calls.map((call) => call[1]);
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(methods).toEqual([
      "trading.fastOrderIntent.write",
      "trading.fastOrderIntent.approvePaper",
      "trading.fastOrderLearningSnapshot.refresh",
      "trading.fastOrderAudit.snapshot",
    ]);
    expect(mocks.callGatewayCompatMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "trading.fastOrderAudit.snapshot",
      { filter: "all", offset: 0, limit: 5 },
    );
    expect(firstEdit.text).toContain("快速進出場審核紀錄");
    expect(firstEdit.text).toContain("paper_execution_recorded");
    expect(firstEdit.text).toContain("paperOnly=✅");
    expect(firstEdit.text).toContain("學習快照");
    expect(firstEdit.text).toContain("status=<code>refreshed</code>");
    expect(firstEdit.text).toContain("pattern=<code>paper-success</code>");
    expect(firstEdit.text).toContain("brokerCommandEnabled=❌");
    expect(firstEdit.text).toContain("sentBrokerOrder=❌");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:paperloop")).toBe(
      true,
    );
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("stops fast order paper loop when write fails", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce(null);

    await triggerCallback(subagent, respond, "tr:paperloop");

    const methods = mocks.callGatewayCompatMock.mock.calls.map((call) => call[1]);
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(methods).toEqual(["trading.fastOrderIntent.write"]);
    expect(firstEdit.text).toContain("寫入失敗");
    expect(firstEdit.text).toContain("sentBrokerOrder=❌");
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("renders Capital paper assistant state without dispatching a subagent task", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-paper-assistant-state-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-assistant-shortcuts-report-"));
    try {
      mkdirSync(path.join(stateDir, "ui"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "ui", "capital-paper-assistant-state.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-24T05:13:43.406Z",
            status: "blocked_quote_stale",
            ready: false,
            readOnlyQuoteOnly: true,
            loginAttempted: false,
            liveTradingEnabled: false,
            writeTradingEnabled: false,
            brokerOrderPathEnabled: false,
            badge: { label: "報價過期 STALE" },
            assistant: {
              name: "類高頻自動交易助手",
              operatorAction: "等待新的 SKQuoteLib quote callback；不要登入。",
            },
            execution: {
              paperIntentCreated: false,
              entry: { side: "buy", action: "wait_for_fresh_quote", ready: false, price: 424.36 },
              exit: { side: "sell", action: "wait_for_fresh_quote", ready: false, price: 424.42 },
            },
            quote: {
              status: "stale",
              freshnessStatus: "stale",
              freshnessAgeSeconds: 88,
              latestStock: "TX00AM",
              diagnostics: { blockers: ["freshness_stale"] },
            },
            chartStrategy: {
              status: "ready_waiting_fresh_quote",
              chartData: { ready: true },
              strategyBook: { ready: true, strategyCount: 17, enabledStrategyCount: 17 },
              simulation: { status: "pass", paperIntentCount: 57, realQuoteVerified: false },
              safety: { brokerWriteLocked: true, liveOrderAllowed: false },
            },
            flowDecision: {
              decisionCode: "wait_for_quote_callback",
              action: "wait_for_fresh_quote",
              readyForPaperCycle: false,
              liveOrderAllowed: false,
              gates: [
                { id: "quote_freshness", status: "blocked" },
                { id: "chart_strategy", status: "pass" },
                { id: "strategy_learning", status: "blocked" },
                { id: "pre_trade_risk_gate", status: "pass" },
                { id: "live_promotion", status: "blocked" },
              ],
            },
            loop: { status: "blocked_readiness" },
            learning: { status: "blocked", paperEligible: false, liveEligible: false },
            fastOrderPaperPattern: {
              pattern: "paper-success",
              successCount: 2,
              failureCount: 0,
              latestStatus: "paper_execution_recorded",
            },
            promotion: { status: "passed" },
            cron: { status: "passed" },
            tick: { status: "monitor_fresh_realtime_stale" },
            recommendation: { nextSafeTask: "等待 CapitalHftService 寫入更新的 quote event。" },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(stateDir, "ui", "auto-trading-watch-state.json"),
        JSON.stringify(
          {
            schema: "openclaw.capital.auto-trading-watch-state.v1",
            telegramPaperLoopLearningRefresh: {
              status: "refreshed",
              assistantFastOrderPaperPattern: "paper-success",
              brokerCommandEnabled: false,
              sentBrokerOrder: false,
              submissionCommand: "",
              snapshotPath: ".openclaw/ui/auto-trading-learning-snapshot.json",
            },
          },
          null,
          2,
        ),
      );
      writeShortcutGateReportFixture(repoRoot);
      writeCapitalHighConfidencePaperRerunReportFixture(repoRoot);
      writeCapitalStrategyPlatformReportFixture(repoRoot);
      writeOkxHeartbeatOperationReportFixture(repoRoot);
      writeOkxRefreshWorkflowReportFixture(repoRoot);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:assist");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("類高頻自動交易助手");
      expect(firstEdit.text).toContain("blocked_quote_stale");
      expect(firstEdit.text).toContain("wait_for_quote_callback");
      expect(firstEdit.text).toContain("pre_trade_risk_gate");
      expect(firstEdit.text).toContain("Broker 寫入鎖=✅");
      expect(firstEdit.text).toContain("快速狀態");
      expect(firstEdit.text).toContain(
        "學習=<code>blocked</code> 審核=<code>paper_execution_recorded/paper-success 2-0</code> 閉環=<code>refreshed</code> 快捷=<code>pass/145/0</code>",
      );
      expect(firstEdit.text).toContain(
        "okxCurrentReadinessHeartbeatOperationClosure=<code>okxCurrentReadinessHeartbeat=idle current=ready refresh=not_needed telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true</code>",
      );
      expect(firstEdit.text).toContain(
        "okxRefreshWorkflow=<code>okxCurrentReadinessRefresh=pass steps=7/7 freshness=ok schedulerNextRunAt=2026-05-24T20:15:00.000Z noOrderWrite=true</code>",
      );
      expect(firstEdit.text).toContain(
        "okxRefreshSteps=<code>7/7</code> failedSteps=無 latestRefreshRun=<code>skipped_not_needed/null</code> noOrderWrite=✅",
      );
      expect(firstEdit.text).toContain(
        "okxHeartbeatNext=<code>OKX current-readiness 已 ready；維持 heartbeat 監看，必要時從 sc:tr:okxrefresh 觸發安全刷新。</code>",
      );
      expect(firstEdit.text).toContain(
        "okxHeartbeatRefresh=<code>sc:tr:okxrefresh / pnpm okx:current-readiness:refresh</code> oneClick=✅ executeRequired=❌ noOrderWrite=✅",
      );
      expect(firstEdit.text).toContain(
        "okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>",
      );
      expect(firstEdit.text).toContain(
        "fixture=<code>pass</code> targets=callback-router.test.ts / trading-panel.test.ts",
      );
      expect(firstEdit.text).toContain(
        "重跑=<code>blocked_quote_stale/ready_waiting_fresh_quote/pass</code> 更新=<code>2026-05-24T05:13:43.406Z</code>",
      );
      expect(firstEdit.text).toContain("Telegram 模擬閉環");
      expect(firstEdit.text).toContain("status=<code>refreshed</code>");
      expect(firstEdit.text).toContain("pattern=<code>paper-success</code>");
      expect(firstEdit.text).toContain(".openclaw/ui/auto-trading-learning-snapshot.json");
      expect(firstEdit.text).toContain("nextSafeCommand=<code>sc:tr:learn / sc:tr:audit</code>");
      expect(firstEdit.text).toContain(
        "learningHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      );
      expect(firstEdit.text).toContain(
        "capitalHighConfidence=<code>highConfidencePaperRerun=high_confidence_rerun_completed_still_blocked;threshold=0.6;requiredConfidence=1.306666;candidates=CD0000|YM0000|ES0000|GC0000|NQ0000;pass=0;blocked=5;noOrderWrite=true</code>",
      );
      expect(firstEdit.text).toContain(
        "capitalPosition=<code>capitalVerifiedPositionSnapshot=stale_operator_refresh_required;decision=verified_flat_no_exit_required;freshness=stale;age=44623;maxFresh=43200;hasOpenPosition=false;net=0;path=D:\\OpenClaw\\config\\capital-verified-position-snapshot.json;next=operator_refresh_snapshot_then_pnpm_capital_trade_direct_status_check;noOrderWrite=true</code>",
      );
      expect(firstEdit.text).toContain("positionFreshness=<code>stale</code>");
      expect(firstEdit.text).toContain(
        "requiredConfidenceStatus=<code>impossible_under_current_signal_model</code>",
      );
      expect(firstEdit.text).toContain("gateVerified=✅");
      expect(firstEdit.text).toContain("verified=sc:tr:assist / sc:tr:audit / sc:tr:paperloop");
      expect(firstEdit.text).toContain(
        "nextCommandShortRow=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> gateVerified=✅ buttons=<code>sc:tr:learn / sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      );
      expect(firstEdit.text).toContain(
        "gateHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> note=下一步指令已由 gate 驗證 brokerLocked=✅",
      );
      expect(firstEdit.text).toContain("新的 fresh quote 後才重跑 sc:tr:paperloop");
      expect(firstEdit.text).toContain("brokerLocked=✅");
      const callbacks = firstEdit.buttons?.flat().map((btn) => btn.callback_data) ?? [];
      expect(callbacks).toContain("sc:tr:assist");
      expect(callbacks).toContain("sc:tr:rerun");
      expect(callbacks).toContain("sc:tr:learn");
      expect(callbacks).toContain("sc:tr:audit");
      expect(callbacks).toContain("sc:tr:paperloop");
      expect(subagent.run).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders OKX refresh workflow failed steps from reports in paper assistant panel", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-assistant-okx-refresh-fail-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-shortcuts-okx-refresh-fail-"));
    try {
      mkdirSync(path.join(stateDir, "ui"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "ui", "auto-trading-assistant-state.json"),
        JSON.stringify(
          {
            status: "blocked_quote_stale",
            flowDecision: {
              decisionCode: "wait_for_quote_callback",
              action: "wait_for_fresh_quote",
            },
            recommendation: { nextSafeTask: "等待 fresh quote 後再重跑。" },
          },
          null,
          2,
        ),
      );
      writeShortcutGateReportFixture(repoRoot);
      writeOkxHeartbeatOperationReportFixture(repoRoot, { status: "fail", exitCode: 1 });
      writeOkxRefreshWorkflowReportFixture(repoRoot, [
        "telegram_shortcuts",
        "current_readiness_summary",
      ]);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:assist");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain(
        "okxRefreshWorkflow=<code>okxCurrentReadinessRefresh=fail steps=5/7 freshness=stale schedulerNextRunAt=2026-05-24T20:15:00.000Z noOrderWrite=true</code>",
      );
      expect(firstEdit.text).toContain(
        "okxRefreshSteps=<code>5/7</code> failedSteps=telegram_shortcuts / current_readiness_summary latestRefreshRun=<code>fail/1</code> noOrderWrite=✅",
      );
      expect(subagent.run).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("pushes rerun completion back to the paper assistant panel", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "重跑完成：state/report 已更新");

    await triggerCallback(subagent, respond, "tr:rerun");

    await vi.waitFor(() => {
      expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
    });

    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain("sc:tr:assist 快速狀態列");

    const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(pushed.text).toContain("重跑交易檢查");
    expect(pushed.text).toContain("重跑完成");
    const callbacks = pushed.buttons?.flat().map((btn) => btn.callback_data) ?? [];
    expect(callbacks).toContain("sc:tr:rerun");
    expect(callbacks).toContain("sc:tr:assist");
  });

  it("pushes OKX refresh completion with heartbeat next-action context", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "OKX refresh done");
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-okx-heartbeat-op-"));

    try {
      writeOkxHeartbeatOperationReportFixture(repoRoot);
      writeControlledRunnerTelegramPublishReportFixture(repoRoot);
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:okxrefresh");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("OKX heartbeat next-action");
      expect(firstEdit.text).toContain(
        "okxHeartbeatNext=<code>OKX current-readiness 已 ready；維持 heartbeat 監看，必要時從 sc:tr:okxrefresh 觸發安全刷新。</code>",
      );

      await vi.waitFor(() => {
        expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
      });

      const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
      expect(runArg.message).toContain("pnpm okx:current-readiness:refresh");
      expect(runArg.message).toContain("不得查私有訂單");
      expect(runArg.message).toContain("不得送單");

      const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(pushed.text).toContain("OKX current-readiness 刷新");
      expect(pushed.text).toContain("OKX refresh done");
      expect(pushed.text).toContain("OKX heartbeat next-action");
      expect(pushed.text).toContain(
        "okxHeartbeatRefresh=<code>sc:tr:okxrefresh / pnpm okx:current-readiness:refresh</code> oneClick=✅ executeRequired=❌ noOrderWrite=✅",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatInventory=<code>ready / okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true</code> ready=✅ noOrderWrite=✅",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatPublishBridge=<code>publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1</code> ready=✅ upstreamNoOrderWriteVerified=✅ upstreamOkxContractVerified=✅ upstreamDmadGateVerified=✅ noOrderWriteCount=<code>4</code> executeRequiredCount=<code>1</code> okxContractCount=<code>1</code> dmadGateCount=<code>1</code>",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatTokenCounts=<code>messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1</code> noOrderWrite=✅",
      );
      const callbacks = pushed.buttons?.flat().map((btn) => btn.callback_data) ?? [];
      expect(callbacks).toContain("sc:tr:okxrefresh");
      expect(callbacks).toContain("sc:tr:okx");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("pushes OKX refresh_available heartbeat next-action context", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "OKX refresh available");
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-okx-heartbeat-refresh-available-"));

    try {
      writeOkxHeartbeatOperationReportFixture(repoRoot, null, {
        status: "refresh_available_read_only",
      });
      writeControlledRunnerTelegramPublishReportFixture(repoRoot);
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:okxrefresh");

      await vi.waitFor(() => {
        expect(mocks.pushMessageMock).toHaveBeenCalledTimes(1);
      });

      const pushed = mocks.pushMessageMock.mock.calls[0]?.[1] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(pushed.text).toContain("OKX current-readiness 刷新");
      expect(pushed.text).toContain("OKX refresh available");
      expect(pushed.text).toContain("OKX heartbeat next-action");
      expect(pushed.text).toContain(
        "okxHeartbeatNext=<code>OKX current-readiness 偵測 stale/blocker；使用 sc:tr:okxrefresh 執行安全刷新。</code>",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatRefresh=<code>sc:tr:okxrefresh / pnpm okx:current-readiness:refresh</code> oneClick=✅ executeRequired=✅ noOrderWrite=✅",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatSchedulerNextRunAt=<code>2026-05-24T20:15:00.000Z</code>",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatInventory=<code>ready / okxInventoryProbe=pass publishProbes=16/16 summary=telegram+controlled noOrderWrite=true</code> ready=✅ noOrderWrite=✅",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatPublishBridge=<code>publishBridge=pass upstreamNoOrderWriteVerified=true upstreamNoOrderWriteCount=4 upstreamExecuteRequiredCount=1 upstreamOkxContractVerified=true upstreamOkxContractCount=1 upstreamDmadGateVerified=true upstreamDmadGateCount=1 noOrderWrite=true=4 本地執行器=1 OKX合約=1 DMAD=1</code> ready=✅ upstreamNoOrderWriteVerified=✅ upstreamOkxContractVerified=✅ upstreamDmadGateVerified=✅ noOrderWriteCount=<code>4</code> executeRequiredCount=<code>1</code> okxContractCount=<code>1</code> dmadGateCount=<code>1</code>",
      );
      expect(pushed.text).toContain(
        "okxHeartbeatTokenCounts=<code>messageTokenCounts 快捷檢查=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 executeRequired=1 noOrderWrite=true=4 OKX合約=1 下一步指令=1 DMAD=1</code> noOrderWrite=✅",
      );
      const callbacks = pushed.buttons?.flat().map((btn) => btn.callback_data) ?? [];
      expect(callbacks).toContain("sc:tr:okxrefresh");
      expect(callbacks).toContain("sc:tr:okx");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders OKX gate status from OpenClaw report", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-okx-report-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(reportDir, "openclaw-okx-api-status-gate-latest.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-24T02:12:26.974Z",
            status: "read_only_demo_verified_live_blocked",
            summary_zh_tw: "OKX demo=demo_ok；live=live_401",
            blockers: ["order_not_enabled"],
            markers: ["demo_ok", "live_401", "quote_ok"],
            quote: { code: "quote_ok", instId: "BTC-USDT", last: "76894" },
            authentication: {
              demo: { profile: "demo", code: "demo_ok" },
              live: { profile: "main", code: "live_401" },
            },
            safety: {
              orderPlacementEnabled: false,
              liveTradingEnabled: false,
              readOnlyCommandsOnly: true,
              submittedOrder: false,
              writeTradingEnabled: false,
            },
            config: {
              localConfigExists: true,
              configMaskedOnly: true,
              profileFields: {
                main: { apiKeyPresent: true, secretKeyPresent: true, passphrasePresent: true },
                demo: { apiKeyPresent: true, secretKeyPresent: true, passphrasePresent: true },
              },
            },
            credentialPolicy: {
              chatProvidedCredentialAction: "reject_and_rotate",
              allowedPermissionSetBeforePromotion: ["read"],
              blockedPermissionSetBeforePromotion: ["trade", "withdraw"],
              ipAllowlistRequiredForTradeOrWithdraw: true,
              keyPostedInChatMustBeRevoked: true,
            },
            agentTradeKit: {
              mcpCompatible: true,
              cliCompatible: true,
              requiredProfileForAuthenticatedCommands: true,
              demoProfile: "demo",
            },
            nextSafeTask: "Demo 模式已就緒。",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:okx");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("OKX API 狀態");
      expect(firstEdit.text).toContain("唯讀模擬已驗證且實盤阻擋");
      expect(firstEdit.text).toContain("demo_ok");
      expect(firstEdit.text).toContain("live_401");
      expect(firstEdit.text).toContain("BTC-USDT");
      expect(firstEdit.text).toContain("Key / 權限");
      expect(firstEdit.text).toContain("reject_and_rotate");
      expect(firstEdit.text).toContain("交易/提領需 IP 白名單: ✅");
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:okx")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders Capital service status from OpenClaw report", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-capital-report-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(reportDir, "openclaw-capital-service-status-latest.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-23T05:21:16.618Z",
            status: "blocked_or_degraded",
            ready: false,
            blockerCode: "capital_watchdog_not_ready",
            failedSteps: ["watchdog_ready"],
            capitalRoot: "D:\\群益及元大API\\CapitalHftService",
            readOnly: true,
            loginAttempted: false,
            service: {
              status: "http",
              pid: 44228,
              ready: true,
              livenessStatus: "alive",
              loginStatus: "connected",
              quoteMonitorConnected: true,
              orderInitialized: true,
            },
            quote: {
              ready: true,
              status: "fresh",
              freshnessAgeSeconds: 60,
              callbackReportableCount: 2,
              callbackFreshMatchedCount: 2,
            },
            positionQuery: { ready: true, accountCount: 2 },
            paperTrading: { ready: true },
            liveOrders: { ready: false, reason: "allowLiveTrading_false" },
            watchdog: { ready: false, blockerCode: "market_session_closed" },
            orderMode: { ready: true, status: "pass" },
            safety: {
              sentOrder: false,
              allowLiveTrading: false,
              writeBrokerOrders: false,
              realOrderAllowed: false,
            },
            telegramPoller: { summary: "send-only:openclaw_gateway" },
            nextSafeTask: "先修復 watchdog。",
            replyLine: "[OpenClaw Capital 狀態] 報價=READY｜真單=封鎖",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:cap");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("群益 API 狀態");
      expect(firstEdit.text).toContain("阻擋或降級");
      expect(firstEdit.text).toContain("群益監看未就緒");
      expect(firstEdit.text).toContain("禁止實盤交易");
      expect(firstEdit.text).toContain("已送單=❌");
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:cap")).toBe(true);
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:disp")).toBe(
        true,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders Capital direct operation gate from OpenClaw reports", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-capital-direct-report-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(reportDir, "openclaw-capital-direct-operation-status-latest.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-25T00:11:00.051Z",
            status: "blocked",
            summary: {
              quote: {
                serviceStatus: "blocked_or_degraded",
                domesticTxFreshness: "session_closed",
                a50Status: "stale",
                a50Subscribed: true,
                a50AgeSeconds: 999,
              },
              requestedTrade: {
                instrument: "A50 202605",
                quoteSymbol: "CN0000",
                holdingMode: "day_trade",
                status: "blocked_a50_stale",
              },
              position: {
                decisionStatus: "blocked_no_verified_position_snapshot",
                usable: false,
                path: "config/capital-verified-position-snapshot.json",
                verifiedAt: "2026-05-25T00:34:10.000Z",
                verifiedBy: "telegram-owner",
                verifiedAgeSeconds: 120,
                maxFreshSeconds: 43200,
                freshnessStatus: "fresh",
              },
              externalBrokerAdapter: {
                ackStatus: "missing",
                ackUsable: false,
                ackPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
                applyReceipt: {
                  required: true,
                  reportRead: true,
                  status: "pending_operator_apply",
                  verified: false,
                  operatorMayApply: true,
                  operatorApplyVerified: false,
                  action: "operator_apply_required",
                  owner: "operator-owned-broker-adapter-only",
                  activeState: "pre_apply_current_matches",
                  sourcePath:
                    ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
                  destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
                  validationCommand:
                    "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
                  postApplyClosureCommand:
                    "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
                  noLiveOrderSent: true,
                  sentOrder: false,
                  writeBrokerOrders: false,
                  liveTradingEnabled: false,
                  machineLine:
                    "capitalAdapterAckApplyReceipt=pending_operator_apply sha256=ABC123 operatorMayApply=true operatorApplyVerified=false noLiveOrderSent=true sentOrder=false noOrderWrite=true blockers=1",
                  blockers: ["operator-apply:pending"],
                  nextSafeTask:
                    "operator-owned adapter must apply staged-current ack, then rerun apply receipt check.",
                },
              },
              sealedOrderIntent: {
                sha256: "ABC123",
                stockNo: "CN0000",
                dayTradeMode: "day_trade",
              },
              safety: { noLiveOrderSent: true, sentOrder: false },
              blockers: ["quote_fresh_matched:session_closed", "live-risk:runtime-write-forbidden"],
            },
            nextSafeTask: "補齊 verified position snapshot 與 adapter ack。",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-direct-operation-inputs-latest.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-25T00:13:00.051Z",
            status: "ready",
            mode: "operator_input_templates_only",
            requestedTrade: {
              instrument: "A50 202605",
              quoteSymbol: "CN0000",
              holdingMode: "day_trade",
              status: "blocked_a50_stale",
            },
            sealedIntentSha256: "ABC123",
            templates: {
              verifiedPositionSnapshot: {
                path: ".openclaw/trading/templates/capital-verified-position-snapshot.template.json",
              },
              externalBrokerAdapterAck: {
                path: ".openclaw/trading/templates/capital-external-broker-adapter-ack.template.json",
              },
              externalBrokerAdapterAckRequiredCurrent: {
                path: ".openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
              },
            },
            activeTargets: {
              verifiedPositionSnapshot: {
                path: "config/capital-verified-position-snapshot.json",
                exists: false,
                status: "missing",
                usable: false,
                verifiedAt: "2026-05-25T00:34:10.000Z",
                verifiedBy: "telegram-owner",
                verifiedAgeSeconds: 120,
                maxFreshSeconds: 43200,
                freshnessStatus: "fresh",
              },
              externalBrokerAdapterAck: {
                path: ".openclaw/trading/capital-external-broker-adapter-ack.json",
                exists: false,
                status: "missing",
                usable: false,
                expectedSealedIntentSha256: "ABC123",
                actualSealedIntentSha256: "OLD456",
                hashOk: false,
              },
            },
            operatorSteps: [
              {
                id: "verified_position_snapshot",
                validation: "pnpm capital:trade:direct:status:check",
              },
              { id: "external_broker_adapter_ack", validation: "pnpm capital:trade:direct:check" },
            ],
            safety: {
              generatedTemplatesOnly: true,
              wroteActivePositionSnapshot: false,
              wroteActiveAdapterAck: false,
              brokerWriteAttempted: false,
              sentOrder: false,
              noLiveOrderSent: true,
            },
            nextSafeTask: "把 direct-operation inputs report 顯示到 Telegram direct panel。",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-live-operator-execution-packet-latest.json"),
        JSON.stringify(
          {
            status: "blocked",
            operatorCanExecute: false,
            machineLine:
              "capitalOperatorPacket=blocked sha256=ABC123 readiness=blocked adapterAck=blocked operatorCanExecute=false noOrderWrite=true sentOrder=false blockers=3",
            readiness: { status: "blocked" },
            adapterAck: {
              status: "blocked",
              hashOk: false,
              canaryPass: true,
              canaryDryRun: true,
              canarySentOrder: false,
              rollbackPass: true,
              rollbackVerifiedAt: "2026-05-25T00:34:10.000Z",
              rollbackAgeSeconds: 120,
              rollbackMaxFreshSeconds: 43200,
              rollbackFresh: true,
              rollbackFreshnessStatus: "fresh",
              expectedSealedIntentSha256: "ABC123",
              actualSealedIntentSha256: "OLD456",
              requiredTemplatePath:
                ".openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
            },
            executionPayload: { dispatchPolicy: "blocked_do_not_send" },
            blockers: [
              "readiness:not-ready",
              "adapterAck:not-verified",
              "direct:pretrade-not-ready",
            ],
            safety: {
              noOrderWrite: true,
              sentOrder: false,
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(
          reportDir,
          "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
        ),
        JSON.stringify(
          {
            schema: "openclaw.capital.local-broker-executor-dispatch-contract.v1",
            generatedAt: "2026-05-25T17:15:33.383Z",
            status: "blocked",
            sealedIntentSha256: "ABC123",
            dispatchPolicy: "blocked_do_not_send",
            machineLine:
              "capitalLocalExecutorDispatch=blocked sha256=ABC123 operatorCanExecute=false executorArmed=false dispatchPolicy=blocked_do_not_send payloadHash=PAYLOAD123 noOrderWrite=true sentOrder=false blockers=3",
            operatorPacket: {
              status: "blocked",
              operatorCanExecute: false,
              readinessStatus: "blocked",
              adapterAckStatus: "blocked",
              dispatchPolicy: "blocked_do_not_send",
              blockers: [
                "readiness:not-ready",
                "adapterAck:not-verified",
                "direct:pretrade-not-ready",
              ],
            },
            executor: {
              id: "openclaw-managed-capital-live-executor",
              armed: false,
              armStatus: "unarmed",
              armProfilePath:
                "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
              credentialOwner: "local_broker_executor",
            },
            dispatchContract: {
              payloadHash: "PAYLOAD123",
              commandPayload: {
                stockNo: "CN0000",
                buySell: "buy",
                qty: 1,
                dayTradeMode: "explicit_required",
              },
              sealedOrderIntent: { sha256: "ABC123" },
            },
            blockers: [
              "operatorPacket:not-executable",
              "executor:arm-profile-not-armed",
              "operatorPacket:readiness:not-ready",
            ],
            safety: {
              noLiveOrderSent: true,
              no_live_order_sent: true,
              sentOrder: false,
              brokerApiCalled: false,
              wroteBrokerCommand: false,
              writeBrokerOrders: false,
            },
            paths: {
              reportPath:
                "D:\\OpenClaw\\reports\\hermes-agent\\state\\openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
            },
            nextSafeTask: "Keep local executor dispatch blocked until gates pass.",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-live-executor-arm-profile-latest.json"),
        JSON.stringify(
          {
            schema: "openclaw.capital.live-executor-arm-profile.v1",
            generatedAt: "2026-05-25T17:35:39.383Z",
            status: "unarmed",
            executorId: "openclaw-managed-capital-live-executor",
            profileExists: false,
            profileReadStatus: "missing",
            armed: false,
            allowBrokerWriteWhenAllGatesPass: false,
            allowConversationAgentDirectWrite: false,
            brokerWriteAuthorityTarget: "openclaw_managed_local_broker_executor",
            operatorSignaturePresent: false,
            armedAt: "",
            expiresAt: "",
            ttlSeconds: null,
            maxTtlSeconds: 900,
            expired: false,
            paths: {
              profilePath:
                "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
              templatePath:
                "D:\\OpenClaw\\.openclaw\\trading\\templates\\capital-live-executor-arm-profile.template.json",
            },
            requirements: {
              killSwitch: true,
              canaryRequired: true,
              rollbackRequired: true,
              freshQuoteRequired: true,
              verifiedPositionRequired: true,
              adapterAckHashRequired: true,
            },
            profileRequirementsObserved: {
              killSwitch: false,
              canaryRequired: false,
              rollbackRequired: false,
              freshQuoteRequired: false,
              verifiedPositionRequired: false,
              adapterAckHashRequired: false,
            },
            safety: {
              sentOrder: false,
              noLiveOrderSent: true,
              brokerWriteAttempted: false,
              conversationAgentDirectBrokerWrite: false,
              reportOnly: true,
            },
            template: {
              note: "Copy to .openclaw/trading/capital-live-executor-arm-profile.json only when the local broker executor is intentionally armed.",
            },
            machineLine:
              "capitalLiveExecutorArmProfile=unarmed armed=false allowExecutorWrite=false expired=false ttlSeconds=missing killSwitch=false noOrderWrite=true sentOrder=false blockers=1",
            blockers: ["arm_profile:missing_active_profile"],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(
          reportDir,
          "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
        ),
        JSON.stringify(
          {
            schema: "openclaw.capital.live-trading-operator-auto-deactivate-receipt-gate.v1",
            generatedAt: "2026-05-26T16:39:38.598Z",
            status: "pending_explicit_execute_receipt",
            auditId: "capital-auto-deactivate-5417f11f9d6d9e65d836",
            pendingExplicitExecuteReceipt: true,
            receiptVerified: false,
            execute: false,
            applied: false,
            operatorActionRequired: true,
            heartbeatExecuteAllowed: false,
            validationCommands: {
              receiptGate:
                "pnpm --dir D:\\OpenClaw capital:live-trading:operator:auto-deactivate:receipt:check",
            },
            blockers: ["operator-auto-deactivate:execute-receipt-pending"],
            safety: {
              reportOnly: true,
              noLiveOrderSent: true,
              sentOrder: false,
              writeBrokerOrders: false,
              liveTradingEnabled: false,
              heartbeatExecuteAllowed: false,
            },
            machineLine:
              "capitalAutoDeactivateReceipt=pending_explicit_execute_receipt audit=capital-auto-deactivate-5417f11f9d6d9e65d836 pendingExplicitExecuteReceipt=true receiptVerified=false heartbeatExecuteAllowed=false noOrderWrite=true sentOrder=false",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-direct-strategy-platform-gate-latest.json"),
        JSON.stringify(
          {
            liveCompletion: {
              status: "blocked",
              operatorCanExecute: false,
              dispatchPolicy: "blocked_do_not_send",
              passCount: 4,
              stageCount: 8,
              noLiveOrderSent: true,
              writeBrokerOrders: false,
              stages: [
                { id: "quote:strategy-ready", status: "pass" },
                { id: "position:verified-fresh", status: "pass" },
                { id: "strategy:paper-promoted", status: "blocked" },
                { id: "adapter:ack-hash-match", status: "blocked" },
                { id: "adapter:canary-no-order", status: "pass" },
                { id: "adapter:rollback-fresh", status: "pass" },
                { id: "direct:pretrade-clear", status: "blocked" },
                { id: "operator-packet:execution-ready", status: "blocked" },
              ],
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-adapter-ack-operator-apply-verifier-latest.json"),
        JSON.stringify(
          {
            status: "ready_for_operator_apply",
            applyVerdict: {
              status: "ready_for_operator_apply",
              activeState: "pre_apply_current_matches",
              operatorMayApply: true,
              operatorApplyVerified: false,
              sourcePath:
                ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
              destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-adapter-ack-operator-apply-plan-latest.json"),
        JSON.stringify(
          {
            status: "ready_atomic_apply_plan",
            operatorApplyPlan: {
              status: "ready_atomic_apply_plan",
              applyAllowedByPlan: true,
              alreadyAppliedVerified: false,
              sourcePath:
                ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
              destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(
          reportDir,
          "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
        ),
        JSON.stringify(
          {
            status: "pending_operator_apply",
            operatorReceipt: {
              status: "pending_operator_apply",
              action: "operator_apply_required",
              operatorMayApply: true,
              operatorApplyVerified: false,
              sourcePath:
                ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
              destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
              validationCommands: {
                receipt: "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
                postApplyClosure: "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(reportDir, "openclaw-capital-post-apply-live-closure-gate-latest.json"),
        JSON.stringify(
          {
            status: "blocked_post_apply_closure_incomplete",
            operatorCanExecute: false,
            adapterApply: {
              verified: false,
              verifierStatus: "ready_for_operator_apply",
              activeState: "pre_apply_current_matches",
              operatorMayApply: true,
              operatorApplyVerified: false,
            },
            applyPlan: {
              status: "ready_atomic_apply_plan",
              applyAllowedByPlan: true,
              alreadyAppliedVerified: false,
            },
            adapterApplyReceipt: {
              verified: false,
              status: "pending_operator_apply",
              action: "operator_apply_required",
              operatorMayApply: true,
              operatorApplyVerified: false,
              sourcePath:
                ".openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
              destinationPath: ".openclaw/trading/capital-external-broker-adapter-ack.json",
            },
            liveReadiness: {
              status: "blocked_live_readiness_incomplete",
              operatorCanExecute: false,
            },
            localExecutorDispatch: {
              status: "blocked",
              dispatchPolicy: "blocked_do_not_send",
              operatorCanExecute: false,
            },
            validationCommands: {
              closure: "pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check",
              applyReceipt: "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
            },
            safety: {
              noLiveOrderSent: true,
              sentOrder: false,
              writeBrokerOrders: false,
            },
            blockers: [
              "adapterAck:operator-apply-receipt-not-verified",
              "adapterAck:operator-apply-not-verified",
            ],
            machineLine:
              "capitalPostApplyClosure=blocked_post_apply_closure_incomplete adapterApplyVerified=false adapterApplyReceiptVerified=false operatorCanExecute=false noLiveOrderSent=true sentOrder=false noOrderWrite=true blockers=2",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:direct");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("直接操作 Gate");
      expect(firstEdit.text).toContain("A50 202605");
      expect(firstEdit.text).toContain("ABC123");
      expect(firstEdit.text).toContain("真單解鎖三件事");
      expect(firstEdit.text).toContain("verified position snapshot=❌");
      expect(firstEdit.text).toContain("adapter ack required-current=❌");
      expect(firstEdit.text).toContain("live executor arm profile=❌");
      expect(firstEdit.text).toContain("allowExecutorWrite=❌");
      expect(firstEdit.text).toContain("capital-live-executor-arm-profile.json");
      expect(firstEdit.text).toContain("缺 verified position snapshot");
      expect(firstEdit.text).toContain("Operator Execution Packet");
      expect(firstEdit.text).toContain("operatorCanExecute=❌");
      expect(firstEdit.text).toContain("blocked_do_not_send");
      expect(firstEdit.text).toContain("capitalOperatorPacket=blocked");
      expect(firstEdit.text).toContain("本地執行器 Dispatch");
      expect(firstEdit.text).toContain("capitalLocalExecutorDispatch=blocked");
      expect(firstEdit.text).toContain("executorArmed=❌");
      expect(firstEdit.text).toContain("payloadHash=<code>PAYLOAD123</code>");
      expect(firstEdit.text).toContain("回關收據 Gate");
      expect(firstEdit.text).toContain("pendingExplicitExecuteReceipt=✅");
      expect(firstEdit.text).toContain("receiptVerified=❌");
      expect(firstEdit.text).toContain("heartbeatExecuteAllowed=❌");
      expect(firstEdit.text).toContain("operator-auto-deactivate:execute-receipt-pending");
      expect(firstEdit.text).toContain("noLiveOrderSent=✅");
      expect(firstEdit.text).toContain("brokerWriteAttempted=❌");
      expect(firstEdit.text).toContain("freshness=<code>fresh</code>");
      expect(firstEdit.text).toContain("age=120s");
      expect(firstEdit.text).toContain("verifiedAt=<code>2026-05-25T00:34:10.000Z</code>");
      expect(firstEdit.text).toContain(
        "operatorRefresh=<code>更新 active snapshot 後按 sc:tr:directpos / pnpm capital:trade:direct:status:check</code> noOrderWrite=✅",
      );
      expect(firstEdit.text).toContain("capital-verified-position-snapshot.template.json");
      expect(firstEdit.text).toContain("capital-external-broker-adapter-ack.template.json");
      expect(firstEdit.text).toContain("capital-external-broker-adapter-ack.required-current.json");
      expect(firstEdit.text).toContain("expectedHash=<code>ABC123</code>");
      expect(firstEdit.text).toContain("activeHash=<code>OLD456</code>");
      expect(firstEdit.text).toContain("hashOk=❌");
      expect(firstEdit.text).toContain("canary=✅");
      expect(firstEdit.text).toContain("rollback=✅");
      expect(firstEdit.text).toContain("canaryNoOrder=✅");
      expect(firstEdit.text).toContain("rollbackFresh=<code>fresh</code>");
      expect(firstEdit.text).toContain("rollbackAge=120s");
      expect(firstEdit.text).toContain("Adapter Post-Apply Readback");
      expect(firstEdit.text).toContain("verifier=<code>ready_for_operator_apply</code>");
      expect(firstEdit.text).toContain("activeState=<code>pre_apply_current_matches</code>");
      expect(firstEdit.text).toContain("plan=<code>ready_atomic_apply_plan</code>");
      expect(firstEdit.text).toContain("applyAllowedByPlan=✅");
      expect(firstEdit.text).toContain("alreadyApplied=❌");
      expect(firstEdit.text).toContain("receipt=<code>pending_operator_apply</code>");
      expect(firstEdit.text).toContain(
        "closure=<code>blocked_post_apply_closure_incomplete</code>",
      );
      expect(firstEdit.text).toContain(
        "liveReadiness=<code>blocked_live_readiness_incomplete</code>",
      );
      expect(firstEdit.text).toContain("localDispatch=<code>blocked</code>");
      expect(firstEdit.text).toContain(
        "capitalPostApplyClosure=blocked_post_apply_closure_incomplete",
      );
      expect(firstEdit.text).toContain("adapterAck:operator-apply-receipt-not-verified");
      expect(firstEdit.text).toContain("Adapter Apply Receipt");
      expect(firstEdit.text).toContain("operatorMayApply=✅");
      expect(firstEdit.text).toContain("operatorApplyVerified=❌");
      expect(firstEdit.text).toContain("operator-owned-broker-adapter-only");
      expect(firstEdit.text).toContain("operator_apply_required");
      expect(firstEdit.text).toContain("pre_apply_current_matches");
      expect(firstEdit.text).toContain(
        "validation=<code>pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check</code>",
      );
      expect(firstEdit.text).toContain(
        "postApply=<code>pnpm --dir D:\\OpenClaw capital:trade:post-apply-closure:check</code>",
      );
      expect(firstEdit.text).toContain("capitalAdapterAckApplyReceipt=pending_operator_apply");
      expect(firstEdit.text).toContain("operator-apply:pending");
      expect(firstEdit.text).toContain("策略/實單完成矩陣");
      expect(firstEdit.text).toContain("pass=4/8");
      expect(firstEdit.text).toContain("writeBrokerOrders=❌");
      expect(firstEdit.text).toContain("operator-packet:execution-ready");
      expect(firstEdit.text).toContain("quote_fresh_matched:session_closed");
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:direct")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:directrun")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:localexec")).toBe(
        true,
      );
      expect(
        firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:armprofile"),
      ).toBe(true);
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:directpos")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:ackapply")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:cap")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders Capital local executor drill-down without broker writes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-capital-local-executor-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(
          reportDir,
          "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
        ),
        JSON.stringify(
          {
            schema: "openclaw.capital.local-broker-executor-dispatch-contract.v1",
            generatedAt: "2026-05-25T17:15:33.383Z",
            status: "blocked",
            sealedIntentSha256: "ABC123",
            dispatchPolicy: "blocked_do_not_send",
            machineLine:
              "capitalLocalExecutorDispatch=blocked sha256=ABC123 operatorCanExecute=false executorArmed=false dispatchPolicy=blocked_do_not_send payloadHash=PAYLOAD123 noOrderWrite=true sentOrder=false blockers=3",
            operatorPacket: {
              status: "blocked",
              operatorCanExecute: false,
              readinessStatus: "blocked",
              adapterAckStatus: "blocked",
              dispatchPolicy: "blocked_do_not_send",
              blockers: [
                "readiness:not-ready",
                "adapterAck:not-verified",
                "direct:pretrade-not-ready",
              ],
            },
            executor: {
              id: "openclaw-managed-capital-live-executor",
              armed: false,
              armStatus: "unarmed",
              armProfilePath:
                "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
              credentialOwner: "local_broker_executor",
            },
            dispatchContract: {
              payloadHash: "PAYLOAD123",
              commandPayload: {
                stockNo: "CN0000",
                buySell: "buy",
                qty: 1,
                dayTradeMode: "explicit_required",
              },
              sealedOrderIntent: { sha256: "ABC123" },
            },
            blockers: [
              "operatorPacket:not-executable",
              "executor:arm-profile-not-armed",
              "operatorPacket:readiness:not-ready",
            ],
            safety: {
              noLiveOrderSent: true,
              no_live_order_sent: true,
              sentOrder: false,
              brokerApiCalled: false,
              wroteBrokerCommand: false,
              writeBrokerOrders: false,
            },
            paths: {
              reportPath:
                "D:\\OpenClaw\\reports\\hermes-agent\\state\\openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
            },
            nextSafeTask: "Keep local executor dispatch blocked until gates pass.",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:localexec");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("本地執行器 Dispatch");
      expect(firstEdit.text).toContain("capitalLocalExecutorDispatch=blocked");
      expect(firstEdit.text).toContain("operatorCanExecute=❌");
      expect(firstEdit.text).toContain("executorArmed=❌");
      expect(firstEdit.text).toContain("dispatch=<code>blocked_do_not_send</code>");
      expect(firstEdit.text).toContain("payloadHash=<code>PAYLOAD123</code>");
      expect(firstEdit.text).toContain("noOrderWrite=✅");
      expect(firstEdit.text).toContain("sentOrder=❌");
      expect(firstEdit.text).toContain("brokerApiCalled=❌");
      expect(firstEdit.text).toContain("wroteBrokerCommand=❌");
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:localexec")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:direct")).toBe(
        true,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders Capital live executor arm profile drill-down without broker writes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-capital-arm-profile-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(reportDir, "openclaw-capital-live-executor-arm-profile-latest.json"),
        JSON.stringify(
          {
            schema: "openclaw.capital.live-executor-arm-profile.v1",
            generatedAt: "2026-05-25T17:35:39.383Z",
            status: "unarmed",
            mode: "operator_managed_live_executor_arm_profile",
            executorId: "openclaw-managed-capital-live-executor",
            profileExists: false,
            profileReadStatus: "missing",
            armed: false,
            allowBrokerWriteWhenAllGatesPass: false,
            allowConversationAgentDirectWrite: false,
            brokerWriteAuthorityTarget: "openclaw_managed_local_broker_executor",
            operatorSignaturePresent: false,
            armedAt: "",
            expiresAt: "",
            ttlSeconds: null,
            maxTtlSeconds: 900,
            expired: false,
            blockers: ["arm_profile:missing_active_profile"],
            requirements: {
              killSwitch: true,
              canaryRequired: true,
              rollbackRequired: true,
              freshQuoteRequired: true,
              verifiedPositionRequired: true,
              adapterAckHashRequired: true,
            },
            profileRequirementsObserved: {
              killSwitch: false,
              canaryRequired: false,
              rollbackRequired: false,
              freshQuoteRequired: false,
              verifiedPositionRequired: false,
              adapterAckHashRequired: false,
            },
            safety: {
              sentOrder: false,
              noLiveOrderSent: true,
              brokerWriteAttempted: false,
              conversationAgentDirectBrokerWrite: false,
              reportOnly: true,
            },
            paths: {
              profilePath:
                "D:\\OpenClaw\\.openclaw\\trading\\capital-live-executor-arm-profile.json",
              templatePath:
                "D:\\OpenClaw\\.openclaw\\trading\\templates\\capital-live-executor-arm-profile.template.json",
              reportPath:
                "D:\\OpenClaw\\reports\\hermes-agent\\state\\openclaw-capital-live-executor-arm-profile-latest.json",
            },
            template: {
              note: "Copy to .openclaw/trading/capital-live-executor-arm-profile.json only when the local broker executor is intentionally armed.",
            },
            machineLine:
              "capitalLiveExecutorArmProfile=unarmed armed=false allowExecutorWrite=false expired=false ttlSeconds=missing killSwitch=false noOrderWrite=true sentOrder=false blockers=1",
            nextSafeTask:
              "Fill and review .openclaw/trading/capital-live-executor-arm-profile.json, then rerun pnpm capital:trade:live-executor-profile:check.",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:armprofile");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("Live Executor Arm Profile");
      expect(firstEdit.text).toContain("armed=❌");
      expect(firstEdit.text).toContain("allowExecutorWrite=❌");
      expect(firstEdit.text).toContain("killSwitch: required=✅ observed=❌");
      expect(firstEdit.text).toContain("adapterAckHashRequired: required=✅ observed=❌");
      expect(firstEdit.text).toContain("noLiveOrderSent=✅");
      expect(firstEdit.text).toContain("sentOrder=❌");
      expect(firstEdit.text).toContain("brokerWriteAttempted=❌");
      expect(firstEdit.text).toContain("capitalLiveExecutorArmProfile=unarmed");
      expect(firstEdit.text).toContain("pnpm capital:trade:live-executor-profile:check");
      expect(
        firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:armprofile"),
      ).toBe(true);
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:direct")).toBe(
        true,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs Capital position snapshot readback without broker writes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:directpos");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain("pnpm capital:trade:direct:status:check");
    expect(runArg.message).toContain("pnpm capital:trade:platform:check");
    expect(runArg.message).toContain("pnpm capital-hft:telegram-trading-shortcuts:check");
    expect(runArg.message).toContain("只重讀 operator-owned verified position snapshot");
    expect(runArg.message).toContain("不得建立或覆寫 active position snapshot");
    expect(runArg.message).toContain("不得送出真單");
    const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
      (call) => (call[0] as { text?: string }).text ?? "",
    );
    expect(allMessages.some((text) => text.includes("倉位快照重讀 Gate"))).toBe(true);
  });

  it("runs Capital auto-deactivate receipt gate readback without live writes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:receipt");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain(
      "pnpm capital:live-trading:operator:auto-deactivate:receipt:check",
    );
    expect(runArg.message).toContain("pnpm check:openclaw-controlled-task-runner-telegram-publish");
    expect(runArg.message).toContain("pnpm capital-hft:telegram-trading-shortcuts:check");
    expect(runArg.message).toContain("messageTokenCounts.receiptPrompt");
    expect(runArg.message).toContain("receiptVerified");
    expect(runArg.message).toContain("不得執行 auto-deactivate execute");
    expect(runArg.message).toContain("不得送出真單");
    const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
      (call) => (call[0] as { text?: string }).text ?? "",
    );
    expect(allMessages.some((text) => text.includes("回關收據 Gate"))).toBe(true);
  });

  it("runs Capital adapter ack apply receipt readback without live writes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:ackapply");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain("pnpm capital:trade:adapter-ack-apply-verifier:check");
    expect(runArg.message).toContain("pnpm capital:trade:adapter-ack-apply-plan:check");
    expect(runArg.message).toContain("pnpm capital:trade:adapter-ack-apply-receipt:check");
    expect(runArg.message).toContain("pnpm capital:trade:adapter-ack:check");
    expect(runArg.message).toContain("pnpm capital:trade:post-apply-closure:check");
    expect(runArg.message).toContain("pnpm capital:trade:direct:check");
    expect(runArg.message).toContain("pnpm capital:trade:direct:status:check");
    expect(runArg.message).toContain("pnpm capital-hft:telegram-trading-shortcuts:check");
    expect(runArg.message).toContain("adapterApplyReceipt.status");
    expect(runArg.message).toContain("operatorMayApply");
    expect(runArg.message).toContain("operatorApplyVerified");
    expect(runArg.message).toContain("activeState");
    expect(runArg.message).toContain("expected/active/candidate hash");
    expect(runArg.message).toContain("不得複製 staged ack 到 active ack");
    expect(runArg.message).toContain("不得建立或覆寫 active ack");
    expect(runArg.message).toContain("不得 arm executor");
    expect(runArg.message).toContain("不得送出真單");
    const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
      (call) => (call[0] as { text?: string }).text ?? "",
    );
    expect(allMessages.some((text) => text.includes("Ack套用收據 Gate"))).toBe(true);
  });

  it("runs Capital core product quote matrix readback without live writes", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:corequote");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain("pnpm capital:quote:core-products:check");
    expect(runArg.message).toContain("pnpm capital-hft:telegram-trading-shortcuts:check");
    expect(runArg.message).toContain("coreProductMatrix.status");
    expect(runArg.message).toContain("productCount");
    expect(runArg.message).toContain("subscribedDomesticCount");
    expect(runArg.message).toContain("subscribedOverseasCount");
    expect(runArg.message).toContain("不得啟用 live");
    expect(runArg.message).toContain("不得寫入券商或交易所");
    expect(runArg.message).toContain("不得套用 adapter ack");
    expect(runArg.message).toContain("不得 arm executor");
    expect(runArg.message).toContain("不得送出真單");
    const allMessages = [...respond.editMessage.mock.calls, ...respond.reply.mock.calls].map(
      (call) => (call[0] as { text?: string }).text ?? "",
    );
    expect(allMessages.some((text) => text.includes("全商品報價矩陣 Gate"))).toBe(true);
  });

  it("renders OKX order proposal gate from OpenClaw report", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-okx-order-report-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(reportDir, "openclaw-okx-order-proposal-gate-latest.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-24T02:12:37.935Z",
            mode: "dry_run_proposal_only",
            code: "dry_run_proposal_blocked",
            status: "blocked",
            summary_zh_tw: "OKX dry-run 下單提案已阻擋。",
            blockers: ["chat_supplied_secret_must_rotate"],
            markers: ["dry_run_proposal_blocked", "submitted_order_false"],
            requestedOrder: {
              profile: "demo",
              market: "spot",
              instId: "BTC-USDT",
              side: "buy",
              ordType: "market",
              tdMode: "cash",
              size: "0",
              isActionableOrder: false,
            },
            quoteContext: { instId: "BTC-USDT", last: "76899.1", bidPx: "76899", askPx: "76899.1" },
            preTradeChecks: {
              apiStatusSchemaOk: true,
              quoteOk: true,
              demoAuthOk: true,
              chatPostedKeyRotated: false,
              ipAllowlistSafe: false,
            },
            safety: {
              dryRunOnly: true,
              executionAllowed: false,
              submittedOrder: false,
              orderPlacementEnabled: false,
              liveTradingEnabled: false,
              writeTradingEnabled: false,
            },
            nextSafeTask: "重建 read-only key。",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:okxord");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("OKX 下單提案");
      expect(firstEdit.text).toContain("dry_run_proposal_blocked");
      expect(firstEdit.text).toContain("chat_supplied_secret_must_rotate");
      expect(firstEdit.text).toContain("已送單: ❌");
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:okxord")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:okx")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders OKX order status gate from OpenClaw report", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-okx-order-status-report-"));
    try {
      const reportDir = path.join(repoRoot, "reports", "hermes-agent", "state");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        path.join(reportDir, "openclaw-okx-order-status-gate-latest.json"),
        JSON.stringify(
          {
            generatedAt: "2026-05-24T04:21:41.273Z",
            mode: "read_only_order_lifecycle_status",
            code: "no_submitted_order_to_track",
            status: "blocked",
            summary_zh_tw: "OKX 訂單/撤單狀態：沒有已送出的 OpenClaw OKX 訂單可查。",
            blockers: ["chat_supplied_secret_must_rotate"],
            markers: ["order_status_read_only", "cancel_not_enabled"],
            trackedOrder: {
              profile: "demo",
              market: "spot",
              instId: "BTC-USDT",
              ordId: "",
              clOrdId: "",
              submittedOrder: false,
              orderStatus: "none",
              queryEnabled: false,
            },
            cancelStatus: {
              cancelOrderEnabled: false,
              cancelSubmitted: false,
              cancelStatus: "not_applicable",
            },
            safety: {
              readOnly: true,
              dryRunOnly: true,
              executionAllowed: false,
              orderPlacementEnabled: false,
              cancelOrderEnabled: false,
              submittedOrder: false,
              orderStatusQueryExecuted: false,
              writeTradingEnabled: false,
            },
            officialEndpointMap: {
              orderDetails: { method: "GET", path: "/api/v5/trade/order", permission: "Read" },
              pendingOrders: {
                method: "GET",
                path: "/api/v5/trade/orders-pending",
                permission: "Read",
              },
              cancelOrder: {
                method: "POST",
                path: "/api/v5/trade/cancel-order",
                permission: "Trade",
              },
            },
            nextSafeTask: "重建 read-only key。",
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:okxstat");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(firstEdit.text).toContain("OKX 訂單/撤單狀態");
      expect(firstEdit.text).toContain("代碼: <code>無可追蹤已送單</code>");
      expect(firstEdit.text).toContain("chat_supplied_secret_must_rotate");
      expect(firstEdit.text).toContain("已送單=❌");
      expect(firstEdit.text).toContain("POST /api/v5/trade/cancel-order");
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:okxstat")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:okxord")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:okx")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders position detail with Chinese profit wording", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-pos-state-"));
    try {
      mkdirSync(path.join(stateDir, "ui"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "ui", "auto-trading-assistant-state.json"),
        JSON.stringify(
          {
            mode: "paper",
            quoteStatus: "fresh",
            positions: [
              {
                symbol: "TX00",
                side: "long",
                qty: 1,
                entryPrice: 100,
                currentPrice: 110,
                pnl: 10,
                pnlPercent: 10,
              },
            ],
          },
          null,
          2,
        ),
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      await triggerCallback(subagent, respond, "tr:pos");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(firstEdit.text).toContain("持倉詳情");
      expect(firstEdit.text).toContain("損益:");
      expect(firstEdit.text).not.toContain("P&L:");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("renders learning summary panel with non-empty Chinese fallback", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.callGatewayCompatMock.mockResolvedValueOnce(null);

    await triggerCallback(subagent, respond, "tr:learn");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(typeof firstEdit.text).toBe("string");
    expect((firstEdit.text ?? "").trim().length).toBeGreaterThan(0);
    expect(firstEdit.text).toContain("學習摘要");
    expect(firstEdit.text).toContain("目前沒有學習記錄");
    expect(firstEdit.text).toContain("快速進出場模擬模式");
    expect(firstEdit.text).toContain("no-paper-execution");
    expect(firstEdit.text).toContain(
      "nextSafeCommand=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
    );
  });

  it("renders learning summary panel with fast order audit pattern", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-learn-shortcuts-report-"));
    mocks.callGatewayCompatMock.mockResolvedValueOnce({
      latestReview: {
        status: "paper_execution_recorded",
        decision: "approve_paper",
      },
      latestPaperExecution: {
        recorded: true,
        paperOnly: true,
        symbol: "TX00",
        side: "buy",
        quantity: 1,
      },
      history: {
        entries: [
          {
            kind: "paper_execution",
            status: "paper_execution_recorded",
            decision: "approve_paper",
          },
          { kind: "review", status: "denied", decision: "deny" },
        ],
      },
    });

    try {
      writeShortcutGateReportFixture(repoRoot, "2026-05-24T16:16:48.781Z");
      vi.stubEnv("OPENCLAW_REPO_ROOT", repoRoot);

      await triggerCallback(subagent, respond, "tr:learn");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
        text?: string;
        buttons?: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(mocks.callGatewayCompatMock).toHaveBeenCalledWith(
        expect.anything(),
        "trading.fastOrderAudit.snapshot",
        { filter: "all", offset: 0, limit: 5 },
      );
      expect(firstEdit.text).toContain("快速進出場模擬模式");
      expect(firstEdit.text).toContain("學習模式: 成功=1 失敗=1");
      expect(firstEdit.text).toContain("mixed-paper-pattern");
      expect(firstEdit.text).toContain(
        "nextSafeCommand=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code>",
      );
      expect(firstEdit.text).toContain("新的 fresh quote 後才重跑 sc:tr:paperloop");
      expect(firstEdit.text).toContain("gateVerified=✅");
      expect(firstEdit.text).toContain("verified=sc:tr:assist / sc:tr:audit / sc:tr:paperloop");
      expect(firstEdit.text).toContain(
        "gateHint=<code>sc:tr:audit / sc:tr:paperloop / sc:tr:assist</code> note=下一步指令已由 gate 驗證 brokerLocked=✅",
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:paperloop")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:audit")).toBe(
        true,
      );
      expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data === "sc:tr:assist")).toBe(
        true,
      );
      expect(subagent.run).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("renders learning summary panel from OPENCLAW_STATE_DIR markdown file", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-learn-state-"));
    try {
      mkdirSync(path.join(stateDir, "ui"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "ui", "auto-trading-learning-summary.md"),
        "策略學習摘要：TX00 在盤整區間減倉，避免過度交易。",
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      await triggerCallback(subagent, respond, "tr:learn");

      const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
      expect(typeof firstEdit.text).toBe("string");
      expect((firstEdit.text ?? "").trim().length).toBeGreaterThan(0);
      expect(firstEdit.text).toContain("學習摘要");
      expect(firstEdit.text).toContain("策略學習摘要：TX00 在盤整區間減倉");
      expect(firstEdit.text).not.toContain("目前沒有學習記錄");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses Chinese diagnostic checklist wording in trading diagnose task", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:diag");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain("診斷群益報價服務程序狀態");
    expect(runArg.message).toContain("診斷報價連線是否即時（新鮮度）");
    expect(runArg.message).toContain("診斷模擬交易循環狀態");
    expect(runArg.message).toContain("回報所有阻擋項目與建議");
    expect(runArg.message).not.toContain("BrokerDesk");
    expect(runArg.message).not.toContain("檢查");
  });

  it("routes trading super assistant shortcuts to guarded OpenClaw checks", async () => {
    const subagent = createSubagent({ status: "ok" });

    const dispatcherRespond = createResponder();
    await triggerCallback(subagent, dispatcherRespond, "tr:disp");
    const dispatcherArg = subagent.run.mock.calls.at(-1)?.[0] as { message?: string };
    expect(dispatcherArg.message).toContain("D:\\OpenClaw");
    expect(dispatcherArg.message).toContain("pnpm capital-hft:hft-broker-dispatcher:check");
    expect(dispatcherArg.message).toContain("no_live_order_sent");
    expect(dispatcherArg.message).toContain("不得啟用 live");

    const liveRespond = createResponder();
    await triggerCallback(subagent, liveRespond, "tr:live");
    const liveArg = subagent.run.mock.calls.at(-1)?.[0] as { message?: string };
    expect(liveArg.message).toContain("pnpm capital-hft:live-trading:approval:summary:check");
    expect(liveArg.message).toContain("pnpm capital-hft:live-trading:promotion:check");
    expect(liveArg.message).toContain("不得送出真單");

    const hftRespond = createResponder();
    await triggerCallback(subagent, hftRespond, "tr:hft");
    const hftArg = subagent.run.mock.calls.at(-1)?.[0] as { message?: string };
    expect(hftArg.message).toContain("check-capital-se-hft-hftengine-gate.mjs");
    expect(hftArg.message).toContain("check-capital-se-hft-strategies-twapvwapexecutor-gate.mjs");

    const rerunRespond = createResponder();
    await triggerCallback(subagent, rerunRespond, "tr:rerun");
    const rerunArg = subagent.run.mock.calls.at(-1)?.[0] as { message?: string };
    expect(rerunArg.message).toContain("pnpm capital:strategy:fill-simulation");
    expect(rerunArg.message).toContain("pnpm capital:strategy:fill-simulation:check");
    expect(rerunArg.message).toContain("pnpm capital-hft:auto-trading");
    expect(rerunArg.message).toContain("pnpm capital-hft:auto-trading-assistant:check");
    expect(rerunArg.message).toContain("expected_value_pts");
    expect(rerunArg.message).toContain("flowDecision.gates");
    expect(rerunArg.message).toContain("不得 approve");
    expect(rerunArg.message).toContain("不得送出真單");
  });

  it("keeps trading callback replies in Chinese operational wording", async () => {
    const subagent = createSubagent({ status: "ok" });

    const buyRespond = createResponder();
    await triggerCallback(subagent, buyRespond, "tr:buy");
    const buyEdit = buyRespond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(buyEdit.text).toContain("助手會處理");
    expect(buyEdit.text).not.toContain("Agent");

    const closeRespond = createResponder();
    await triggerCallback(subagent, closeRespond, "tr:closeall");
    const closeEdit = closeRespond.editMessage.mock.calls[0]?.[0] as {
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    const closeLabels = closeEdit.buttons?.flat().map((btn) => btn.text) ?? [];
    expect(closeLabels).toContain("← 返回交易");
    expect(closeLabels).not.toContain("❌ 取消");
  });

  it("keeps trading callback button copy consistent and avoids legacy labels", async () => {
    const subagent = createSubagent({ status: "ok" });

    const quoteRespond = createResponder();
    await triggerCallback(subagent, quoteRespond, "tr:quote");
    const quoteEdit = quoteRespond.editMessage.mock.calls[0]?.[0] as {
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    const quoteLabels = quoteEdit.buttons?.flat().map((btn) => btn.text) ?? [];
    expect(quoteLabels).toContain("🔄 刷新");
    expect(quoteLabels).toContain("← 返回交易");
    expect(quoteLabels).toContain("🔍 診斷");
    expect(quoteLabels).toContain("🤖 模擬助手");
    expect(quoteLabels).not.toContain("← 交易");
    expect(quoteEdit.text).toContain("報價狀態");

    const buyRespond = createResponder();
    await triggerCallback(subagent, buyRespond, "tr:buy");
    const buyEdit = buyRespond.editMessage.mock.calls[0]?.[0] as {
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    const buyLabels = buyEdit.buttons?.flat().map((btn) => btn.text) ?? [];
    const buyCallbacks = buyEdit.buttons?.flat().map((btn) => btn.callback_data) ?? [];
    expect(buyLabels).toContain("🟢 TX00 1口");
    expect(buyLabels).toContain("🟢 MCL0000 1口");
    expect(buyLabels).toContain("← 返回下單");
    expect(buyLabels).toContain("← 返回交易");
    expect(buyCallbacks).toContain("sc:tr:ord:buy_TX00_1");
    expect(buyCallbacks).toContain("sc:tr:ord:buy_MCL0000_1");

    const sellRespond = createResponder();
    await triggerCallback(subagent, sellRespond, "tr:sell");
    const sellEdit = sellRespond.editMessage.mock.calls[0]?.[0] as {
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    const sellLabels = sellEdit.buttons?.flat().map((btn) => btn.text) ?? [];
    const sellCallbacks = sellEdit.buttons?.flat().map((btn) => btn.callback_data) ?? [];
    expect(sellLabels).toContain("🔴 TX00 1口");
    expect(sellLabels).toContain("🔴 MCL0000 1口");
    expect(sellLabels).toContain("← 返回下單");
    expect(sellLabels).toContain("← 返回交易");
    expect(sellCallbacks).toContain("sc:tr:ord:sell_TX00_1");
    expect(sellCallbacks).toContain("sc:tr:ord:sell_MCL0000_1");
  });

  it("runs quick simulated paper order from trading shortcut buttons", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:ord:buy_TX00_1");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain(
      'node scripts/openclaw-capital-telegram-simulated-live-order.mjs --text "模擬真單 TX00 多 1口" --write-state --json',
    );
    expect(runArg.message).toContain("不得啟用 live，不得送出真單");
  });

  it("runs quick simulated paper sell order from trading shortcut buttons", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:ord:sell_MCL0000_1");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain(
      'node scripts/openclaw-capital-telegram-simulated-live-order.mjs --text "模擬真單 MCL0000 空 1口" --write-state --json',
    );
    expect(runArg.message).toContain("不得啟用 live，不得送出真單");
  });

  it("runs the trading auto-cycle callback as a paper-only subagent task", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" }, "交易總循環完成");

    await triggerCallback(subagent, respond, "tr:auto");

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const runArg = subagent.run.mock.calls[0]?.[0] as { message?: string };
    expect(runArg.message).toContain("pnpm capital:trade:auto-cycle");
    expect(runArg.message).toContain("pnpm capital:trade:auto-cycle:check");
    expect(runArg.message).toContain("pnpm capital-hft:telegram-trading-shortcuts:check");
    expect(runArg.message).toContain("不得送出真單");
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(firstEdit.text).toContain("交易總循環");
  });

  it("shows recovery panel when tr:ord payload is invalid", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "tr:ord:bad_payload");

    expect(subagent.run).not.toHaveBeenCalled();
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("模擬下單參數錯誤");
    const callbacks = firstEdit.buttons?.flat().map((btn) => btn.callback_data) ?? [];
    expect(callbacks).toContain("sc:tr:paper");
    expect(callbacks).toContain("sc:trade");
  });

  it("blocks callback when user is not in allow list", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_ENFORCE_PERMISSIONS", "true");
    vi.stubEnv("OPENCLAW_TELEGRAM_ALLOWED_IDS", "100");

    await triggerCallback(subagent, respond, "home", 42);

    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("沒有使用此功能的權限");
    expect(respond.editMessage).not.toHaveBeenCalled();
  });

  it("enforces rate limit when OPENCLAW_TELEGRAM_RATE_LIMIT_PER_MINUTE is set", async () => {
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_RATE_LIMIT_PER_MINUTE", "1");
    const senderId = 900001;

    const first = createResponder();
    await triggerCallback(subagent, first, "home", senderId);
    expect(first.editMessage).toHaveBeenCalledTimes(1);
    expect(first.reply).not.toHaveBeenCalled();

    const second = createResponder();
    await triggerCallback(subagent, second, "home", senderId);
    expect(second.reply).toHaveBeenCalledTimes(1);
    const reply = second.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("操作過於頻繁");
    expect(second.editMessage).not.toHaveBeenCalled();
  });

  it("blocks owner-only callback when sender is not owner", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    vi.stubEnv("OPENCLAW_TELEGRAM_ENFORCE_PERMISSIONS", "true");
    vi.stubEnv("OPENCLAW_TELEGRAM_OWNER_IDS", "100");

    await triggerCallback(subagent, respond, "approve:task-1", 42);

    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("僅限管理者");
    expect(respond.editMessage).not.toHaveBeenCalled();
  });

  it("requires risk confirmation before dangerous task execution", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });

    await triggerCallback(subagent, respond, "do:push");

    expect(subagent.run).not.toHaveBeenCalled();
    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("風險等級");
    const callbacks = firstEdit.buttons?.flat().map((btn) => btn.callback_data) ?? [];
    expect(callbacks.some((item) => item.startsWith("sc:risk:ok:"))).toBe(true);
    expect(callbacks.some((item) => item.startsWith("sc:risk:deny:"))).toBe(true);
  });

  it("shows errlog source failure when logs.tail is unavailable", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.tailLogsWithStatus.mockResolvedValue({
      ok: false,
      logs: [],
      error: "RPC error permission_denied: blocked",
    });

    await triggerCallback(subagent, respond, "errlog");

    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("來源不可用");
    expect(reply.text).toContain("permission_denied");
  });

  it("shows recent error rows in errlog panel when source is available", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.tailLogsWithStatus.mockResolvedValue({
      ok: true,
      logs: [{ ts: 1_717_000_000_000, level: "error", message: "boom happened" }],
    });

    await triggerCallback(subagent, respond, "errlog");

    expect(respond.reply).toHaveBeenCalledTimes(1);
    const reply = respond.reply.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("錯誤日誌");
    expect(reply.text).toContain("ERROR");
    expect(reply.text).toContain("boom happened");
  });

  it("renders session panel from gateway sessions list", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSessions.mockResolvedValue([
      {
        key: "agent:main:telegram:dm:42",
        displayName: "Telegram DM",
        updatedAt: Date.now(),
        hasActiveRun: true,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    ]);

    await triggerCallback(subagent, respond, "sess");

    const firstEdit = respond.editMessage.mock.calls[0]?.[0] as {
      text?: string;
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(firstEdit.text).toContain("對話工作階段面板");
    expect(firstEdit.text).toContain("agent:main:telegram:dm:42");
    expect(firstEdit.buttons?.flat().some((btn) => btn.callback_data.startsWith("sc:ss:vw:"))).toBe(
      true,
    );
  });

  it("skips duplicate session-panel edit on repeated sess callback click", async () => {
    const respond = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSessions.mockResolvedValue([
      {
        key: "agent:main:telegram:dm:42",
        displayName: "Telegram DM",
        updatedAt: Date.now(),
        hasActiveRun: true,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    ]);

    await triggerCallback(subagent, respond, "sess");
    await triggerCallback(subagent, respond, "sess");

    expect(respond.editMessage).toHaveBeenCalledTimes(1);
    expect(respond.reply).not.toHaveBeenCalled();
  });

  it("runs session compact callback through gateway RPC", async () => {
    const seedResponder = createResponder();
    const subagent = createSubagent({ status: "ok" });
    mocks.gatewayRpcMock.fetchSessions.mockResolvedValue([
      {
        key: "agent:main:telegram:dm:42",
        displayName: "Telegram DM",
        updatedAt: Date.now(),
        hasActiveRun: false,
      },
    ]);
    mocks.gatewayRpcMock.compactSession.mockResolvedValue(true);

    await triggerCallback(subagent, seedResponder, "sess");

    const panel = seedResponder.editMessage.mock.calls[0]?.[0] as {
      buttons?: Array<Array<{ callback_data: string }>>;
    };
    const viewButton = panel.buttons
      ?.flat()
      .find((btn) => btn.callback_data.startsWith("sc:ss:vw:"));
    expect(viewButton).toBeDefined();
    const tokenPayload = viewButton!.callback_data.replace(/^sc:/, "");
    const token = tokenPayload.split(":")[2];
    expect(token).toBeTruthy();

    const respond = createResponder();
    await triggerCallback(subagent, respond, `ss:cp:${token}`);

    expect(mocks.gatewayRpcMock.compactSession).toHaveBeenCalledWith("agent:main:telegram:dm:42");
    const resultEdit = respond.editMessage.mock.calls[0]?.[0] as { text?: string };
    expect(resultEdit.text).toContain("壓縮工作階段");
    expect(resultEdit.text).toContain("已完成壓縮");
  });
});
