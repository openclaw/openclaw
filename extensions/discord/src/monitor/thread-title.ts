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

type ThreadTitleModelSelection = {
  provider: string;
  modelId: string;
  profileId?: string;
  agentDir: string;
};

export function normalizeGeneratedThreadTitle(raw: string): string {
  const firstLine = (raw.replace(/\r/g, "").split("\n")[0] ?? "").trim();
  return firstLine.replace(/^["'`]+|["'`]+$/g, "").trim();
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
    const authStorage = discoverAuthStorage(selection.agentDir);
    const modelRegistry = discoverModels(authStorage, selection.agentDir);
    const model = modelRegistry.find(selection.provider, selection.modelId);
    if (!model) {
      logVerbose(
        `thread-title: model not found for agent ${params.agentId}: ${selection.provider}/${selection.modelId}`,
      );
      return null;
    }

    const apiKeyInfo = await getApiKeyForModel({
      model,
      cfg: params.cfg,
      agentDir: selection.agentDir,
      profileId: selection.profileId,
    });
    const apiKey = apiKeyInfo.apiKey?.trim();
    if (!apiKey) {
      logVerbose(
        `thread-title: missing API key for agent ${params.agentId}: ${selection.provider}/${selection.modelId}`,
      );
      return null;
    }

    const timeoutMs = Math.max(
      100,
      Math.floor(params.timeoutMs ?? DEFAULT_THREAD_TITLE_TIMEOUT_MS),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const promptText =
        sourceText.length > MAX_THREAD_TITLE_SOURCE_CHARS
          ? `${sourceText.slice(0, MAX_THREAD_TITLE_SOURCE_CHARS)}...`
          : sourceText;
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
      messageLines.push(`Message:\n${promptText}`);
      const response = await complete(
        model,
        {
          systemPrompt:
            "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
          messages: [
            {
              role: "user",
              content: messageLines.join("\n\n"),
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: 24,
          temperature: 0.2,
          signal: controller.signal,
        },
      );
      const generated = normalizeGeneratedThreadTitle(extractAssistantText(response));
      return generated || null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logVerbose(`thread-title: title generation failed for agent ${params.agentId}: ${String(err)}`);
    return null;
  }
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
