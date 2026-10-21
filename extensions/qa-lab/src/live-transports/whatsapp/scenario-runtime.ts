import { randomUUID } from "node:crypto";
import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import {
  requestLiveQaApproval,
  resolveLiveQaApprovalDecision,
  waitForLiveQaApprovalDecision,
} from "../shared/live-approval-request.js";
import { assertApprovalDecisionResult } from "../shared/live-approval-result.js";
import { buildLiveTransportRttResult } from "../shared/live-transport-rtt.js";
import type { WhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import {
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaScenarioTarget,
  type WhatsAppQaMessageScenarioContext,
  type WhatsAppQaMessageScenarioRun,
  type WhatsAppQaScenarioRun,
} from "./whatsapp-live.contracts.js";
import {
  WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS,
  isTransientWhatsAppQaDriverError,
  restartWhatsAppQaDriverSession,
  waitForNoWhatsAppReply,
} from "./whatsapp-live.driver.js";
import {
  assertWhatsAppScenarioMessageBatch,
  formatDiagnosticId,
  messageMatches,
  waitForScenarioObservedMessage,
  waitForWhatsAppObservedMessage,
} from "./whatsapp-live.observations.js";
import { waitForWhatsAppChannelStable } from "./whatsapp-live.setup.js";

const WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS = 60_000;

async function runWhatsAppScenarioAttempt(params: {
  environment: WhatsAppQaScenarioEnvironment;
  run: WhatsAppQaScenarioRun;
}) {
  const driver = params.environment.getDriver();
  const { runtimeEnv, scenario } = params.environment;
  const scenarioRun = params.run;
  const resolvedTarget = resolveWhatsAppQaScenarioTarget({
    groupJid: runtimeEnv.groupJid,
    scenarioId: scenario.id,
    target: scenarioRun.kind === "approval" ? (scenarioRun.target ?? "dm") : scenarioRun.target,
  });
  const targets =
    scenarioRun.kind !== "approval"
      ? resolveWhatsAppQaMessageTargets({
          driverPhoneE164: runtimeEnv.driverPhoneE164,
          groupJid: runtimeEnv.groupJid,
          scenarioTarget: scenarioRun.target,
          sutPhoneE164: runtimeEnv.sutPhoneE164,
        })
      : undefined;
  const target = targets?.driverTarget ?? runtimeEnv.sutPhoneE164;
  const approvalTurnSourceTo =
    scenarioRun.kind === "approval" && resolvedTarget.target === "group"
      ? resolvedTarget.groupJid
      : runtimeEnv.driverPhoneE164;
  if (scenarioRun.kind === "approval") {
    const gateway = params.environment.gateway;
    const sutAccountId = params.environment.sutAccountId;
    const sutPhoneE164 = runtimeEnv.sutPhoneE164;
    const requestStartedAt = new Date();
    const requestedApprovalId =
      scenarioRun.approvalKind === "exec"
        ? `whatsapp-qa-exec-${randomUUID()}`
        : `whatsapp-qa-plugin-${randomUUID()}`;
    const approvalId = await requestLiveQaApproval({
      approvalId: requestedApprovalId,
      gateway,
      turnSourceTo: approvalTurnSourceTo,
      approvalKind: scenarioRun.approvalKind,
      channel: "whatsapp",
      timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS,
      token: scenarioRun.token,
      sutAccountId,
    });
    const approvalKind = scenarioRun.approvalKind;
    const requestedDecision = scenarioRun.decision;
    const timeoutMs = scenario.timeoutMs;
    const token = scenarioRun.token;
    async function waitForWhatsAppApprovalMessage(state: "pending" | "resolved") {
      function matchesWhatsAppApprovalText(text: string) {
        if (state === "pending") {
          const heading =
            approvalKind === "exec" ? "Exec approval required" : "Plugin approval required";
          return (
            text.includes(heading) &&
            text.includes(approvalId) &&
            text.includes(token) &&
            text.includes("React with:") &&
            text.includes("👍")
          );
        }
        const decision = requestedDecision ?? "allow-once";
        const decisionText =
          approvalKind === "exec"
            ? decision
            : decision === "allow-once"
              ? "allowed once"
              : "denied";
        const heading =
          approvalKind === "exec"
            ? `Exec approval ${decisionText}`
            : `Plugin approval ${decisionText}`;
        return text.includes(approvalId) && text.includes(heading);
      }
      return await waitForWhatsAppObservedMessage(
        driver,
        {
          observedAfter: requestStartedAt,
          timeoutMs,
          match: (message) => {
            const fromExpectedSender =
              !message.fromPhoneE164 || message.fromPhoneE164 === sutPhoneE164;
            return fromExpectedSender && matchesWhatsAppApprovalText(message.text);
          },
        },
        () => {
          const lowerBoundMs = requestStartedAt.getTime();
          const messages = driver
            .getObservedMessages()
            .filter((message) => new Date(message.observedAt).getTime() >= lowerBoundMs);
          if (messages.length === 0) {
            return `observed 0 WhatsApp driver message(s) after ${state} approval wait lower bound`;
          }
          const formatted = messages.slice(-5).map((message, index) => {
            const fromExpectedSender =
              !message.fromPhoneE164 || message.fromPhoneE164 === sutPhoneE164;
            const approvalTextMatches = matchesWhatsAppApprovalText(message.text);
            return [
              `#${index + 1}`,
              `observedAt=${message.observedAt}`,
              `fromExpectedSut=${fromExpectedSender ? "yes" : "no"}`,
              `fromPhone=${message.fromPhoneE164 ? "present" : "missing"}`,
              `kind=${message.kind}`,
              `textLength=${message.text.length}`,
              `approvalText=${approvalTextMatches ? "yes" : "no"}`,
              `messageId=${formatDiagnosticId(message.messageId)}`,
            ].join(" ");
          });
          return `observed ${messages.length} WhatsApp driver message(s) after ${state} approval wait lower bound: ${formatted.join("; ")}`;
        },
      );
    }
    const pending = await waitForWhatsAppApprovalMessage("pending");
    const resolvedPromise = waitForWhatsAppApprovalMessage("resolved");
    try {
      if (scenarioRun.decisionMode === "reaction") {
        if (!pending.fromJid || !pending.messageId) {
          throw new Error("WhatsApp approval prompt did not expose message coordinates.");
        }
        await driver.sendReaction(pending.fromJid, pending.messageId, "👍", {
          fromMe: false,
          participant: pending.participantJid,
        });
      } else {
        await resolveLiveQaApprovalDecision({
          approvalId,
          decision: scenarioRun.decision,
          gateway,
          kind: scenarioRun.approvalKind,
          timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
        });
      }
      assertApprovalDecisionResult({
        decision: scenarioRun.decision,
        result: await waitForLiveQaApprovalDecision({
          approvalId,
          gateway,
          kind: scenarioRun.approvalKind,
          timeoutMs: WHATSAPP_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
        }),
      });
    } catch (error) {
      resolvedPromise.catch(() => {});
      throw error;
    }
    const resolved = await resolvedPromise;
    const responseObservedAt = new Date(resolved.observedAt);
    const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
    return {
      details: `${scenarioRun.approvalKind} approval ${approvalId} resolved ${scenarioRun.decision} in ${rttMs}ms`,
      ...buildLiveTransportRttResult(
        { requestStartedAt, responseObservedAt, rttMs },
        "approval-request-to-resolution",
      ),
    };
  }
  const send = (text: string, mode: WhatsAppQaMessageScenarioRun["sendMode"]) =>
    mode?.kind === "media"
      ? driver.sendMedia(target, text, mode.mediaBuffer, mode.mediaType, {
          fileName: mode.fileName,
        })
      : driver.sendText(target, text);
  if (scenarioRun.quietInput !== undefined) {
    const quietStartedAt = new Date();
    await send(scenarioRun.quietInput, scenarioRun.quietSendMode ?? scenarioRun.sendMode);
    await waitForNoWhatsAppReply({
      ...(scenarioRun.quietMatchText
        ? {
            allowQuietWindowMessage: (message: WhatsAppQaDriverObservedMessage) =>
              !messageMatches(message, scenarioRun.quietMatchText!),
          }
        : {}),
      driver,
      observedAfter: quietStartedAt,
      sutPhoneE164: runtimeEnv.sutPhoneE164,
      windowMs: scenarioRun.quietWindowMs ?? 5_000,
      ...resolvedTarget,
    });
    await waitForWhatsAppChannelStable(
      params.environment.gateway as never,
      params.environment.sutAccountId,
    );
  }
  const requestStartedAt = new Date();
  const sent = await send(scenarioRun.input, scenarioRun.sendMode);
  const scenarioContext: WhatsAppQaMessageScenarioContext = {
    driver,
    driverPhoneE164: runtimeEnv.driverPhoneE164,
    gateway: params.environment.gateway as never,
    gatewayTarget: targets?.gatewayTarget ?? runtimeEnv.driverPhoneE164,
    gatewayWorkspaceDir: params.environment.gateway.workspaceDir,
    requestStartedAt,
    scenarioId: scenario.id,
    sent,
    sutAccountId: params.environment.sutAccountId,
    sutPhoneE164: runtimeEnv.sutPhoneE164,
    target,
    targetKind: scenarioRun.target,
  };
  const afterSendDetails = await scenarioRun.afterSend?.(scenarioContext);
  if (!scenarioRun.expectReply) {
    await waitForNoWhatsAppReply({
      allowQuietWindowMessage: (message) =>
        scenarioRun.allowQuietWindowMessage?.(message, scenarioContext) ?? false,
      driver,
      observedAfter: requestStartedAt,
      sutPhoneE164: runtimeEnv.sutPhoneE164,
      windowMs: scenarioRun.quietWindowMs ?? scenario.timeoutMs,
      ...resolvedTarget,
    });
    return {
      details: ["no reply", afterSendDetails].filter(Boolean).join("; "),
    };
  }
  const reply = await waitForScenarioObservedMessage(scenarioContext, {
    observedAfter: requestStartedAt,
    timeoutMs: scenario.timeoutMs,
    match: (message) => messageMatches(message, scenarioRun.matchText),
  });
  scenarioRun.verify?.(reply, scenarioContext);
  const afterReplyDetails = await scenarioRun.afterReply?.(reply, scenarioContext);
  const batchDetails = await assertWhatsAppScenarioMessageBatch({
    context: scenarioContext,
    observedAfter: requestStartedAt,
    run: scenarioRun,
  });
  const responseObservedAt = new Date(reply.observedAt);
  const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
  return {
    details: [`reply matched in ${rttMs}ms`, afterSendDetails, afterReplyDetails, batchDetails]
      .filter(Boolean)
      .join("; "),
    ...buildLiveTransportRttResult(
      { requestStartedAt, responseObservedAt, rttMs },
      "request-to-observed-message",
    ),
  };
}

export async function runWhatsAppScenario(environment: WhatsAppQaScenarioEnvironment) {
  const scenario = environment.scenario;
  if (!environment.preparedScenario) {
    throw new Error(`WhatsApp scenario ${scenario.id} has no prepared implementation`);
  }
  const { implementation, run: configuredRun } = environment.preparedScenario;
  for (let attempt = 1; attempt <= WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS; attempt += 1) {
    try {
      // Retry with fresh markers and callback state while retaining the gateway config
      // prepared from the equivalent first run.
      const run = attempt === 1 ? configuredRun : implementation.buildRun();
      const result = await runWhatsAppScenarioAttempt({
        environment,
        run,
      });
      return {
        ...result,
        details:
          attempt === 1 ? result.details : `${result.details}; driver reconnected ${attempt - 1}x`,
      };
    } catch (error) {
      if (
        attempt >= WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS ||
        !isTransientWhatsAppQaDriverError(error)
      ) {
        throw error;
      }
      const nextDriver = await restartWhatsAppQaDriverSession({
        authDir: environment.driverAuthDir,
        current: environment.getDriver(),
      });
      await environment.replaceDriver(nextDriver);
    }
  }
  throw new Error(`WhatsApp scenario ${scenario.id} exhausted driver retries`);
}
