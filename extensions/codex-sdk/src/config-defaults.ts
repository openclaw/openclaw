import type { CodexSandboxMode, ResolvedCodexRouteConfig } from "./config-types.js";

export const DEFAULT_SANDBOX_MODE: CodexSandboxMode = "workspace-write";
export const DEFAULT_MAX_EVENTS_PER_SESSION = 400;
export const DEFAULT_PROPOSAL_INBOX_LIMIT = 200;

export const DEFAULT_CODEX_BACKCHANNEL_READ_METHODS = [
  "health",
  "status",
  "models.list",
  "tools.catalog",
  "agents.list",
  "agent.identity.get",
  "skills.status",
  "sessions.list",
  "sessions.get",
  "sessions.preview",
  "sessions.resolve",
  "sessions.usage",
  "chat.history",
  "config.get",
  "config.schema.lookup",
  "codex.status",
  "codex.routes",
  "codex.sessions",
  "codex.events",
  "codex.session.export",
  "codex.inbox",
  "codex.doctor",
] as const;

export const DEFAULT_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS = [
  "codex.proposal.create",
  "codex.proposal.update",
] as const;

export const DEFAULT_CODEX_BACKCHANNEL_ALLOWED_METHODS = [
  ...DEFAULT_CODEX_BACKCHANNEL_READ_METHODS,
  ...DEFAULT_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS,
] as const;

export const DEFAULT_CODEX_BACKCHANNEL_NAME = "openclaw-codex";
export const DEFAULT_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CODEX_BACKCHANNEL_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export const DEFAULT_CODEX_ROUTES: Record<string, ResolvedCodexRouteConfig> = {
  default: {
    id: "default",
    label: "codex/default",
    aliases: ["codex", "codex-default"],
    instructions:
      "You are Codex running as OpenClaw's native coding runtime. Keep OpenClaw session continuity, tool evidence, and operator handoff in mind. Use the OpenClaw MCP backchannel when available: openclaw_status for live OpenClaw context, openclaw_proposal for follow-up work, and openclaw_gateway_request only for allowed Gateway methods. When useful follow-up work should be tracked outside this turn, emit an openclaw-proposal JSON code block or call openclaw_proposal.",
  },
  fast: {
    id: "fast",
    label: "codex/fast",
    aliases: ["codex-fast"],
    modelReasoningEffort: "low",
    instructions:
      "Use the Codex fast route: optimize for quick, targeted edits and concise status. Avoid broad refactors unless the task clearly needs them.",
  },
  deep: {
    id: "deep",
    label: "codex/deep",
    aliases: ["codex-deep"],
    modelReasoningEffort: "high",
    instructions:
      "Use the Codex deep route: inspect architecture carefully, preserve existing boundaries, and carry complex work through verification.",
  },
  review: {
    id: "review",
    label: "codex/review",
    aliases: ["codex-review"],
    modelReasoningEffort: "high",
    approvalPolicy: "on-request",
    instructions:
      "Use the Codex review route: take a code-review stance. Lead with concrete findings and file references, then summarize residual risk.",
  },
  test: {
    id: "test",
    label: "codex/test",
    aliases: ["codex-test"],
    modelReasoningEffort: "medium",
    instructions:
      "Use the Codex test route: reproduce failures, add focused regression coverage, keep diagnostics clear, and finish with exact verification commands.",
  },
  refactor: {
    id: "refactor",
    label: "codex/refactor",
    aliases: ["codex-refactor"],
    modelReasoningEffort: "high",
    instructions:
      "Use the Codex refactor route: preserve behavior, keep changes incremental, respect existing module boundaries, and verify affected call paths.",
  },
  docs: {
    id: "docs",
    label: "codex/docs",
    aliases: ["codex-docs"],
    modelReasoningEffort: "low",
    instructions:
      "Use the Codex docs route: update public-facing docs and examples with precise commands, current OpenClaw terminology, and no unrelated code churn.",
  },
  ship: {
    id: "ship",
    label: "codex/ship",
    aliases: ["codex-ship"],
    modelReasoningEffort: "high",
    instructions:
      "Use the Codex ship route: finish production-ready work end to end, include focused tests, run the strongest practical verification, and leave a concise release note.",
  },
  worker: {
    id: "worker",
    label: "codex/worker",
    aliases: ["codex-worker"],
    modelReasoningEffort: "medium",
    instructions:
      "Use the Codex worker route: make bounded production changes, list touched files, and avoid unrelated churn.",
  },
};
