import { complete } from "@mariozechner/pi-ai";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../../../../src/agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../../../src/agents/defaults.js";
import { getApiKeyForModel } from "../../../../src/agents/model-auth.js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { parseModelRef } from "../../../../src/agents/model-selection.js";
import { extractAssistantText } from "../../../../src/agents/pi-embedded-utils.js";
import {
  discoverAuthStorage,
  discoverModels,
} from "../../../../src/agents/pi-model-discovery.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { logVerbose } from "../../../../src/globals.js";

const DEFAULT_THREAD_TITLE_TIMEOUT_MS = 10_000;
const MAX_THREAD_TITLE_SOURCE_CHARS = 600;
const MAX_THREAD_TITLE_CHANNEL_NAME_CHARS = 120;
const MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS = 320;
const DISCORD_THREAD_TITLE_MAX_TOKENS = 24;
const DISCORD_THREAD_TITLE_TEMPERATURE = 0.2;
const DISCORD_THREAD_TITLE_SYSTEM_PROMPT =
  "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.";

type ThreadTitleModelSelection = {
  provider: string;
  modelId: string;
  profileId?: string;
  agentDir: string;
};

type ThreadTitleModel = Parameters<typeof complete>[0];

export async function generateThreadTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  messageText: string;
  channelName?: string;
  channelDescription?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const sourceText = params.messageText.trim();
  if (!sourceText) {
    return null;
  }

  const selection = resolveDiscordThreadTitleModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!selection) {
    logVerbose(`thread-title: no model configured for agent ${params.agentId}`);
    return null;
  }

  try {
    const model = await resolveThreadTitleModel({
      cfg: params.cfg,
      selection,
      agentId: params.agentId,
    });
    if (!model) {
      return null;
    }

    const promptText = truncateThreadTitleSourceText(sourceText);
    const userMessage = buildThreadTitleUserMessage({
      sourceText: promptText,
      channelName: params.channelName,
      channelDescription: params.channelDescription,
    });
    const timeoutMs = resolveThreadTitleTimeoutMs(params.timeoutMs);
    const response = await completeThreadTitle({
      model,
      userMessage,
      timeoutMs,
    });
    const generated = normalizeGeneratedThreadTitle(extractAssistantText(response));
    return generated || null;
  } catch (err) {
    logVerbose(`thread-title: title generation failed for agent ${params.agentId}: ${String(err)}`);
    return null;
  }
}

export function resolveDiscordThreadTitleModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ThreadTitleModelSelection | null {
  const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  if (!modelRef) {
    return null;
  }
  const { model, profile } = splitTrailingAuthProfile(modelRef);
  const parsed = parseModelRef(model, DEFAULT_PROVIDER);
  if (!parsed) {
    return null;
  }
  return {
    provider: parsed.provider,
    modelId: parsed.model,
    profileId: profile || undefined,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
  };
}

async function resolveThreadTitleModel(params: {
  cfg: OpenClawConfig;
  selection: ThreadTitleModelSelection;
  agentId: string;
}): Promise<ThreadTitleModel | null> {
  const authStorage = discoverAuthStorage(params.selection.agentDir);
  const modelRegistry = discoverModels(authStorage, params.selection.agentDir);
  const model = modelRegistry.find(params.selection.provider, params.selection.modelId);
  if (!model) {
    logVerbose(
      `thread-title: model not found for agent ${params.agentId}: ${params.selection.provider}/${params.selection.modelId}`,
    );
    return null;
  }

  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.selection.agentDir,
    profileId: params.selection.profileId,
  });
  const rawApiKey = apiKeyInfo.apiKey?.trim();
  if (!rawApiKey && apiKeyInfo.mode !== "aws-sdk") {
    logVerbose(
      `thread-title: missing API key for agent ${params.agentId}: ${params.selection.provider}/${params.selection.modelId}`,
    );
    return null;
  }

  await maybeSetThreadTitleRuntimeApiKey({
    authStorage,
    model,
    rawApiKey,
  });

  return model;
}

async function maybeSetThreadTitleRuntimeApiKey(params: {
  authStorage: ReturnType<typeof discoverAuthStorage>;
  model: ThreadTitleModel;
  rawApiKey: string | undefined;
}): Promise<void> {
  if (!params.rawApiKey) {
    return;
  }
  if (params.model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../../../github-copilot/token.js");
    const copilotToken = await resolveCopilotApiToken({
      githubToken: params.rawApiKey,
    });
    params.authStorage.setRuntimeApiKey(params.model.provider, copilotToken.token);
    return;
  }
  params.authStorage.setRuntimeApiKey(params.model.provider, params.rawApiKey);
}

async function completeThreadTitle(params: {
  model: ThreadTitleModel;
  userMessage: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    return await complete(
      params.model,
      {
        systemPrompt: DISCORD_THREAD_TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: params.userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: DISCORD_THREAD_TITLE_MAX_TOKENS,
        temperature: DISCORD_THREAD_TITLE_TEMPERATURE,
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildThreadTitleUserMessage(params: {
  sourceText: string;
  channelName?: string;
  channelDescription?: string;
}): string {
  const channelName = normalizeTitleContextField(
    params.channelName,
    MAX_THREAD_TITLE_CHANNEL_NAME_CHARS,
  );
  const channelDescription = normalizeTitleContextField(
    params.channelDescription,
    MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS,
  );
  const messageLines: string[] = [];
  if (channelName) {
    messageLines.push(`Channel: ${channelName}`);
  }
  if (channelDescription) {
    messageLines.push(`Channel description: ${channelDescription}`);
  }
  messageLines.push(`Message:\n${params.sourceText}`);
  return messageLines.join("\n\n");
}

function truncateThreadTitleSourceText(sourceText: string): string {
  if (sourceText.length <= MAX_THREAD_TITLE_SOURCE_CHARS) {
    return sourceText;
  }
  return `${sourceText.slice(0, MAX_THREAD_TITLE_SOURCE_CHARS)}...`;
}

function resolveThreadTitleTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(100, Math.floor(timeoutMs ?? DEFAULT_THREAD_TITLE_TIMEOUT_MS));
}

export function normalizeGeneratedThreadTitle(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  let firstLine = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!firstLine && trimmed.startsWith("```")) {
      continue;
    }
    firstLine = trimmed;
    break;
  }
  return firstLine.replace(/^["'`]+|["'`]+$/g, "").trim();
}

function normalizeTitleContextField(raw: string | undefined, maxChars: number): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const singleLine = value.replace(/\s+/g, " ");
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}...`;
}
