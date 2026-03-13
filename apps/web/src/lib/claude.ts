/**
 * Multi-provider AI handler.
 * Supports Anthropic (Claude), OpenAI, and Google Gemini.
 *
 * Key resolution order per provider:
 *  1. User's own BYOK key → use it (works on any plan, no billing)
 *  2. Platform key + active paid subscription → use it + record usage
 *  3. Neither → throw NoApiKeyError
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "./prisma";
import { recordUsage } from "./billing";
import { getModel, type ModelDef, type Provider } from "./models";

const HISTORY_LIMIT = 20;

const SYSTEM_PROMPT =
  "You are OpenClaw, a helpful personal AI assistant. Be concise and direct. You can help with tasks, answer questions, write emails, manage information, and more.";

// ─── Error types ────────────────────────────────────────────────────────────

/** Thrown when the user has no API key and no active paid subscription. */
export class NoApiKeyError extends Error {
  constructor(provider: Provider) {
    super(`NO_API_KEY:${provider}`);
    this.name = "NoApiKeyError";
  }
}

// ─── Key resolution ──────────────────────────────────────────────────────────

interface ResolvedKey {
  apiKey: string;
  ownKey: boolean; // true = BYOK, false = platform key
}

async function resolveKey(
  provider: Provider,
  userKeys: { anthropicApiKey: string | null; openaiApiKey: string | null; geminiApiKey: string | null },
  isActivePaidSub: boolean,
): Promise<ResolvedKey> {
  const byok =
    provider === "anthropic" ? userKeys.anthropicApiKey
    : provider === "openai"  ? userKeys.openaiApiKey
    : userKeys.geminiApiKey;

  if (byok) return { apiKey: byok, ownKey: true };

  const platformKey =
    provider === "anthropic" ? process.env.ANTHROPIC_API_KEY
    : provider === "openai"  ? process.env.OPENAI_API_KEY
    : process.env.GEMINI_API_KEY;

  if (isActivePaidSub && platformKey) return { apiKey: platformKey, ownKey: false };

  throw new NoApiKeyError(provider);
}

// ─── Per-provider call implementations ──────────────────────────────────────

async function callAnthropic(
  apiKey: string,
  model: ModelDef,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<{ reply: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];
  const response = await client.messages.create({
    model: model.id,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });
  const reply = response.content[0].type === "text" ? response.content[0].text : "";
  return { reply, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

async function callOpenAI(
  apiKey: string,
  model: ModelDef,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<{ reply: string; inputTokens: number; outputTokens: number }> {
  const client = new OpenAI({ apiKey });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];
  const response = await client.chat.completions.create({
    model: model.id,
    max_tokens: 1024,
    messages,
  });
  const reply = response.choices[0]?.message?.content ?? "";
  return {
    reply,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

async function callGoogle(
  apiKey: string,
  model: ModelDef,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<{ reply: string; inputTokens: number; outputTokens: number }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const gModel = genAI.getGenerativeModel({
    model: model.id,
    systemInstruction: SYSTEM_PROMPT,
  });
  const chat = gModel.startChat({
    history: history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
  });
  const result = await chat.sendMessage(userMessage);
  const reply = result.response.text();
  const meta = result.response.usageMetadata;
  return {
    reply,
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function replyWithClaude(
  userId: string,
  channel: string,
  userMessage: string,
): Promise<string> {
  // Load user AI settings + subscription in one query
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      anthropicApiKey: true,
      openaiApiKey: true,
      geminiApiKey: true,
      preferredModel: true,
      subscription: { select: { status: true, plan: true } },
    },
  });

  const model = getModel(user?.preferredModel);
  const isActivePaidSub =
    user?.subscription?.status === "active" && user.subscription.plan !== "free";

  const { apiKey, ownKey } = await resolveKey(
    model.provider,
    {
      anthropicApiKey: user?.anthropicApiKey ?? null,
      openaiApiKey: user?.openaiApiKey ?? null,
      geminiApiKey: user?.geminiApiKey ?? null,
    },
    isActivePaidSub,
  );

  // Fetch conversation history
  const history = await prisma.message.findMany({
    where: { userId, channel },
    orderBy: { createdAt: "asc" },
    take: HISTORY_LIMIT,
  });

  // Call the appropriate provider
  const call =
    model.provider === "anthropic" ? callAnthropic
    : model.provider === "openai"  ? callOpenAI
    : callGoogle;

  const { reply, inputTokens, outputTokens } = await call(apiKey, model, history, userMessage);

  // Persist messages and usage record concurrently
  await Promise.all([
    prisma.message.createMany({
      data: [
        { userId, channel, role: "user",      content: userMessage },
        { userId, channel, role: "assistant", content: reply },
      ],
    }),
    recordUsage({ userId, channel, model, inputTokens, outputTokens, ownKey }),
  ]);

  return reply;
}
