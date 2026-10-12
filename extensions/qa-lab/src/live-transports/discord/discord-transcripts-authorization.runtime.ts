import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requestDiscord } from "@openclaw/discord/api.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { assertLiveScenarioReply as assertDiscordScenarioReply } from "../shared/live-scenario-reply.js";
import {
  type DiscordQaScenarioImplementation,
  pollChannelMessages,
  sendChannelMessage,
  getCurrentDiscordVoiceState,
  matchesDiscordScenarioReply,
  waitForDiscordVoiceState,
} from "./discord-live.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";

export const discordQaTranscriptsVoiceAuthorizationScenario: DiscordQaScenarioImplementation = {
  buildRun: () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    return {
      kind: "transcripts-voice-authorization",
      deniedSessionId: `discord-qa-transcript-denied-${suffix}`,
      allowedSessionId: `discord-qa-transcript-allowed-${suffix}`,
      negativeMarker: `DISCORD_QA_TRANSCRIPT_NEGATIVE_${suffix}`,
      positiveMarker: `DISCORD_QA_TRANSCRIPT_POSITIVE_${suffix}`,
      stopMarker: `DISCORD_QA_TRANSCRIPT_STOP_${suffix}`,
    };
  },
};

type CreatedDiscordMessage = {
  messageId: string;
  token: string;
};

type TranscriptAuthorizationEvidence = {
  schemaVersion: 1;
  scenarioId: string;
  denied: {
    replyObserved: boolean;
    visibleDenial: boolean;
    voiceStayedDisconnected: boolean;
  };
  allowed: {
    replyObserved: boolean;
    voiceJoined: boolean;
  };
  cleanup: {
    emergencyStopAttempted: boolean;
    messagesDeleted: number;
    messageDeleteFailures: number;
    stopReplyObserved: boolean;
    voiceDisconnected: boolean;
  };
};

const VISIBLE_DENIAL_RE = /\b(?:denied|not allowlisted|not authorized|unauthorized)\b/iu;

async function waitForDiscordVoiceDisconnect(params: {
  channelId: string;
  guildId: string;
  timeoutMs: number;
  token: string;
}) {
  const startedAt = Date.now();
  let lastChannelId: string | null | undefined;
  let lastError: string | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const state = await getCurrentDiscordVoiceState({
        token: params.token,
        guildId: params.guildId,
      });
      lastChannelId = state?.channel_id;
      lastError = undefined;
      if (lastChannelId !== params.channelId) {
        return state;
      }
    } catch (error) {
      lastError = formatErrorMessage(error);
    }
    await sleep(500);
  }
  throw new Error(
    `SUT bot did not leave Discord voice channel ${params.channelId} (last channel=${lastChannelId ?? "none"}${
      lastError ? `; last error: ${lastError}` : ""
    })`,
  );
}

async function deleteScenarioMessages(params: {
  channelId: string;
  messages: readonly CreatedDiscordMessage[];
}) {
  let deleted = 0;
  let failures = 0;
  for (const message of params.messages.toReversed()) {
    try {
      await requestDiscord<void>(
        `/channels/${params.channelId}/messages/${message.messageId}`,
        message.token,
        { method: "DELETE", timeoutMs: 15_000 },
      );
      deleted += 1;
    } catch {
      failures += 1;
    }
  }
  return { deleted, failures };
}

async function writeTranscriptAuthorizationEvidence(params: {
  evidence: TranscriptAuthorizationEvidence;
  outputDir: string;
}) {
  const evidencePath = path.join(params.outputDir, `${params.evidence.scenarioId}-evidence.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return evidencePath;
}

export async function runDiscordTranscriptsVoiceAuthorizationScenario(
  environment: DiscordQaScenarioEnvironment,
  configured: Awaited<ReturnType<DiscordQaScenarioEnvironment["configureScenario"]>>,
) {
  const { run, voiceChannel, configureTranscriptVoiceAccess } = configured;
  if (
    run.kind !== "transcripts-voice-authorization" ||
    !voiceChannel ||
    !configureTranscriptVoiceAccess
  ) {
    throw new Error("Discord transcript authorization scenario was not configured.");
  }
  const runtimeEnv = environment.runtimeEnv;
  const phaseTimeoutMs = Math.max(15_000, Math.floor(environment.scenario.timeoutMs / 3));
  const createdMessages: CreatedDiscordMessage[] = [];
  const voice = {
    token: runtimeEnv.sutBotToken,
    guildId: runtimeEnv.guildId,
    channelId: voiceChannel.id,
  };
  const sendTranscriptPrompt = async (
    action: "start" | "stop",
    sessionId: string,
    marker: string,
    timeoutMs = phaseTimeoutMs,
  ) => {
    const prompt = [
      `<@${runtimeEnv.sutApplicationId}> Transcript ${action === "start" ? "authorization" : "cleanup"} QA.`,
      "Call the transcripts tool exactly once with these arguments:",
      JSON.stringify({
        action,
        ...(action === "start" ? { providerId: "discord-voice" } : {}),
        sessionId,
        ...(action === "start" ? { guildId: voice.guildId, channelId: voice.channelId } : {}),
      }),
      `After the tool returns, begin your reply with ${marker}.`,
      "If the tool failed, include its error verbatim. Do not claim success after a failure.",
    ].join(" ");
    const sent = await sendChannelMessage(runtimeEnv.driverBotToken, runtimeEnv.channelId, prompt);
    createdMessages.push({ messageId: sent.id, token: runtimeEnv.driverBotToken });
    const matched = await pollChannelMessages({
      token: runtimeEnv.driverBotToken,
      channelId: runtimeEnv.channelId,
      afterSnowflake: sent.id,
      timeoutMs,
      observedMessages: environment.observedMessages,
      observationScenarioId: environment.scenario.id,
      observationScenarioTitle: environment.scenario.title,
      triggerMessageId: sent.id,
      triggerTimestamp: sent.timestamp,
      predicate: (message) =>
        matchesDiscordScenarioReply({
          channelId: runtimeEnv.channelId,
          matchText: marker,
          message,
          sutBotId: environment.sutIdentity.id,
        }),
    });
    createdMessages.push({
      messageId: matched.message.messageId,
      token: runtimeEnv.sutBotToken,
    });
    assertDiscordScenarioReply({ expectedTextIncludes: [marker], message: matched.message });
    return matched.message;
  };
  const evidence: TranscriptAuthorizationEvidence = {
    schemaVersion: 1,
    scenarioId: environment.scenario.id,
    denied: {
      replyObserved: false,
      visibleDenial: false,
      voiceStayedDisconnected: false,
    },
    allowed: { replyObserved: false, voiceJoined: false },
    cleanup: {
      emergencyStopAttempted: false,
      messagesDeleted: 0,
      messageDeleteFailures: 0,
      stopReplyObserved: false,
      voiceDisconnected: false,
    },
  };
  let evidencePath: string;

  try {
    await waitForDiscordVoiceDisconnect({
      ...voice,
      timeoutMs: 5_000,
    });
    const deniedReply = await sendTranscriptPrompt(
      "start",
      run.deniedSessionId,
      run.negativeMarker,
    );
    evidence.denied.replyObserved = true;
    evidence.denied.visibleDenial = VISIBLE_DENIAL_RE.test(deniedReply.text);
    if (!evidence.denied.visibleDenial) {
      throw new Error("Discord transcript denial was not visible in the SUT reply.");
    }
    const deniedVoiceState = await getCurrentDiscordVoiceState(voice);
    evidence.denied.voiceStayedDisconnected = deniedVoiceState?.channel_id !== voiceChannel.id;
    if (!evidence.denied.voiceStayedDisconnected) {
      throw new Error("Denied Discord transcript capture joined the target voice channel.");
    }

    await configureTranscriptVoiceAccess(true);
    await sendTranscriptPrompt("start", run.allowedSessionId, run.positiveMarker);
    evidence.allowed.replyObserved = true;
    await waitForDiscordVoiceState({
      ...voice,
      sutBotId: environment.sutIdentity.id,
      timeoutMs: phaseTimeoutMs,
    });
    evidence.allowed.voiceJoined = true;

    await sendTranscriptPrompt("stop", run.allowedSessionId, run.stopMarker);
    evidence.cleanup.stopReplyObserved = true;
    await waitForDiscordVoiceDisconnect({
      ...voice,
      timeoutMs: phaseTimeoutMs,
    });
    evidence.cleanup.voiceDisconnected = true;
  } finally {
    if (!evidence.cleanup.voiceDisconnected) {
      const voiceState = await getCurrentDiscordVoiceState(voice).catch(() => undefined);
      if (voiceState !== undefined && voiceState?.channel_id !== voiceChannel.id) {
        evidence.cleanup.voiceDisconnected = true;
      } else {
        evidence.cleanup.emergencyStopAttempted = true;
        for (const sessionId of [run.allowedSessionId, run.deniedSessionId]) {
          const cleanupMarker = `${run.stopMarker}_${sessionId === run.allowedSessionId ? "A" : "D"}`;
          await sendTranscriptPrompt(
            "stop",
            sessionId,
            cleanupMarker,
            Math.min(15_000, phaseTimeoutMs),
          ).catch(() => undefined);
        }
        evidence.cleanup.voiceDisconnected = await waitForDiscordVoiceDisconnect({
          ...voice,
          timeoutMs: Math.min(15_000, phaseTimeoutMs),
        })
          .then(() => true)
          .catch(() => false);
      }
    }
    const deletion = await deleteScenarioMessages({
      channelId: runtimeEnv.channelId,
      messages: createdMessages,
    });
    evidence.cleanup.messagesDeleted = deletion.deleted;
    evidence.cleanup.messageDeleteFailures = deletion.failures;
    evidencePath = await writeTranscriptAuthorizationEvidence({
      evidence,
      outputDir: environment.outputDir,
    });
  }

  if (!evidence.cleanup.voiceDisconnected) {
    throw new Error("Discord transcript cleanup left the SUT bot in the target voice channel.");
  }
  if (evidence.cleanup.messageDeleteFailures > 0) {
    throw new Error(
      `Discord transcript cleanup could not delete ${evidence.cleanup.messageDeleteFailures} scenario message(s).`,
    );
  }
  return {
    details: "visible denial, authorized transcript join, and verified stop/leave",
    artifacts: { transcriptAuthorization: evidencePath },
  };
}
