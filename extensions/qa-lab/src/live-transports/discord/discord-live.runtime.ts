import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DiscordApiError,
  handleDiscordMessageAction,
  requestDiscord as requestDiscordLive,
} from "@openclaw/discord/api.js";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chromium } from "playwright-core";
import { z } from "zod";
import type { QaGatewayChild } from "../../gateway-child.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import { readLiveQaChannelAccounts } from "../shared/live-channel-status.js";
import { requireLiveQaEnv } from "../shared/live-credential-env.js";
import { createDiscordQaEndpointFetcher } from "./discord-live.endpoint.js";
import {
  buildDiscordWebMessageUrl,
  collectSeenReactionSequence,
  normalizeDiscordObservedMessage,
  normalizeDiscordReactionSnapshot,
  renderDiscordStatusReactionHtml,
  renderDiscordThreadReplyAttachmentHtml,
  type DiscordMessage,
  type DiscordObservedMessage,
  type DiscordReactionSnapshot,
  type DiscordUser,
} from "./discord-live.evidence.js";
import type { DiscordTranscriptsVoiceAuthorizationRun } from "./discord-transcripts-authorization.types.js";

export type DiscordQaRuntimeEnv = {
  guildId: string;
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutApplicationId: string;
  voiceChannelId?: string;
};

export type DiscordQaScenarioRun =
  | {
      kind: "channel-message";
      expectReply: boolean;
      input: string;
      expectedTextIncludes?: string[];
      matchText?: string;
    }
  | {
      kind: "application-command-registration";
      expectedCommandNames: string[];
    }
  | {
      kind: "voice-autojoin";
    }
  | DiscordTranscriptsVoiceAuthorizationRun
  | {
      kind: "status-reactions-tool-only";
      expectedSequence: string[];
      input: string;
    }
  | {
      kind: "progress-draft-lifecycle";
      errorFinalText: string;
      errorInput: string;
      finalMarker: string;
      input: string;
      progressLabel: string;
    }
  | {
      kind: "thread-reply-filepath-attachment";
      expectedAttachmentFilename: string;
      input: string;
      replyContent: string;
    };

export type DiscordQaScenarioImplementation = {
  buildRun: (sutApplicationId: string) => DiscordQaScenarioRun;
};

type DiscordQaScenarioMetadata = {
  id: string;
  timeoutMs: number;
  title: string;
};

type DiscordThread = {
  id: string;
  name?: string;
  parent_id?: string;
};

type DiscordApplicationCommand = {
  id: string;
  name?: string;
};

export type DiscordChannel = {
  id: string;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
  position?: number;
  type: number;
};

type DiscordVoiceState = {
  channel_id?: string | null;
  guild_id?: string;
  user_id?: string;
};

type DiscordStatusReactionTimeline = {
  expectedSequence: string[];
  htmlPath?: string;
  scenarioId: string;
  scenarioTitle: string;
  screenshotPath?: string;
  screenshotWarning?: string;
  seenSequence: string[];
  snapshots: DiscordReactionSnapshot[];
  triggerMessageId: string;
};

type DiscordThreadReplyAttachmentEvidence = {
  attachmentFilenames: string[];
  channelId?: string;
  discordWebUrl?: string;
  expectedAttachmentFilename: string;
  guildId?: string;
  htmlPath?: string;
  messageContent?: string;
  messageId?: string;
  parentMessageId?: string;
  scenarioId: string;
  scenarioTitle: string;
  screenshotPath?: string;
  screenshotWarning?: string;
  status: "pass" | "fail";
  threadId: string;
  threadName: string;
};

const DISCORD_QA_CAPTURE_UI_METADATA_ENV = "OPENCLAW_QA_DISCORD_CAPTURE_UI_METADATA";
const DISCORD_QA_KEEP_THREADS_ENV = "OPENCLAW_QA_DISCORD_KEEP_THREADS";
const discordQaApiBaseByToken = new Map<string, string>();

type DiscordQaRequestOptions = NonNullable<Parameters<typeof requestDiscordLive>[2]>;

async function requestDiscord<T>(
  requestPath: string,
  token: string,
  options?: DiscordQaRequestOptions,
): Promise<T> {
  const apiBaseUrl = discordQaApiBaseByToken.get(token);
  return await requestDiscordLive<T>(requestPath, token, {
    timeoutMs: 15_000,
    ...options,
    ...(apiBaseUrl
      ? { endpointRuntime: null, fetcher: createDiscordQaEndpointFetcher(apiBaseUrl) }
      : {}),
  });
}

export function registerDiscordQaApiBase(params: {
  apiBaseUrl: string;
  tokens: readonly string[];
}): () => void {
  const normalized = new URL(params.apiBaseUrl).toString().replace(/\/$/u, "");
  for (const token of params.tokens) {
    discordQaApiBaseByToken.set(token, normalized);
  }
  return () => {
    for (const token of params.tokens) {
      if (discordQaApiBaseByToken.get(token) === normalized) {
        discordQaApiBaseByToken.delete(token);
      }
    }
  };
}

async function withRegisteredDiscordQaApiBase<T>(token: string, run: () => Promise<T>): Promise<T> {
  const apiBaseUrl = discordQaApiBaseByToken.get(token);
  if (!apiBaseUrl) {
    return await run();
  }
  const previous = process.env.DISCORD_API_URL;
  process.env.DISCORD_API_URL = apiBaseUrl;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.DISCORD_API_URL;
    } else {
      process.env.DISCORD_API_URL = previous;
    }
  }
}

export const discordQaCanaryScenario: DiscordQaScenarioImplementation = {
  buildRun: (sutApplicationId) => {
    const token = `DISCORD_QA_ECHO_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      kind: "channel-message",
      expectReply: true,
      input: `<@${sutApplicationId}> reply with only this exact marker: ${token}`,
      expectedTextIncludes: [token],
      matchText: token,
    };
  },
};

export const discordQaMentionGatingScenario: DiscordQaScenarioImplementation = {
  buildRun: () => {
    const token = `DISCORD_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      kind: "channel-message",
      expectReply: false,
      input: `reply with only this exact marker: ${token}`,
      matchText: token,
    };
  },
};

export const discordQaNativeHelpCommandRegistrationScenario: DiscordQaScenarioImplementation = {
  buildRun: () => ({
    kind: "application-command-registration",
    expectedCommandNames: ["help"],
  }),
};

export const discordQaVoiceAutojoinScenario: DiscordQaScenarioImplementation = {
  buildRun: () => ({
    kind: "voice-autojoin",
  }),
};

export const discordQaStatusReactionsToolOnlyScenario: DiscordQaScenarioImplementation = {
  buildRun: () => {
    const token = `DISCORD_QA_STATUS_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      kind: "status-reactions-tool-only",
      input: [
        `Mantis status reaction QA marker ${token}.`,
        "Think briefly, then reply with only this exact marker:",
        token,
      ].join(" "),
      expectedSequence: ["👀"],
    };
  },
};

export const discordQaProgressDraftLifecycleScenario: DiscordQaScenarioImplementation = {
  buildRun: (sutApplicationId) => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const finalMarker = `DISCORD_QA_PROGRESS_FINAL_${suffix}`;
    return {
      kind: "progress-draft-lifecycle",
      errorFinalText: "The AI service is temporarily overloaded. Please try again in a moment.",
      errorInput: [
        `<@${sutApplicationId}> Tool progress QA check: Provider HTTP 503 after tool QA check:`,
        "call the exec tool exactly once with this exact command before answering: `sleep 5`.",
      ].join(" "),
      finalMarker,
      progressLabel: `Discord progress QA ${suffix}`,
      input: [
        `<@${sutApplicationId}> Tool progress QA check:`,
        "call the exec tool exactly once with this exact command before answering: `sleep 5`.",
        `After that command completes, reply exactly \`${finalMarker}\`.`,
      ].join(" "),
    };
  },
};

export const discordQaThreadReplyFilepathAttachmentScenario: DiscordQaScenarioImplementation = {
  buildRun: () => {
    const token = `DISCORD_QA_THREAD_FILE_${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      kind: "thread-reply-filepath-attachment",
      input: `Mantis Discord thread attachment parent ${token}`,
      replyContent: `Mantis thread attachment reply ${token}`,
      expectedAttachmentFilename: "mantis-thread-report.md",
    };
  },
};

const discordQaCredentialPayloadSchema = z.object({
  guildId: z.string().trim().min(1),
  channelId: z.string().trim().min(1),
  driverBotToken: z.string().trim().min(1),
  sutBotToken: z.string().trim().min(1),
  sutApplicationId: z.string().trim().min(1),
  voiceChannelId: z.string().trim().min(1).optional(),
});

function isDiscordSnowflake(value: string) {
  return /^\d{17,20}$/u.test(value);
}

function assertDiscordSnowflake(value: string, label: string) {
  if (!isDiscordSnowflake(value)) {
    throw new Error(`${label} must be a Discord snowflake.`);
  }
}

export function resolveDiscordQaRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordQaRuntimeEnv {
  const voiceChannelId = env.OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID?.trim();
  const runtimeEnv = {
    guildId: requireLiveQaEnv(env, "OPENCLAW_QA_DISCORD_GUILD_ID"),
    channelId: requireLiveQaEnv(env, "OPENCLAW_QA_DISCORD_CHANNEL_ID"),
    driverBotToken: requireLiveQaEnv(env, "OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN"),
    sutBotToken: requireLiveQaEnv(env, "OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN"),
    sutApplicationId: requireLiveQaEnv(env, "OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID"),
    ...(voiceChannelId ? { voiceChannelId } : {}),
  };
  validateDiscordQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_DISCORD");
  return runtimeEnv;
}

function validateDiscordQaRuntimeEnv(runtimeEnv: DiscordQaRuntimeEnv, prefix: string) {
  assertDiscordSnowflake(runtimeEnv.guildId, `${prefix}_GUILD_ID`);
  assertDiscordSnowflake(runtimeEnv.channelId, `${prefix}_CHANNEL_ID`);
  assertDiscordSnowflake(runtimeEnv.sutApplicationId, `${prefix}_SUT_APPLICATION_ID`);
  if (runtimeEnv.voiceChannelId) {
    assertDiscordSnowflake(runtimeEnv.voiceChannelId, `${prefix}_VOICE_CHANNEL_ID`);
  }
}

export function parseDiscordQaCredentialPayload(payload: unknown): DiscordQaRuntimeEnv {
  const parsed = discordQaCredentialPayloadSchema.parse(payload);
  const runtimeEnv = {
    guildId: parsed.guildId,
    channelId: parsed.channelId,
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutApplicationId: parsed.sutApplicationId,
    ...(parsed.voiceChannelId ? { voiceChannelId: parsed.voiceChannelId } : {}),
  };
  validateDiscordQaRuntimeEnv(runtimeEnv, "Discord credential payload");
  return runtimeEnv;
}

export function buildDiscordQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    guildId: string;
    channelId: string;
    driverBotId: string;
    sutAccountId: string;
    sutBotToken: string;
  },
  options: {
    progressDraftLabel?: string;
    statusReactionsToolOnly?: boolean;
    voiceChannelAccess?: {
      channelId: string;
      users: string[];
    };
    voiceAutoJoin?: {
      channelId: string;
      guildId: string;
    };
  } = {},
): OpenClawConfig {
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "discord"]);
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    discord: { enabled: true },
  };
  const messages = {
    ...baseCfg.messages,
    ...(options.statusReactionsToolOnly
      ? {
          ackReaction: "👀",
          ackReactionScope: "all" as const,
          statusReactions: {
            ...baseCfg.messages?.statusReactions,
            enabled: true,
          },
        }
      : {}),
    groupChat: {
      ...baseCfg.messages?.groupChat,
      visibleReplies: options.statusReactionsToolOnly
        ? ("message_tool" as const)
        : ("automatic" as const),
    },
  };
  const voiceConfig =
    options.voiceAutoJoin || options.voiceChannelAccess
      ? {
          ...baseCfg.channels?.discord?.voice,
          enabled: true,
          mode: "stt-tts" as const,
          ...(options.voiceAutoJoin ? { autoJoin: [options.voiceAutoJoin] } : { autoJoin: [] }),
        }
      : undefined;
  return {
    ...baseCfg,
    ...(options.voiceChannelAccess
      ? {
          agents: {
            ...baseCfg.agents,
            entries: {
              ...baseCfg.agents?.entries,
              qa: {
                ...baseCfg.agents?.entries?.qa,
                tools: {
                  ...baseCfg.agents?.entries?.qa?.tools,
                  alsoAllow: uniqueStrings([
                    ...(baseCfg.agents?.entries?.qa?.tools?.alsoAllow ?? []),
                    "transcripts",
                  ]),
                },
              },
            },
          },
          tools: {
            ...baseCfg.tools,
            alsoAllow: uniqueStrings([...(baseCfg.tools?.alsoAllow ?? []), "transcripts"]),
          },
        }
      : {}),
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
    },
    messages,
    channels: {
      ...baseCfg.channels,
      discord: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        ...(voiceConfig ? { voice: voiceConfig } : {}),
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            token: params.sutBotToken,
            ...(options.progressDraftLabel
              ? {
                  streaming: {
                    mode: "progress" as const,
                    progress: {
                      commentary: false,
                      label: options.progressDraftLabel,
                      toolProgress: true,
                    },
                  },
                }
              : {}),
            allowBots: options.statusReactionsToolOnly ? true : "mentions",
            groupPolicy: "allowlist",
            guilds: {
              [params.guildId]: {
                requireMention: !options.statusReactionsToolOnly,
                users: [params.driverBotId],
                channels: {
                  [params.channelId]: {
                    enabled: true,
                    requireMention: !options.statusReactionsToolOnly,
                    users: [params.driverBotId],
                  },
                  ...(options.voiceChannelAccess
                    ? {
                        [options.voiceChannelAccess.channelId]: {
                          enabled: true,
                          users: options.voiceChannelAccess.users,
                        },
                      }
                    : {}),
                },
              },
            },
          },
        },
      },
    },
  };
}

export async function getCurrentDiscordUser(token: string) {
  return await requestDiscord<DiscordUser>("/users/@me", token);
}

function isDiscordVoiceChannel(channel: DiscordChannel) {
  return channel.type === 2 || channel.type === 13;
}

export async function resolveDiscordQaVoiceChannel(params: {
  guildId: string;
  token: string;
  voiceChannelId?: string;
}) {
  if (params.voiceChannelId) {
    const channel = await requestDiscord<DiscordChannel>(
      `/channels/${params.voiceChannelId}`,
      params.token,
    );
    if (!isDiscordVoiceChannel(channel)) {
      throw new Error(`Discord voiceChannelId ${params.voiceChannelId} is not a voice channel.`);
    }
    if (channel.guild_id && channel.guild_id !== params.guildId) {
      throw new Error(
        `Discord voiceChannelId ${params.voiceChannelId} belongs to guild ${channel.guild_id}, not ${params.guildId}.`,
      );
    }
    return channel;
  }

  const channels = await requestDiscord<DiscordChannel[]>(
    `/guilds/${params.guildId}/channels`,
    params.token,
  );
  const voiceChannels = channels
    .filter(isDiscordVoiceChannel)
    .toSorted(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id.localeCompare(b.id),
    );
  const first = voiceChannels[0];
  if (!first) {
    throw new Error(
      "Discord voice auto-join scenario could not find a visible voice/stage channel for the SUT bot. Add voiceChannelId to the Convex discord credential payload or set OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID.",
    );
  }
  return first;
}

export async function getCurrentDiscordVoiceState(params: { token: string; guildId: string }) {
  try {
    return await requestDiscord<DiscordVoiceState>(
      `/guilds/${params.guildId}/voice-states/@me`,
      params.token,
    );
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function waitForDiscordVoiceState(params: {
  channelId: string;
  guildId: string;
  sutBotId: string;
  timeoutMs: number;
  token: string;
}) {
  const startedAt = Date.now();
  let lastState: DiscordVoiceState | null = null;
  let lastError: string | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const state = await getCurrentDiscordVoiceState({
        token: params.token,
        guildId: params.guildId,
      });
      lastState = state;
      lastError = undefined;
      if (
        state?.channel_id === params.channelId &&
        (!state.user_id || state.user_id === params.sutBotId)
      ) {
        return state;
      }
    } catch (error) {
      lastError = formatErrorMessage(error);
    }
    await sleep(500);
  }
  const stateDetails = lastState
    ? `last voice state channel=${lastState.channel_id ?? "none"} user=${lastState.user_id ?? "unknown"}`
    : "no current voice state";
  throw new Error(
    `SUT bot did not join Discord voice channel ${params.channelId} (${stateDetails}${
      lastError ? `; last error: ${lastError}` : ""
    })`,
  );
}

export async function sendChannelMessage(token: string, channelId: string, content: string) {
  return await requestDiscord<DiscordMessage>(`/channels/${channelId}/messages`, token, {
    body: {
      content,
      allowed_mentions: {
        parse: ["users"],
      },
    },
  });
}

async function getChannelMessage(params: { token: string; channelId: string; messageId: string }) {
  return await requestDiscord<DiscordMessage>(
    `/channels/${params.channelId}/messages/${params.messageId}`,
    params.token,
  );
}

export async function waitForDiscordMessageText(params: {
  token: string;
  channelId: string;
  messageId: string;
  textIncludes: string[];
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const message = await getChannelMessage(params);
    const normalized = normalizeDiscordObservedMessage(message);
    if (normalized && params.textIncludes.every((text) => normalized.text.includes(text))) {
      return normalized;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out after ${params.timeoutMs}ms waiting for Discord message ${params.messageId} text`,
  );
}

export async function waitForDiscordMessageDeleted(params: {
  token: string;
  channelId: string;
  messageId: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      await getChannelMessage(params);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        return;
      }
      throw error;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out after ${params.timeoutMs}ms waiting for Discord message ${params.messageId} deletion`,
  );
}

async function listChannelMessagesAfter(params: {
  token: string;
  channelId: string;
  afterSnowflake: string;
}) {
  const query = new URLSearchParams({
    after: params.afterSnowflake,
    limit: "50",
  });
  return await requestDiscord<DiscordMessage[]>(
    `/channels/${params.channelId}/messages?${query.toString()}`,
    params.token,
  );
}

export function computeDiscordRttMs(triggerTimestamp?: string, replyTimestamp?: string) {
  if (!triggerTimestamp || !replyTimestamp) {
    return undefined;
  }
  const triggerAtMs = Date.parse(triggerTimestamp);
  const replyAtMs = Date.parse(replyTimestamp);
  if (!Number.isFinite(triggerAtMs) || !Number.isFinite(replyAtMs)) {
    return undefined;
  }
  return Math.max(0, Math.round(replyAtMs - triggerAtMs));
}

export async function writeDiscordStatusReactionEvidence(params: {
  outputDir: string;
  timeline: DiscordStatusReactionTimeline;
}) {
  const htmlPath = path.join(params.outputDir, `${params.timeline.scenarioId}-timeline.html`);
  const screenshotPath = path.join(params.outputDir, `${params.timeline.scenarioId}-timeline.png`);
  const html = renderDiscordStatusReactionHtml({
    expectedSequence: params.timeline.expectedSequence,
    scenarioTitle: params.timeline.scenarioTitle,
    seenSequence: params.timeline.seenSequence,
    snapshots: params.timeline.snapshots,
  });
  await fs.writeFile(htmlPath, html, { encoding: "utf8", mode: 0o600 });
  const screenshot = await writeHtmlScreenshot({ htmlPath, screenshotPath });
  return { htmlPath, ...screenshot };
}

async function writeHtmlScreenshot(params: { htmlPath: string; screenshotPath: string }) {
  try {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1104, height: 760 } });
      await page.goto(pathToFileURL(params.htmlPath).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await fs.mkdir(path.dirname(params.screenshotPath), { recursive: true });
      await writeExternalFileWithinRoot({
        rootDir: path.dirname(params.screenshotPath),
        path: path.basename(params.screenshotPath),
        write: async (tempPath) => {
          await page.screenshot({ path: tempPath, fullPage: true });
        },
      });
      return { screenshotPath: params.screenshotPath };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { screenshotWarning: formatErrorMessage(error) };
  }
}

async function writeDiscordThreadReplyAttachmentEvidence(params: {
  evidence: DiscordThreadReplyAttachmentEvidence;
  outputDir: string;
}) {
  const htmlPath = path.join(params.outputDir, `${params.evidence.scenarioId}-attachment.html`);
  const uiPath = params.evidence.discordWebUrl
    ? path.join(params.outputDir, `${params.evidence.scenarioId}-ui.json`)
    : undefined;
  const screenshotPath = path.join(
    params.outputDir,
    `${params.evidence.scenarioId}-attachment.png`,
  );
  const html = renderDiscordThreadReplyAttachmentHtml({
    attachmentFilenames: params.evidence.attachmentFilenames,
    expectedAttachmentFilename: params.evidence.expectedAttachmentFilename,
    messageContent: params.evidence.messageContent,
    scenarioTitle: params.evidence.scenarioTitle,
    status: params.evidence.status,
    threadName: params.evidence.threadName,
  });
  await fs.writeFile(htmlPath, html, { encoding: "utf8", mode: 0o600 });
  if (uiPath) {
    await fs.writeFile(
      uiPath,
      `${JSON.stringify(
        {
          attachmentFilenames: params.evidence.attachmentFilenames,
          channelId: params.evidence.channelId,
          discordWebUrl: params.evidence.discordWebUrl,
          expectedAttachmentFilename: params.evidence.expectedAttachmentFilename,
          guildId: params.evidence.guildId,
          messageContent: params.evidence.messageContent,
          messageId: params.evidence.messageId,
          parentMessageId: params.evidence.parentMessageId,
          scenarioId: params.evidence.scenarioId,
          scenarioTitle: params.evidence.scenarioTitle,
          status: params.evidence.status,
          threadId: params.evidence.threadId,
          threadName: params.evidence.threadName,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const screenshot = await writeHtmlScreenshot({ htmlPath, screenshotPath });
  return { htmlPath, ...(uiPath ? { uiPath } : {}), ...screenshot };
}

export async function observeStatusReactionTimeline(params: {
  channelId: string;
  expectedSequence: string[];
  messageId: string;
  scenarioId: string;
  scenarioTitle: string;
  timeoutMs: number;
  token: string;
}) {
  const startedAtMs = Date.now();
  const snapshots: DiscordReactionSnapshot[] = [];
  let seenSequence: string[] = [];
  while (Date.now() - startedAtMs < params.timeoutMs) {
    const observedAt = new Date();
    const message = await getChannelMessage({
      token: params.token,
      channelId: params.channelId,
      messageId: params.messageId,
    });
    snapshots.push(
      normalizeDiscordReactionSnapshot({
        message,
        observedAt,
        startedAtMs,
      }),
    );
    seenSequence = collectSeenReactionSequence(snapshots, params.expectedSequence);
    if (params.expectedSequence.every((emoji) => seenSequence.includes(emoji))) {
      break;
    }
    await sleep(250);
  }
  return {
    expectedSequence: params.expectedSequence,
    scenarioId: params.scenarioId,
    scenarioTitle: params.scenarioTitle,
    seenSequence,
    snapshots,
    triggerMessageId: params.messageId,
  } satisfies DiscordStatusReactionTimeline;
}

function compareDiscordSnowflakes(a: string, b: string) {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function pollChannelMessages(params: {
  token: string;
  channelId: string;
  afterSnowflake: string;
  timeoutMs: number;
  predicate: (message: DiscordObservedMessage) => boolean;
  observedMessages: DiscordObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  triggerMessageId?: string;
  triggerTimestamp?: string;
}) {
  const startedAt = Date.now();
  let afterSnowflake = params.afterSnowflake;
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listChannelMessagesAfter({
      token: params.token,
      channelId: params.channelId,
      afterSnowflake,
    });
    const sorted = messages
      .filter((message) => isDiscordSnowflake(message.id))
      .toSorted((a, b) => compareDiscordSnowflakes(a.id, b.id));
    for (const message of sorted) {
      afterSnowflake = message.id;
      const normalized = normalizeDiscordObservedMessage(message);
      if (!normalized) {
        continue;
      }
      const matchedScenario = params.predicate(normalized);
      const observedMessage: DiscordObservedMessage = {
        ...normalized,
        scenarioId: params.observationScenarioId,
        scenarioTitle: params.observationScenarioTitle,
        matchedScenario,
        triggerMessageId: params.triggerMessageId,
        triggerTimestamp: params.triggerTimestamp,
      };
      params.observedMessages.push(observedMessage);
      if (matchedScenario) {
        return { message: observedMessage, afterSnowflake };
      }
    }
    await sleep(1_000);
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Discord message`);
}

async function pollThreadReplyMessage(params: {
  token: string;
  threadId: string;
  replyContent: string;
  sutBotId: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await requestDiscord<DiscordMessage[]>(
      `/channels/${params.threadId}/messages?limit=50`,
      params.token,
    );
    const match = messages.find(
      (message) =>
        message.author?.id === params.sutBotId &&
        Boolean(message.content?.includes(params.replyContent)),
    );
    if (match) {
      return match;
    }
    await sleep(1_000);
  }
  return undefined;
}

export async function runDiscordThreadReplyFilePathAttachmentScenario(params: {
  cfg: OpenClawConfig;
  driverBotId: string;
  outputDir: string;
  runtimeEnv: DiscordQaRuntimeEnv;
  scenario: DiscordQaScenarioMetadata;
  scenarioRun: Extract<DiscordQaScenarioRun, { kind: "thread-reply-filepath-attachment" }>;
  sutAccountId: string;
  sutBotId: string;
}) {
  const captureUiMetadata = isTruthyOptIn(process.env[DISCORD_QA_CAPTURE_UI_METADATA_ENV]);
  const keepThread = isTruthyOptIn(process.env[DISCORD_QA_KEEP_THREADS_ENV]);
  const threadName = `mantis-thread-filepath-${randomUUID().slice(0, 8)}`;
  const parent = await sendChannelMessage(
    params.runtimeEnv.driverBotToken,
    params.runtimeEnv.channelId,
    params.scenarioRun.input,
  );
  const thread = await requestDiscord<DiscordThread>(
    `/channels/${params.runtimeEnv.channelId}/messages/${parent.id}/threads`,
    params.runtimeEnv.driverBotToken,
    { body: { name: threadName, auto_archive_duration: 60 } },
  );
  const attachmentPath = path.join(params.outputDir, params.scenarioRun.expectedAttachmentFilename);
  await fs.writeFile(
    attachmentPath,
    [
      "# Mantis Discord Thread Attachment",
      "",
      `Parent message: ${parent.id}`,
      `Thread: ${thread.id}`,
      `Marker: ${params.scenarioRun.replyContent}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    await requestDiscord<void>(
      `/channels/${thread.id}/thread-members/@me`,
      params.runtimeEnv.sutBotToken,
      { method: "PUT" },
    );
    await withRegisteredDiscordQaApiBase(params.runtimeEnv.sutBotToken, async () => {
      await handleDiscordMessageAction({
        action: "thread-reply",
        params: {
          threadId: thread.id,
          message: params.scenarioRun.replyContent,
          filePath: attachmentPath,
        },
        cfg: params.cfg,
        accountId: params.sutAccountId,
        requesterSenderId: params.driverBotId,
        mediaLocalRoots: [params.outputDir],
        mediaReadFile: async (filePath) => await fs.readFile(filePath),
      });
    });

    const reply = await pollThreadReplyMessage({
      token: params.runtimeEnv.driverBotToken,
      threadId: thread.id,
      replyContent: params.scenarioRun.replyContent,
      sutBotId: params.sutBotId,
      timeoutMs: params.scenario.timeoutMs,
    });
    const attachmentFilenames = (reply?.attachments ?? [])
      .map((attachment) => attachment.filename?.trim() ?? "")
      .filter(Boolean)
      .toSorted();
    const status = attachmentFilenames.includes(params.scenarioRun.expectedAttachmentFilename)
      ? "pass"
      : "fail";
    const discordWebUrl = buildDiscordWebMessageUrl({
      guildId: params.runtimeEnv.guildId,
      messageId: reply?.id,
      threadId: thread.id,
    });
    const evidence: DiscordThreadReplyAttachmentEvidence = {
      attachmentFilenames,
      ...(captureUiMetadata
        ? {
            channelId: params.runtimeEnv.channelId,
            discordWebUrl,
            guildId: params.runtimeEnv.guildId,
            parentMessageId: parent.id,
          }
        : {}),
      expectedAttachmentFilename: params.scenarioRun.expectedAttachmentFilename,
      messageContent: reply?.content,
      messageId: reply?.id,
      scenarioId: params.scenario.id,
      scenarioTitle: params.scenario.title,
      status,
      threadId: thread.id,
      threadName,
    };
    const artifactEvidence = await writeDiscordThreadReplyAttachmentEvidence({
      evidence,
      outputDir: params.outputDir,
    });
    return {
      id: params.scenario.id,
      title: params.scenario.title,
      status,
      details:
        status === "pass"
          ? `thread reply attached ${params.scenarioRun.expectedAttachmentFilename}`
          : reply
            ? `thread reply omitted ${params.scenarioRun.expectedAttachmentFilename}; saw ${attachmentFilenames.join(", ") || "no attachments"}`
            : "thread reply was not observed",
      artifactPaths: {
        attachmentSource: attachmentPath,
        html: artifactEvidence.htmlPath,
        ...(artifactEvidence.screenshotPath ? { screenshot: artifactEvidence.screenshotPath } : {}),
        ...(artifactEvidence.uiPath ? { ui: artifactEvidence.uiPath } : {}),
      },
    };
  } finally {
    if (!keepThread) {
      await requestDiscord<DiscordThread>(
        `/channels/${thread.id}`,
        params.runtimeEnv.driverBotToken,
        { body: { archived: true }, method: "PATCH" },
      ).catch(() => {});
    }
  }
}

export async function waitForDiscordChannelRunning(gateway: QaGatewayChild, accountId: string) {
  const startedAt = Date.now();
  let lastStatus: ChannelAccountSnapshot | undefined;
  while (Date.now() - startedAt < 45_000) {
    try {
      const accounts = await readLiveQaChannelAccounts(gateway, "discord");
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match;
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  const details = lastStatus
    ? ` (last status: running=${String(lastStatus.running)} connected=${String(lastStatus.connected)} restartPending=${String(lastStatus.restartPending)} lastConnectedAt=${String(lastStatus.lastConnectedAt)} lastError=${lastStatus.lastError ?? "null"} lastDisconnect=${JSON.stringify(lastStatus.lastDisconnect)})`
    : "";
  throw new Error(`discord account "${accountId}" did not become connected${details}`);
}

export function matchesDiscordScenarioReply(params: {
  channelId: string;
  message: DiscordObservedMessage;
  matchText?: string;
  sutBotId: string;
}) {
  return (
    params.message.channelId === params.channelId &&
    params.message.senderId === params.sutBotId &&
    Boolean(params.matchText && params.message.text.includes(params.matchText))
  );
}

export async function assertDiscordApplicationCommandsRegistered(params: {
  applicationId: string;
  expectedCommandNames: string[];
  timeoutMs: number;
  token: string;
}) {
  const startedAt = Date.now();
  let lastNames: string[] = [];
  while (Date.now() - startedAt < params.timeoutMs) {
    const commands = await requestDiscord<DiscordApplicationCommand[]>(
      `/applications/${params.applicationId}/commands`,
      params.token,
    );
    lastNames = commands
      .map((command) => command.name ?? "")
      .filter(Boolean)
      .toSorted();
    const nameSet = new Set(lastNames);
    const missing = params.expectedCommandNames.filter((name) => !nameSet.has(name));
    if (missing.length === 0) {
      return { commandNames: lastNames };
    }
    await sleep(1_000);
  }
  throw new Error(
    `missing Discord native command(s): ${params.expectedCommandNames
      .filter((name) => !lastNames.includes(name))
      .join(", ")} (registered: ${lastNames.join(", ") || "none"})`,
  );
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
