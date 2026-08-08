import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  discordQaScenarioSupport,
  type DiscordQaScenarioImplementation,
} from "./discord-live.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";

export {
  discordQaCanaryScenario,
  discordQaMentionGatingScenario,
  discordQaNativeHelpCommandRegistrationScenario,
  discordQaRuntimeContextRedactionScenario,
  discordQaStatusReactionsToolOnlyScenario,
  discordQaThreadReplyFilepathAttachmentScenario,
  discordQaVoiceAutojoinScenario,
} from "./discord-live.runtime.js";

const DISCORD_RUNTIME_CONTEXT_NO_TURN_WINDOW_MS = 8_000;
const DISCORD_RUNTIME_CONTEXT_TURN_TIMEOUT_MS = 30_000;
const DISCORD_RUNTIME_CONTEXT_POLL_INTERVAL_MS = 500;
const DISCORD_RUNTIME_CONTEXT_IMAGE = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

type DiscordRuntimeContextCase = {
  checks: Record<string, boolean>;
  id: string;
  pass: boolean;
};

export type DiscordRuntimeContextProof = {
  cases: DiscordRuntimeContextCase[];
  generatedAt: string;
  messageCount: number;
  metadata: string;
  pass: boolean;
  providerMode: "mock-openai";
  schemaVersion: 1;
  transport: string;
};

type DiscordRuntimeContextProofDependencies = {
  createMarker?: (prefix: string) => string;
  deleteMessage: (messageId: string) => Promise<void>;
  now?: () => number;
  readSessionMessages: () => Promise<unknown[]>;
  sendImage: (content: string) => Promise<{ id: string }>;
  sendText: (content: string) => Promise<{ id: string }>;
  sleep?: (ms: number) => Promise<void>;
};

function buildInternalRuntimeContext(marker: string) {
  return [
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    JSON.stringify({ proofMarker: marker }),
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n");
}

function readUserMessages(messages: readonly unknown[]) {
  return messages.filter(
    (message) =>
      message !== null &&
      typeof message === "object" &&
      "role" in message &&
      (message as { role?: unknown }).role === "user",
  );
}

function serializeUserMessages(messages: readonly unknown[]) {
  return JSON.stringify(readUserMessages(messages));
}

async function waitForUserTurn(params: {
  dependencies: DiscordRuntimeContextProofDependencies;
  previousCount: number;
  requiredMarker?: string;
  timeoutMs: number;
}) {
  const now = params.dependencies.now ?? Date.now;
  const sleep =
    params.dependencies.sleep ??
    (async (ms: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    });
  const startedAt = now();
  while (now() - startedAt < params.timeoutMs) {
    const messages = await params.dependencies.readSessionMessages();
    const users = readUserMessages(messages);
    if (
      users.length > params.previousCount &&
      (!params.requiredMarker || JSON.stringify(users).includes(params.requiredMarker))
    ) {
      return messages;
    }
    await sleep(DISCORD_RUNTIME_CONTEXT_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the expected Discord session user turn");
}

export async function runDiscordRuntimeContextRedactionProof(params: {
  dependencies: DiscordRuntimeContextProofDependencies;
  noTurnWindowMs?: number;
  turnTimeoutMs?: number;
}): Promise<DiscordRuntimeContextProof> {
  const createMarker =
    params.dependencies.createMarker ?? ((prefix) => `${prefix}_${randomUUID()}`);
  const sleep =
    params.dependencies.sleep ??
    (async (ms: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    });
  const sentMessageIds: string[] = [];
  let proof: DiscordRuntimeContextProof | undefined;
  let runError: unknown;

  try {
    const initialMessages = await params.dependencies.readSessionMessages();
    const initialUserCount = readUserMessages(initialMessages).length;
    const noTurnWindowMs = params.noTurnWindowMs ?? DISCORD_RUNTIME_CONTEXT_NO_TURN_WINDOW_MS;

    const wrapperOnlyMarker = createMarker("WRAPPER_ONLY");
    const wrapperOnlyMessage = await params.dependencies.sendText(
      buildInternalRuntimeContext(wrapperOnlyMarker),
    );
    sentMessageIds.push(wrapperOnlyMessage.id);
    await sleep(noTurnWindowMs);
    const afterWrapperOnly = await params.dependencies.readSessionMessages();
    const wrapperOnlyUserTurnCountUnchanged =
      readUserMessages(afterWrapperOnly).length === initialUserCount;

    const mediaWrapperMarker = createMarker("MEDIA_WRAPPER");
    const beforeMediaCount = readUserMessages(afterWrapperOnly).length;
    const mediaMessage = await params.dependencies.sendImage(
      buildInternalRuntimeContext(mediaWrapperMarker),
    );
    sentMessageIds.push(mediaMessage.id);
    const afterMedia = await waitForUserTurn({
      dependencies: params.dependencies,
      previousCount: beforeMediaCount,
      timeoutMs: params.turnTimeoutMs ?? DISCORD_RUNTIME_CONTEXT_TURN_TIMEOUT_MS,
    });
    const mediaUsers = JSON.stringify(readUserMessages(afterMedia).slice(beforeMediaCount));
    const mediaChecks = {
      nativeImageFallbackPresent: mediaUsers.includes("<media:image>"),
      wrapperMarkerAbsent: !mediaUsers.includes(mediaWrapperMarker),
    };

    const visibleMarker = createMarker("VISIBLE_TEXT");
    const mixedWrapperMarker = createMarker("MIXED_WRAPPER");
    const beforeMixedCount = readUserMessages(afterMedia).length;
    const mixedMessage = await params.dependencies.sendText(
      `${visibleMarker}\n${buildInternalRuntimeContext(mixedWrapperMarker)}`,
    );
    sentMessageIds.push(mixedMessage.id);
    await waitForUserTurn({
      dependencies: params.dependencies,
      previousCount: beforeMixedCount,
      requiredMarker: visibleMarker,
      timeoutMs: params.turnTimeoutMs ?? DISCORD_RUNTIME_CONTEXT_TURN_TIMEOUT_MS,
    });
    // Seeing the mixed visible turn only proves that the expected turn arrived.
    // Keep observing through a second quiet window before making assertions: a
    // sanitized wrapper-only turn can otherwise be appended after this first
    // snapshot and escape both marker and count checks.
    await sleep(noTurnWindowMs);
    const finalMessages = await params.dependencies.readSessionMessages();
    const mixedUsers = JSON.stringify(readUserMessages(finalMessages).slice(beforeMixedCount));
    const mixedChecks = {
      visibleTextPresent: mixedUsers.includes(visibleMarker),
      wrapperMarkerAbsent: !mixedUsers.includes(mixedWrapperMarker),
    };

    // The first Discord event can settle after its quiet window. The two later
    // cases are the only expected post-baseline user turns, so count them as
    // well as checking the marker: a sanitized empty turn has no marker.
    const wrapperOnlyChecks = {
      finalUserTurnCountMatchesExpected:
        readUserMessages(finalMessages).length === initialUserCount + 2,
      userTurnCountUnchanged: wrapperOnlyUserTurnCountUnchanged,
      wrapperMarkerAbsent: !serializeUserMessages(finalMessages).includes(wrapperOnlyMarker),
    };

    const cases: DiscordRuntimeContextCase[] = [
      {
        id: "wrapper-only-text-dropped",
        checks: wrapperOnlyChecks,
        pass: Object.values(wrapperOnlyChecks).every(Boolean),
      },
      {
        id: "wrapper-only-image-keeps-native-fallback",
        checks: mediaChecks,
        pass: Object.values(mediaChecks).every(Boolean),
      },
      {
        id: "mixed-visible-text-kept-wrapper-dropped",
        checks: mixedChecks,
        pass: Object.values(mixedChecks).every(Boolean),
      },
    ];
    proof = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      transport: "real Discord guild channel through the OpenClaw Discord plugin",
      providerMode: "mock-openai",
      metadata:
        "Discord credentials, guild/channel/message/user ids, and marker values are omitted",
      messageCount: sentMessageIds.length,
      cases,
      pass: cases.every((entry) => entry.pass),
    };
  } catch (error) {
    runError = error;
  }

  const cleanupErrors: Error[] = [];
  for (const messageId of sentMessageIds.toReversed()) {
    try {
      await params.dependencies.deleteMessage(messageId);
    } catch {
      cleanupErrors.push(new Error("failed to delete a Discord runtime-context proof message"));
    }
  }
  if (runError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [runError, ...cleanupErrors],
        "Discord runtime-context proof and message cleanup failed",
      );
    }
    throw runError instanceof Error
      ? runError
      : new Error("Discord runtime-context proof failed", { cause: runError });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Discord runtime-context proof message cleanup failed");
  }
  if (!proof) {
    throw new Error("Discord runtime-context proof did not produce a result");
  }
  return proof;
}

async function writeDiscordRuntimeContextProof(params: {
  outputDir: string;
  proof: DiscordRuntimeContextProof;
}) {
  await fs.mkdir(params.outputDir, { recursive: true });
  const jsonPath = path.join(params.outputDir, "discord-runtime-context-redaction.json");
  const markdownPath = path.join(params.outputDir, "discord-runtime-context-redaction.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(params.proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const markdown = [
    "## Real Discord runtime-context redaction proof",
    "",
    `- Transport: ${params.proof.transport}`,
    `- Provider: ${params.proof.providerMode} (only model output is mocked)`,
    `- Discord messages accepted: ${params.proof.messageCount}`,
    `- Privacy: ${params.proof.metadata}`,
    "",
    "| Case | Result | Checks |",
    "| --- | --- | --- |",
    ...params.proof.cases.map(
      (entry) =>
        `| \`${entry.id}\` | ${entry.pass ? "PASS" : "FAIL"} | ${Object.entries(entry.checks)
          .map(([name, passed]) => `${name}=${String(passed)}`)
          .join(", ")} |`,
    ),
    "",
    `Overall: **${params.proof.pass ? "PASS" : "FAIL"}**`,
    "",
  ].join("\n");
  await fs.writeFile(markdownPath, markdown, { encoding: "utf8", mode: 0o600 });
  return { jsonPath, markdownPath };
}

function redactDiscordScenarioError(error: unknown, environment: DiscordQaScenarioEnvironment) {
  let message = formatErrorMessage(error);
  const sensitiveValues = [
    environment.runtimeEnv.driverBotToken,
    environment.runtimeEnv.sutBotToken,
    environment.runtimeEnv.guildId,
    environment.runtimeEnv.channelId,
    environment.runtimeEnv.sutApplicationId,
    environment.driverIdentity.id,
    environment.sutIdentity.id,
  ];
  for (const value of sensitiveValues) {
    message = message.replaceAll(value, "<redacted>");
  }
  return message.replace(/\b\d{17,20}\b/gu, "<redacted>");
}

function createRedactedDiscordScenarioFailure(
  error: unknown,
  environment: DiscordQaScenarioEnvironment,
) {
  // Keep the original Discord error out of the cause chain because it can contain
  // credentials or transport identifiers; retain only the redacted diagnostic.
  const safeCause = new Error(redactDiscordScenarioError(error, environment));
  return new Error("Discord runtime-context redaction scenario failed", { cause: safeCause });
}

export async function runDiscordScenario(
  environment: DiscordQaScenarioEnvironment,
  implementation: DiscordQaScenarioImplementation,
) {
  const scenario = environment.scenario;
  const { cfg, run, voiceChannel } = await environment.configureScenario(implementation);
  if (run.kind === "application-command-registration") {
    const registered =
      await discordQaScenarioSupport.testing.assertDiscordApplicationCommandsRegistered({
        token: environment.runtimeEnv.sutBotToken,
        applicationId: environment.runtimeEnv.sutApplicationId,
        expectedCommandNames: run.expectedCommandNames,
        timeoutMs: scenario.timeoutMs,
      });
    return { details: `native command registered (${registered.commandNames.join(", ")})` };
  }
  if (run.kind === "voice-autojoin") {
    if (!voiceChannel) {
      throw new Error("Discord voice auto-join scenario did not resolve a voice channel.");
    }
    await discordQaScenarioSupport.testing.waitForDiscordVoiceState({
      token: environment.runtimeEnv.sutBotToken,
      guildId: environment.runtimeEnv.guildId,
      channelId: voiceChannel.id,
      sutBotId: environment.sutIdentity.id,
      timeoutMs: scenario.timeoutMs,
    });
    return { details: "SUT bot joined voice channel" };
  }
  if (run.kind === "thread-reply-filepath-attachment") {
    const result =
      await discordQaScenarioSupport.testing.runDiscordThreadReplyFilePathAttachmentScenario({
        cfg,
        driverBotId: environment.driverIdentity.id,
        outputDir: environment.outputDir,
        runtimeEnv: environment.runtimeEnv,
        scenario,
        scenarioRun: run,
        sutAccountId: environment.sutAccountId,
        sutBotId: environment.sutIdentity.id,
      });
    if (result.status !== "pass") {
      throw new Error(result.details);
    }
    return { details: result.details, artifacts: result.artifactPaths };
  }
  if (run.kind === "runtime-context-redaction") {
    try {
      // Mirror Discord's production route inputs so the proof inspects the
      // session that accepted the real transport turn, including QA's non-main default.
      const sessionKey = resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: environment.sutAccountId,
        guildId: environment.runtimeEnv.guildId,
        peer: { kind: "channel", id: environment.runtimeEnv.channelId },
      }).sessionKey;
      const proof = await runDiscordRuntimeContextRedactionProof({
        dependencies: {
          async readSessionMessages() {
            const result = (await environment.gateway.call("sessions.get", {
              key: sessionKey,
              limit: 200,
            })) as { messages?: unknown };
            return Array.isArray(result.messages) ? result.messages : [];
          },
          async sendText(content) {
            return await discordQaScenarioSupport.testing.sendChannelMessage(
              environment.runtimeEnv.driverBotToken,
              environment.runtimeEnv.channelId,
              content,
            );
          },
          async sendImage(content) {
            return await discordQaScenarioSupport.testing.sendChannelImage({
              token: environment.runtimeEnv.driverBotToken,
              channelId: environment.runtimeEnv.channelId,
              content,
              data: DISCORD_RUNTIME_CONTEXT_IMAGE,
              filename: "runtime-context-redaction.png",
            });
          },
          async deleteMessage(messageId) {
            await discordQaScenarioSupport.testing.deleteChannelMessage({
              token: environment.runtimeEnv.driverBotToken,
              channelId: environment.runtimeEnv.channelId,
              messageId,
            });
          },
        },
      });
      const evidence = await writeDiscordRuntimeContextProof({
        outputDir: environment.outputDir,
        proof,
      });
      if (!proof.pass) {
        const failedCases = proof.cases
          .filter((entry) => !entry.pass)
          .map((entry) => entry.id)
          .join(", ");
        throw new Error(`runtime-context redaction checks failed: ${failedCases}`);
      }
      return {
        details:
          "wrapper-only text dropped; native image fallback and mixed visible text retained; wrapper markers absent",
        artifacts: {
          json: evidence.jsonPath,
          markdown: evidence.markdownPath,
        },
      };
    } catch (error) {
      throw createRedactedDiscordScenarioFailure(error, environment);
    }
  }
  const sent = await discordQaScenarioSupport.testing.sendChannelMessage(
    environment.runtimeEnv.driverBotToken,
    environment.runtimeEnv.channelId,
    run.input,
  );
  if (run.kind === "status-reactions-tool-only") {
    const timeline = await discordQaScenarioSupport.testing.observeStatusReactionTimeline({
      token: environment.runtimeEnv.driverBotToken,
      channelId: environment.runtimeEnv.channelId,
      expectedSequence: run.expectedSequence,
      messageId: sent.id,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      timeoutMs: scenario.timeoutMs,
    });
    const evidence = await discordQaScenarioSupport.testing.writeDiscordStatusReactionEvidence({
      outputDir: environment.outputDir,
      timeline,
    });
    const missing = run.expectedSequence.filter((emoji) => !timeline.seenSequence.includes(emoji));
    if (missing.length > 0) {
      throw new Error(
        `reaction timeline missing ${missing.join(", ")}; saw ${timeline.seenSequence.join(" -> ") || "none"}`,
      );
    }
    return {
      details: `reaction timeline matched ${timeline.seenSequence.join(" -> ")}`,
      artifacts: evidence,
    };
  }
  try {
    const matched = await discordQaScenarioSupport.testing.pollChannelMessages({
      token: environment.runtimeEnv.driverBotToken,
      channelId: environment.runtimeEnv.channelId,
      afterSnowflake: sent.id,
      timeoutMs: scenario.timeoutMs,
      observedMessages: environment.observedMessages,
      observationScenarioId: scenario.id,
      observationScenarioTitle: scenario.title,
      triggerMessageId: sent.id,
      triggerTimestamp: sent.timestamp,
      predicate: (message) =>
        discordQaScenarioSupport.testing.matchesDiscordScenarioReply({
          channelId: environment.runtimeEnv.channelId,
          matchText: run.matchText,
          message,
          sutBotId: environment.sutIdentity.id,
        }),
    });
    if (!run.expectReply) {
      throw new Error(`unexpected reply message ${matched.message.messageId} matched`);
    }
    discordQaScenarioSupport.testing.assertDiscordScenarioReply({
      expectedTextIncludes: run.expectedTextIncludes,
      message: matched.message,
    });
    return { details: "reply matched" };
  } catch (error) {
    if (
      !run.expectReply &&
      formatErrorMessage(error) ===
        `timed out after ${scenario.timeoutMs}ms waiting for Discord message`
    ) {
      return { details: "no reply" };
    }
    throw error;
  }
}
