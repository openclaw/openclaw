import type { AcpRuntimeEvent, PluginLogger } from "openclaw/plugin-sdk/acpx";
import {
  CODEX_SDK_BACKEND_ID,
  type ResolvedCodexSdkPluginConfig,
  resolveCodexRouteForId,
} from "./config.js";
import { createCodexCompatibilityRecord } from "./doctor.js";
import { CodexSdkRuntime } from "./runtime.js";
import {
  FileCodexNativeStateStore,
  type CodexCompatibilityRecord,
  type CodexEventRecord,
  type CodexNativeStateStore,
  type CodexProposalRecord,
  type CodexSessionRecord,
} from "./state.js";

export type CodexNativeController = {
  config: ResolvedCodexSdkPluginConfig;
  stateStore: CodexNativeStateStore;
  runtime: CodexSdkRuntime;
  listRoutes(): CodexRouteSummary[];
  status(): Promise<CodexNativeStatus>;
  listSessions(limit?: number): Promise<CodexSessionRecord[]>;
  listEvents(sessionKey: string, limit?: number): Promise<CodexEventRecord[]>;
  exportSession(
    sessionKey: string,
    options?: CodexSessionExportOptions,
  ): Promise<CodexSessionExport>;
  listInbox(limit?: number): Promise<CodexProposalRecord[]>;
  updateInbox(
    id: string,
    status: CodexProposalRecord["status"],
  ): Promise<CodexProposalRecord | null>;
  createProposal(input: CodexProposalInput): Promise<CodexProposalRecord>;
  executeProposal(
    id: string,
    options?: CodexProposalExecutionOptions,
  ): Promise<CodexProposalExecutionResult>;
  doctor(record?: boolean): Promise<CodexCompatibilityRecord>;
};

export type CodexRouteSummary = {
  id: string;
  label: string;
  aliases: string[];
  model?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  webSearchMode?: string;
};

export type CodexNativeStatus = {
  backend: string;
  healthy: boolean;
  defaultRoute: string;
  routes: CodexRouteSummary[];
  sessions: CodexSessionRecord[];
  inbox: CodexProposalRecord[];
  backchannel: {
    enabled: boolean;
    server: string;
    gatewayUrlConfigured: boolean;
    stateDirConfigured: boolean;
    allowedMethods: string[];
    safeWriteMethods: string[];
    requireWriteToken: boolean;
    writeTokenEnv: string;
  };
};

export type CodexSessionExportOptions = {
  format?: "json" | "markdown";
  limit?: number;
};

export type CodexSessionExport = {
  sessionKey: string;
  format: "json" | "markdown";
  generatedAt: string;
  session: CodexSessionRecord | null;
  events: CodexEventRecord[];
  text: string;
};

export type CodexProposalExecutionOptions = {
  route?: string;
  cwd?: string;
  sessionKey?: string;
  mode?: "persistent" | "oneshot";
};

export type CodexProposalInput = {
  title: string;
  summary?: string;
  body?: string;
  actions?: string[];
  sessionKey?: string;
  routeId?: string;
  routeLabel?: string;
};

export type CodexProposalExecutionResult = {
  proposal: CodexProposalRecord;
  sessionKey: string;
  route: CodexRouteSummary;
  backendSessionId?: string;
  events: AcpRuntimeEvent[];
  text: string;
  completedAt: string;
};

export function createCodexNativeController(params: {
  config: ResolvedCodexSdkPluginConfig;
  stateDir: string;
  logger?: PluginLogger;
  stateStore?: CodexNativeStateStore;
  runtime?: CodexSdkRuntime;
  gatewayUrl?: string;
}): CodexNativeController {
  const stateStore =
    params.stateStore ??
    new FileCodexNativeStateStore({
      stateDir: params.stateDir,
      options: {
        maxEventsPerSession: params.config.maxEventsPerSession,
        proposalInboxLimit: params.config.proposalInboxLimit,
      },
    });
  const runtime =
    params.runtime ??
    new CodexSdkRuntime({
      config: params.config,
      logger: params.logger,
      stateStore,
      stateDir: params.stateDir,
      gatewayUrl: params.gatewayUrl,
    });
  const listRoutes = () =>
    Object.values(params.config.routes).map((route) => summarizeRoute(route, params.config));
  return {
    config: params.config,
    stateStore,
    runtime,
    listRoutes,
    async status() {
      return {
        backend: CODEX_SDK_BACKEND_ID,
        healthy: runtime.isHealthy(),
        defaultRoute: resolveCodexRouteForId(params.config.defaultRoute, params.config).label,
        routes: listRoutes(),
        sessions: await stateStore.listSessions(10),
        inbox: await stateStore.listProposals(10),
        backchannel: {
          enabled: params.config.backchannel.enabled,
          server: params.config.backchannel.name,
          gatewayUrlConfigured: Boolean(params.config.backchannel.gatewayUrl || params.gatewayUrl),
          stateDirConfigured: Boolean(params.stateDir),
          allowedMethods: params.config.backchannel.allowedMethods,
          safeWriteMethods: params.config.backchannel.safeWriteMethods,
          requireWriteToken: params.config.backchannel.requireWriteToken,
          writeTokenEnv: params.config.backchannel.writeTokenEnv,
        },
      };
    },
    async listSessions(limit) {
      return await stateStore.listSessions(limit);
    },
    async listEvents(sessionKey, limit) {
      return await stateStore.listEvents(sessionKey, limit);
    },
    async exportSession(sessionKey, options = {}) {
      const format = options.format === "json" ? "json" : "markdown";
      const events = await stateStore.listEvents(sessionKey, options.limit);
      const session = await stateStore.getSession(sessionKey);
      const generatedAt = new Date().toISOString();
      const payload = {
        sessionKey,
        generatedAt,
        session,
        events,
      };
      return {
        sessionKey,
        format,
        generatedAt,
        session,
        events,
        text: format === "json" ? JSON.stringify(payload, null, 2) : formatSessionMarkdown(payload),
      };
    },
    async listInbox(limit) {
      return await stateStore.listProposals(limit);
    },
    async updateInbox(id, status) {
      return await stateStore.updateProposalStatus(id, status);
    },
    async createProposal(input) {
      return await stateStore.createProposal(normalizeProposalInput(input));
    },
    async executeProposal(id, options = {}) {
      const proposal = await stateStore.getProposal(id);
      if (!proposal) {
        throw new Error(`Codex proposal not found: ${id}`);
      }
      const route = resolveCodexRouteForId(options.route ?? proposal.routeId, params.config);
      const sessionKey = options.sessionKey?.trim() || `codex:proposal:${id}:${Date.now()}`;
      const agent = route.aliases.find((alias) => params.config.allowedAgents.includes(alias));
      await stateStore.updateProposal(id, {
        status: "accepted",
        executionRouteId: route.id,
        executedSessionKey: sessionKey,
        lastExecutionError: undefined,
      });
      try {
        const handle = await runtime.ensureSession({
          sessionKey,
          agent: agent ?? route.aliases[0] ?? "codex",
          mode: options.mode ?? "oneshot",
          cwd: options.cwd ?? params.config.cwd,
        });
        const events: AcpRuntimeEvent[] = [];
        for await (const event of runtime.runTurn({
          handle,
          text: composeProposalExecutionPrompt(proposal),
          mode: "prompt",
          requestId: `codex-proposal:${id}:${Date.now()}`,
        })) {
          events.push(event);
        }
        const status = runtime.getStatus ? await runtime.getStatus({ handle }) : null;
        const completedAt = new Date().toISOString();
        const updated = await stateStore.updateProposal(id, {
          status: "accepted",
          executedAt: completedAt,
          executedSessionKey: sessionKey,
          executedThreadId: status?.backendSessionId,
          executionRouteId: route.id,
          lastExecutionError: undefined,
        });
        return {
          proposal: updated ?? proposal,
          sessionKey,
          route: summarizeRoute(route, params.config),
          ...(status?.backendSessionId ? { backendSessionId: status.backendSessionId } : {}),
          events,
          text: extractOutputText(events),
          completedAt,
        };
      } catch (error) {
        await stateStore.updateProposal(id, {
          executionRouteId: route.id,
          executedSessionKey: sessionKey,
          lastExecutionError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async doctor(record = false) {
      const compatibility = await createCodexCompatibilityRecord({
        config: params.config,
        stateStore,
        probeRuntime: () => runtime.probeAvailability(),
      });
      if (record) {
        await stateStore.writeCompatibilityRecord(compatibility);
      }
      return compatibility;
    },
  };
}

function summarizeRoute(
  route: CodexRouteSummary,
  config?: ResolvedCodexSdkPluginConfig,
): CodexRouteSummary {
  const model = route.model ?? config?.model;
  const modelReasoningEffort = route.modelReasoningEffort ?? config?.modelReasoningEffort;
  return {
    id: route.id,
    label: route.label,
    aliases: route.aliases,
    ...(model ? { model } : {}),
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...(route.sandboxMode ? { sandboxMode: route.sandboxMode } : {}),
    ...(route.approvalPolicy ? { approvalPolicy: route.approvalPolicy } : {}),
    ...(route.webSearchMode ? { webSearchMode: route.webSearchMode } : {}),
  };
}

function normalizeProposalInput(input: CodexProposalInput): CodexProposalInput {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Codex proposal title is required.");
  }
  const actions = (input.actions ?? [])
    .map((action) => action.trim())
    .filter((action) => action.length > 0);
  return {
    title,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(input.sessionKey?.trim() ? { sessionKey: input.sessionKey.trim() } : {}),
    ...(input.routeId?.trim() ? { routeId: input.routeId.trim() } : {}),
    ...(input.routeLabel?.trim() ? { routeLabel: input.routeLabel.trim() } : {}),
  };
}

function composeProposalExecutionPrompt(proposal: CodexProposalRecord): string {
  const sections = [
    "OpenClaw accepted this Codex proposal. Execute it now inside the current OpenClaw workspace.",
    `Proposal id: ${proposal.id}`,
    `Source session: ${proposal.sessionKey}`,
    `Title: ${proposal.title}`,
    proposal.summary ? `Summary: ${proposal.summary}` : "",
    proposal.body ? ["Body:", proposal.body].join("\n") : "",
    proposal.actions && proposal.actions.length > 0
      ? ["Actions:", ...proposal.actions.map((action) => `- ${action}`)].join("\n")
      : "",
    "Keep edits scoped to the proposal, use existing OpenClaw patterns, verify the result, and report touched files plus checks.",
  ].filter(Boolean);
  return sections.join("\n\n");
}

function extractOutputText(events: AcpRuntimeEvent[]): string {
  return events
    .filter(
      (event): event is Extract<AcpRuntimeEvent, { type: "text_delta" }> =>
        event.type === "text_delta" && event.stream !== "thought",
    )
    .map((event) => event.text)
    .join("\n")
    .trim();
}

function formatSessionMarkdown(params: {
  sessionKey: string;
  generatedAt: string;
  session: CodexSessionRecord | null;
  events: CodexEventRecord[];
}): string {
  const lines = [
    `# Codex Session ${params.sessionKey}`,
    "",
    `Generated: ${params.generatedAt}`,
    "",
  ];
  if (params.session) {
    lines.push(
      "## Session",
      "",
      `- Backend: ${params.session.backend}`,
      `- Route: ${params.session.routeLabel}`,
      ...(params.session.model ? [`- Model: ${params.session.model}`] : []),
      ...(params.session.modelReasoningEffort
        ? [`- Reasoning: ${params.session.modelReasoningEffort}`]
        : []),
      `- Agent: ${params.session.agent}`,
      `- Status: ${params.session.status}`,
      `- Turns: ${params.session.turnCount}`,
      ...(params.session.threadId ? [`- Thread: ${params.session.threadId}`] : []),
      ...(params.session.cwd ? [`- CWD: ${params.session.cwd}`] : []),
      "",
    );
  }
  lines.push("## Events", "");
  if (params.events.length === 0) {
    lines.push("No Codex events recorded.");
    return lines.join("\n");
  }
  for (const event of params.events) {
    lines.push(`### ${event.at} ${event.sdkEventType}`, "");
    for (const mapped of event.mappedEvents) {
      if (mapped.type === "text_delta") {
        lines.push(`- text: ${mapped.text}`);
      } else if (mapped.type === "status") {
        lines.push(`- status: ${mapped.text}`);
      } else if (mapped.type === "tool_call") {
        lines.push(`- tool: ${mapped.title ?? "tool"} - ${mapped.text}`);
      } else if (mapped.type === "error") {
        lines.push(`- error: ${mapped.message}`);
      } else if (mapped.type === "done") {
        lines.push(`- done: ${mapped.stopReason ?? "end_turn"}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
