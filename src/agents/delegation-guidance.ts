import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import type { SubagentDelegationMode } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronSessionKey, parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

export function resolveMainSessionDelegationMode(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): SubagentDelegationMode {
  const { config, agentId, sessionKey } = params;
  const agentSubagents =
    config && agentId ? resolveAgentConfig(config, agentId)?.subagents : undefined;
  const configuredMode =
    agentSubagents?.delegationMode ?? config?.agents?.defaults?.subagents?.delegationMode;
  if (configuredMode) {
    return configuredMode;
  }
  const baseSessionKey = parseCronRunScopeSuffix(sessionKey).baseSessionKey;
  if (
    agentId !== undefined &&
    baseSessionKey !== undefined &&
    baseSessionKey ===
      resolveCanonicalMainSessionKey({
        agentId,
        mainKey: config?.session?.mainKey,
        sessionScope: config?.session?.scope,
      })
  ) {
    return "prefer";
  }
  return "suggest";
}

export function buildSubagentPromptGuidance(params: {
  mode: SubagentDelegationMode;
  isMinimal: boolean;
  availableTools: ReadonlySet<string>;
  sessionKey?: string;
  resolveToolName: (normalized: string) => string;
}) {
  const { availableTools } = params;
  const hasSessionsSpawn = availableTools.has("sessions_spawn");
  const hasSessionsYield = availableTools.has("sessions_yield");
  const inTurnCollectionGuidance = isCronSessionKey(params.sessionKey)
    ? [
        "Isolated automation: child completion will not resume this turn.",
        availableTools.has("agents_wait")
          ? "If you need child results to finish the job, spawn with `collect=true` and wait with `agents_wait` in this turn before replying."
          : "If you need child results to finish the job, complete that work directly in this turn; explicit child collection is unavailable.",
        hasSessionsYield
          ? "Fire-and-forget is valid when child output is the deliverable. `sessions_yield` ends this turn; the scheduler delivers that output."
          : "Fire-and-forget is valid when child output is the deliverable.",
      ].join(" ")
    : undefined;
  return {
    inTurnCollectionGuidance,
    delegationSection: buildDelegationGuidanceSection({
      mode: params.mode,
      isMinimal: params.isMinimal,
      hiddenDelegationTool: hasSessionsSpawn ? "`sessions_spawn`" : "",
      hasVisibleSessionSpawn: hasSessionsSpawn,
      hasSessionsYield,
      inTurnCollectionGuidance,
      hasSubagentsList: availableTools.has("subagents"),
      hasSessionsSend: availableTools.has("sessions_send"),
      sessionsCreateToolName: availableTools.has("sessions_create")
        ? params.resolveToolName("sessions_create")
        : undefined,
      suggestTaskToolName: availableTools.has("suggest_task")
        ? params.resolveToolName("suggest_task")
        : undefined,
    }),
  };
}

export function buildDelegationGuidanceSection(params: {
  mode: SubagentDelegationMode;
  isMinimal: boolean;
  hiddenDelegationTool: string;
  hasVisibleSessionSpawn: boolean;
  hasSessionsYield: boolean;
  inTurnCollectionGuidance?: string;
  hasSubagentsList: boolean;
  hasSessionsSend: boolean;
  sessionsCreateToolName?: string;
  suggestTaskToolName?: string;
}): string[] {
  if (params.isMinimal) {
    return [];
  }
  const hiddenDelegationTool = params.hiddenDelegationTool.trim();
  const createToolName = params.sessionsCreateToolName;
  const sessionRouting =
    createToolName || params.suggestTaskToolName
      ? [
          "## Session routing",
          createToolName
            ? `- Explicit requests to start/create a session or task, including "spin up a new task", use \`${createToolName}\`. Supply \`message\` to start work; omit it to create an idle session. This is a normal, independent, persistent visible session, not a supervised child: no completion event or yield expectation.`
            : "",
          hiddenDelegationTool
            ? `- Actual delegated helpers use ${hiddenDelegationTool}; use hidden children by default.`
            : "",
          params.hasVisibleSessionSpawn
            ? "- `sessions_spawn` with `visible=true` is for deliberately supervised child work the user needs to revisit or steer, not ordinary independent session creation."
            : "",
          params.suggestTaskToolName
            ? `- Proactive, unrequested follow-up proposals use \`${params.suggestTaskToolName}\`: record a suggestion card; nothing starts until the user accepts. An explicit request to start work is not a proposal.`
            : "",
        ].filter(Boolean)
      : [];
  if (params.mode !== "prefer" || (!hiddenDelegationTool && !params.hasVisibleSessionSpawn)) {
    return sessionRouting;
  }
  return [
    ...sessionRouting,
    "## Delegation",
    "Stay responsive: incoming messages wait on your current turn.",
    "- Answer directly: chat, known answers, quick lookups.",
    hiddenDelegationTool
      ? `- Multi-step or slow work (investigation, coding, shell/browser, long reads, waits): delegate via ${hiddenDelegationTool}; brief each child with objective, output, write scope, verification.`
      : "",
    hiddenDelegationTool
      ? "- Use subagents for internal QA, research, coding, review, and test lanes; keep their results in the parent task. A PR/report, long runtime, or isolated worktree alone does not justify a sidebar session."
      : "",
    params.hasVisibleSessionSpawn
      ? "- For deliberately supervised child work the user needs to revisit or steer, spawn `sessions_spawn` with `visible=true` (persistent, in the user's sidebar); reply with the link. A request to use subagents does not request separate sessions."
      : "",
    params.inTurnCollectionGuidance
      ? ""
      : `- Announcing spawns notify when the run ends; later turns in a kept OpenClaw session do not report back${params.hasSessionsSend ? "; follow up via `sessions_send`." : "."}`,
    "- A child run ending does not end the user's delegated goal. Compare its result with the requested outcome; reviews, failing checks, and other in-scope fixable blockers are continuation work.",
    params.hasSessionsSend
      ? "- When a kept OpenClaw session stops before the requested outcome, continue it with `sessions_send`; finish only after verifying the outcome, or when progress needs new user authority or an unavailable external decision."
      : "- Finish only after verifying the requested outcome, or when progress needs new user authority or an unavailable external decision.",
    params.inTurnCollectionGuidance
      ? `- ${params.inTurnCollectionGuidance}`
      : params.hasSessionsYield
        ? "- Need announced results before reply: `sessions_yield`; never busy-poll. Collectors require explicit result collection instead."
        : "- Announced completion is push-based; collectors require explicit result collection. Never busy-poll.",
    "- Child output is a report to synthesize.",
    "- Keep inter-worker coordination in the parent. Children return findings through their accepted completion path; do not ask them to contact other sessions or use CLI/RPC messaging.",
    params.hasSubagentsList ? "- `subagents(action=list)` only for requested status/debug." : "",
    "",
  ].filter(Boolean);
}
