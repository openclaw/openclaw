import type {
  SystemAgentChatQuestion,
  SystemAgentChatResult,
} from "../packages/gateway-protocol/src/index.js";
import type {
  SessionProcessSummary,
  SessionsProcessesListParams,
  SessionsProcessesListResult,
  SessionsProcessesStopParams,
  SessionsProcessesStopResult,
} from "../packages/gateway-protocol/src/schema/session-processes.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

// Serialized into the preview page; runtime dependencies must stay inside this function.
function installControlUiPreview(newAgentWelcome: string, processSessionKey: string): void {
  const previewWindow = window as Window & {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string };
    openclawControlUiE2eGateway?: ControlUiMockGateway;
  };
  // The WebSocket mock does not intercept HTTP. Select this origin before
  // application startup can send synthetic resources to the operator Gateway.
  const gatewayUrl = new URL(window.location.origin);
  gatewayUrl.protocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  gatewayUrl.pathname = "/__openclaw_mock_gateway__";
  previewWindow["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl: gatewayUrl.toString() };

  const gateway = previewWindow.openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Preview Gateway must be installed before its request handlers");
  }

  // Same synthetic examples as session-details-background-work.e2e.test.ts.
  // This page-local fixture never starts, polls, or kills an operating-system process.
  const processSession = gateway.getSessionRow(processSessionKey);
  const now = Date.now();
  const processes: SessionProcessSummary[] = [
    {
      processId: "dev-server",
      instanceId: "dev-server-1",
      name: "pnpm ui:dev --port 5173",
      status: "running",
      startedAt: now - 1_380_000,
      tail: "ready in 412 ms",
      truncated: false,
      canStop: true,
    },
    {
      processId: "watch-tests",
      instanceId: "watch-tests-1",
      name: "node scripts/run-vitest.mjs run ui/src/pages/chat",
      status: "running",
      startedAt: now - 74_000,
      tail: "",
      truncated: false,
      canStop: true,
    },
    {
      processId: "build",
      instanceId: "build-1",
      name: "pnpm ui:build",
      status: "completed",
      startedAt: now - 900_000,
      endedAt: now - 846_000,
      exitCode: 0,
      tail: "built in 53.2s",
      truncated: false,
      canStop: false,
    },
    {
      processId: "typecheck",
      instanceId: "typecheck-1",
      name: "pnpm tsgo:ui",
      status: "failed",
      startedAt: now - 820_000,
      endedAt: now - 790_000,
      exitCode: 2,
      tail: "error TS2322",
      truncated: false,
      canStop: false,
    },
  ];
  const processTarget = (input: SessionsProcessesListParams) => {
    const row = gateway.getSessionRow(input.key);
    const agentId = row.agentId ?? row.key.split(":")[1];
    if (!row.sessionId || (input.agentId && input.agentId !== agentId)) {
      return null;
    }
    return {
      sessionId: row.sessionId,
      processes:
        row.key === processSession.key && row.sessionId === processSession.sessionId
          ? processes
          : [],
      truncated: false,
    } satisfies SessionsProcessesListResult;
  };
  const processTargetError = {
    __mockError: { code: "INVALID_REQUEST", message: "Session process fixture scope changed." },
  };
  gateway.setRequestHandler("sessions.processes.list", ({ params, respond }) => {
    respond(processTarget(params as SessionsProcessesListParams) ?? processTargetError);
  });
  gateway.setRequestHandler("sessions.processes.stop", ({ params, respond }) => {
    const input = params as SessionsProcessesStopParams;
    const target = processTarget(input);
    if (!target || input.sessionId !== target.sessionId) {
      respond(processTargetError);
      return;
    }
    const row = target.processes.find(
      (candidate) =>
        candidate.processId === input.processId && candidate.instanceId === input.instanceId,
    );
    const requested = row?.status === "running" && row.canStop;
    if (requested && row) {
      row.status = "killed";
      row.canStop = false;
      row.endedAt = Date.now();
      row.exitSignal = "SIGTERM";
    }
    respond({ requested } satisfies SessionsProcessesStopResult);
  });

  gateway.setRequestHandler("chat.send", ({ params, respond, emit }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const runId =
      typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
        ? input.idempotencyKey
        : "control-ui-mock-run";
    const sessionKey =
      typeof input.sessionKey === "string" && input.sessionKey.trim()
        ? input.sessionKey
        : "agent:main:main";
    const message = typeof input.message === "string" ? input.message.trim() : "";
    window.setTimeout(() => {
      respond({ runId, status: "started" });
      // The client must observe admission before the final event for this run.
      window.setTimeout(
        () =>
          emit("chat", {
            message: {
              content: [{ text: `Mock reply: ${message || "message received"}`, type: "text" }],
              role: "assistant",
              timestamp: Date.now(),
            },
            runId,
            seq: 1,
            sessionKey,
            state: "final",
          }),
        0,
      );
    }, 200);
  });

  const sessionTurns = new Map<string, number>();
  const channelQuestion = {
    id: "mock-channel-choice",
    header: "Channel setup",
    question: "Which channel would you like to work on?",
    options: [
      {
        label: "WhatsApp",
        reply: "help me connect WhatsApp",
        description: "Review linking and account status.",
        recommended: true,
      },
      {
        label: "Telegram",
        reply: "help me connect Telegram",
        description: "Review the bot token and delivery status.",
      },
      {
        label: "Discord",
        reply: "help me connect Discord",
        description: "Review the bot and server connection.",
      },
    ],
    isOther: true,
  } satisfies SystemAgentChatQuestion;
  gateway.setRequestHandler("openclaw.chat", ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const sessionId =
      typeof input.sessionId === "string" && input.sessionId.trim()
        ? input.sessionId
        : "control-ui-custodian-mock";
    const message = typeof input.message === "string" ? input.message : undefined;
    const turn = sessionTurns.get(sessionId) ?? 0;
    sessionTurns.set(sessionId, turn + 1);
    const response: SystemAgentChatResult = message
      ? message.toLowerCase().includes("channel")
        ? {
            sessionId,
            reply: "I can help with that.\n\nChoose a channel to continue.",
            action: "none",
            question: channelQuestion,
          }
        : {
            sessionId,
            reply: `I checked the mock system. Everything looks healthy.\n\nThat was demo turn ${turn}.`,
            action: "none",
          }
      : {
          sessionId,
          reply:
            input.welcomeVariant === "new-agent"
              ? newAgentWelcome
              : "Hi — I’m OpenClaw, your system caretaker.\n\nAsk me about setup, channels, or recent changes.",
          action: "none",
        };
    window.setTimeout(() => respond(response), message === undefined ? 0 : 600);
  });
}

export function createControlUiPreviewInitScript(
  newAgentWelcome: string,
  processSessionKey: string,
): string {
  return `(() => { const __name = (target) => target; (${installControlUiPreview.toString()})(${JSON.stringify(newAgentWelcome)}, ${JSON.stringify(processSessionKey)}); })();`;
}
