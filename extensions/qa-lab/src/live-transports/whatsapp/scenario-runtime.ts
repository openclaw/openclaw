import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { buildLiveTransportRttResult } from "../shared/live-transport-rtt.js";
import type { WhatsAppQaScenarioEnvironment } from "./scenario-environment.js";
import { runWhatsAppApprovalScenario } from "./whatsapp-live.approvals.js";
import {
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaScenarioTarget,
  type WhatsAppQaMessageScenarioContext,
  type WhatsAppQaScenarioRun,
} from "./whatsapp-live.contracts.js";
import {
  WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS,
  isTransientWhatsAppQaDriverError,
  resolveWhatsAppQaNoReplyTarget,
  restartWhatsAppQaDriverSession,
  waitForNoWhatsAppReply,
} from "./whatsapp-live.driver.js";
import {
  assertWhatsAppScenarioMessageBatch,
  messageMatches,
  waitForScenarioObservedMessage,
} from "./whatsapp-live.observations.js";
import { waitForWhatsAppChannelStable } from "./whatsapp-live.setup.js";

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
    const approval = await runWhatsAppApprovalScenario({
      driver,
      gateway: params.environment.gateway as never,
      observedMessages: params.environment.observedMessages,
      run: scenarioRun,
      scenario,
      sutAccountId: params.environment.sutAccountId,
      sutPhoneE164: runtimeEnv.sutPhoneE164,
      turnSourceTo: approvalTurnSourceTo,
    });
    return {
      details: `${scenarioRun.approvalKind} approval ${approval.approvalId} resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
      ...buildLiveTransportRttResult(approval, "approval-request-to-resolution"),
    };
  }
  if (scenarioRun.quietInput !== undefined) {
    const quietStartedAt = new Date();
    const quietSendMode = scenarioRun.quietSendMode ?? scenarioRun.sendMode;
    if (quietSendMode?.kind === "media") {
      await driver.sendMedia(
        target,
        scenarioRun.quietInput,
        quietSendMode.mediaBuffer,
        quietSendMode.mediaType,
        { fileName: quietSendMode.fileName },
      );
    } else {
      await driver.sendText(target, scenarioRun.quietInput);
    }
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
      ...resolveWhatsAppQaNoReplyTarget({
        groupJid: runtimeEnv.groupJid,
        target: scenarioRun.target,
      }),
    });
    await waitForWhatsAppChannelStable(
      params.environment.gateway as never,
      params.environment.sutAccountId,
    );
  }
  const requestStartedAt = new Date();
  const sent =
    scenarioRun.sendMode?.kind === "media"
      ? await driver.sendMedia(
          target,
          scenarioRun.input,
          scenarioRun.sendMode.mediaBuffer,
          scenarioRun.sendMode.mediaType,
          { fileName: scenarioRun.sendMode.fileName },
        )
      : await driver.sendText(target, scenarioRun.input);
  const scenarioContext: WhatsAppQaMessageScenarioContext = {
    driver,
    driverPhoneE164: runtimeEnv.driverPhoneE164,
    gateway: params.environment.gateway as never,
    gatewayTarget: targets?.gatewayTarget ?? runtimeEnv.driverPhoneE164,
    gatewayWorkspaceDir: params.environment.gateway.workspaceDir,
    recordObservedMessage: (message) => {
      params.environment.observedMessages.push({
        ...message,
        matchedScenario: true,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
      });
    },
    requestStartedAt,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
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
      ...resolveWhatsAppQaNoReplyTarget({
        groupJid: runtimeEnv.groupJid,
        target: scenarioRun.target,
      }),
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
    alreadyRecordedMessageIds: new Set(reply.messageId ? [reply.messageId] : []),
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
        id: scenario.id,
        title: scenario.title,
        posture: implementation.posture,
        status: "pass" as const,
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
