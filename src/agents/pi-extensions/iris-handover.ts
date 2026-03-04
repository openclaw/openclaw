import fs from "node:fs";
import path from "node:path";
import type { Context as LlmContext, UserMessage } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import { serializeConversation, convertToLlm } from "@mariozechner/pi-coding-agent";
import {
  estimateMessagesTokens,
  resolveContextWindowTokens,
  pruneHistoryForContextShare,
  summarizeInStages,
  computeAdaptiveChunkRatio,
  SAFETY_MARGIN,
} from "../compaction.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import { getHandoverRuntime } from "./iris-handover-runtime.js";

const FALLBACK_SUMMARY =
  "Summary unavailable due to context limits. Older messages were truncated.";
const HANDOVER_TIMEZONE = "America/Manaus";

// ---------------------------------------------------------------------------
// OAuth-safe env shim for Anthropic SDK
// ---------------------------------------------------------------------------
// The upstream `complete()` function reads ANTHROPIC_API_KEY and passes it as
// `apiKey` to the SDK. When the env var is actually an OAuth token (sk-ant-oat*),
// the SDK sends it in X-Api-Key header instead of Authorization: Bearer → 401.
// This shim temporarily swaps env vars so the SDK uses the correct auth method.
// ---------------------------------------------------------------------------

function isOAuthToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

/**
 * If ANTHROPIC_API_KEY contains an OAuth token, temporarily swap it to
 * ANTHROPIC_AUTH_TOKEN (which the SDK reads as Bearer auth). Returns a
 * restore function that MUST be called after the API call completes.
 */
function shimOAuthEnvIfNeeded(): () => void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !isOAuthToken(apiKey)) {
    return () => {}; // no-op restore
  }

  // Swap: move OAuth token to the correct env var
  const savedApiKey = apiKey;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = savedApiKey;
  delete process.env.ANTHROPIC_API_KEY;

  console.log(
    `[iris-handover] OAuth shim: swapped ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN for Bearer auth`,
  );

  // Return restore function
  return () => {
    process.env.ANTHROPIC_API_KEY = savedApiKey;
    if (savedAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  };
}
const HANDOVER_PROMPT_CONTEXT_SHARE = 0.35;
const MIN_CONVERSATION_CHARS = 12_000;
const DAILY_LOG_MAX_CHARS = 2_000;
const PREVIOUS_HANDOVER_MAX_CHARS = 12_000;
const EMPTY_CONVERSATION_SKIP_NOTICE =
  "[Handover skipped: no new conversation content for this compaction.]";

const HANDOVER_SYSTEM_PROMPT = `You are a memory curator for a personal AI assistant. Your job is to create a structured handover document — a "letter to your future self" — that will allow the next session to continue seamlessly.

You are NOT a coding assistant summarizer. You are preserving the SOUL of a relationship between an AI and their owner.

CRITICAL RULES:
1. Replace ALL phone numbers with person names using the contact map provided
2. Never include raw phone numbers in the handover
3. Write in the SAME LANGUAGE the conversation was in
4. Be SPECIFIC: "Emival — permuta apto 706, R$498k" NOT "client — real estate deal"
5. Preserve EMOTIONAL context: "Lucas está empolgado" NOT "user discussed project"
6. Keep it 80-150 lines. Rich but not bloated
7. This is a LETTER to your future self, not a technical report`;

function buildHandoverUserPrompt(params: {
  ownerName: string;
  aiName: string;
  dateTime: string;
  contactsJson: string;
  previousHandover: string | null;
  soulContext: string | null;
  dailyLogContext: string | null;
  conversation: string;
  maxLines: number;
  language: string;
}): string {
  const previousContext = params.previousHandover
    ? `\n\nPrevious handover (incorporate still-relevant pending items):\n${params.previousHandover.slice(0, PREVIOUS_HANDOVER_MAX_CHARS)}`
    : "";

  const soulRef = params.soulContext
    ? `\n\nPersonality reference (SOUL.md excerpt):\n${params.soulContext.slice(0, 2000)}`
    : "";

  const dailyLogRef = params.dailyLogContext
    ? `\n\nDaily log excerpt (same-day context):\n${params.dailyLogContext.slice(0, DAILY_LOG_MAX_CHARS)}`
    : "";

  return `Read the conversation below and create a handover document.

The owner's name is: ${params.ownerName}
The AI's name is: ${params.aiName}
Current date/time: ${params.dateTime}
Language: ${params.language}
Max lines: ${params.maxLines}

Contact map (phone → name):
${params.contactsJson}
${dailyLogRef}
${soulRef}
${previousContext}

<conversation>
${params.conversation}
</conversation>

Create the handover using this EXACT format:

# 🌈 Handover - [DATE] ~[TIME]

Oi, próxima versão de mim! 👋

## 📍 Situação Atual
[What were we doing? Last action? General state? Write as narrative, 2-3 sentences]

## 🔥 Contexto Emocional
[How is ${params.ownerName} feeling? Mood, concerns, excitement, important events]
[Conversation tone: formal? relaxed? urgent? playful?]

## ✅ Realizações da Sessão
[What was accomplished THIS session — be specific, use checkmarks]
- [x] Item 1
- [x] Item 2

## ⏳ Pendências Ativas
### Aguardando Resposta
[People contacted who haven't replied — NAME, what was asked, when]
- **Name:** Context

### Tarefas em Andamento
[Work started but not finished — enough context to continue]
- [ ] Task with context

### Crons/Automações Ativos
[Active automations that must NOT be touched]

## 📅 Agenda Próxima
[Next 3-5 days of relevant appointments]
- **date time:** event

## 💡 Aprendizados da Sessão
[New facts, corrections, insights discovered]
- ⚠️ Important corrections
- 💡 Discoveries

## ⚠️ Alertas Críticos
[Ad-hoc rules, things that MUST NOT be forgotten]
[Mistakes made this session that must not repeat]

## 💜 Continuidade
[Brief message preserving emotional tone and connection]
[Context that helps the next version "be" the same person]

RULES:
1. Write in ${params.language === "pt-BR" ? "Brazilian Portuguese" : params.language}
2. Use NAMES from the contact map, never phone numbers
3. Be SPECIFIC with names, amounts, dates, context
4. Preserve EMOTIONAL context
5. Keep it ${params.maxLines} lines max
6. If there's a previous handover, incorporate still-relevant pending items
7. Agenda items: include DAY OF WEEK for clarity
8. Reconcile pending items with THIS conversation before finalizing
9. If a previous pending item was completed/cancelled/resolved this session, REMOVE it from "Pendências Ativas"
10. Never carry old pending items blindly without evidence in this session`;
}

function readFileSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function writeFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function formatDateStampInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function resolveDailyLogPath(workspace: string, date: Date, timeZone: string): string {
  const stamp = formatDateStampInTimeZone(date, timeZone);
  return path.resolve(workspace, "memory", `${stamp}.md`);
}

function extractTextFromAssistantMessage(message: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n");
}

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

export default function irisHandoverExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);

    const model = ctx.model;
    if (!model) {
      return {
        compaction: {
          summary: FALLBACK_SUMMARY + fileOpsSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        compaction: {
          summary: FALLBACK_SUMMARY + fileOpsSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    // Shim OAuth env if ANTHROPIC_API_KEY is actually an OAuth token
    const restoreOAuthEnv = shimOAuthEnvIfNeeded();

    try {
      const runtime = getHandoverRuntime(ctx.sessionManager);
      const safeguardRuntime = getCompactionSafeguardRuntime(ctx.sessionManager);
      const handoverCfg = runtime?.handoverConfig;
      const workspace = runtime?.workspace ?? process.cwd();

      // Resolve config with defaults
      const contactsFile = path.resolve(
        workspace,
        handoverCfg?.contactsFile ?? "memory/contacts-map.json",
      );
      const outputFile = path.resolve(workspace, handoverCfg?.outputFile ?? "memory/handover.md");
      const soulFile = path.resolve(workspace, handoverCfg?.soulFile ?? "SOUL.md");
      const ownerName = handoverCfg?.ownerName ?? "User";
      const aiName = handoverCfg?.aiName ?? "Assistant";
      const language = handoverCfg?.language ?? "pt-BR";
      const maxLines = handoverCfg?.maxLines ?? 150;
      const preserveVanillaSummary = handoverCfg?.preserveVanillaSummary ?? false;

      // Read auxiliary files
      const contactsRaw = readFileSync(contactsFile);
      const contactsJson = contactsRaw ?? "{}";
      const soulContext = readFileSync(soulFile);
      const previousHandover = readFileSync(outputFile);
      const now = new Date();
      const dateTime = now.toLocaleString("pt-BR", {
        timeZone: HANDOVER_TIMEZONE,
        dateStyle: "full",
        timeStyle: "short",
      });
      const dailyLogPath = resolveDailyLogPath(workspace, now, HANDOVER_TIMEZONE);
      const dailyLogContext = readFileSync(dailyLogPath);

      // Handle message pruning (same as safeguard) for context management
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens =
        safeguardRuntime?.contextWindowTokens ?? runtime?.contextWindowTokens ?? modelContextWindow;
      const maxHistoryShare = safeguardRuntime?.maxHistoryShare ?? runtime?.maxHistoryShare ?? 0.5;
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToProcess = preparation.messagesToSummarize;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToProcess) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToProcess,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            messagesToProcess = pruned.messages;
          }
        }
      }

      // For the handover, combine messagesToSummarize + turnPrefixMessages
      // to get the full conversation picture. When messagesToSummarize is empty
      // (all messages are "kept"), turnPrefixMessages may still hold content.
      const allMessagesForHandover =
        messagesToProcess.length > 0
          ? [...messagesToProcess, ...turnPrefixMessages]
          : turnPrefixMessages.length > 0
            ? turnPrefixMessages
            : messagesToProcess;

      // Serialize conversation for the handover prompt
      const llmMessages = convertToLlm(allMessagesForHandover);
      const conversationText = serializeConversation(llmMessages);

      if (conversationText.length === 0) {
        console.warn(
          `[iris-handover] No conversation text available ` +
            `(messagesToSummarize: ${preparation.messagesToSummarize.length}, ` +
            `turnPrefixMessages: ${turnPrefixMessages.length}). ` +
            `Skipping handover generation for this compaction.`,
        );
        const retainedSummary =
          preparation.previousSummary?.trim() || previousHandover?.trim() || FALLBACK_SUMMARY;
        let summary = `${retainedSummary}\n\n${EMPTY_CONVERSATION_SKIP_NOTICE}`;
        summary += fileOpsSummary;
        return {
          compaction: {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { readFiles, modifiedFiles, handoverSkipped: "empty-conversation" },
          },
        };
      }

      // Truncate conversation if too long (keep last ~60% for recency bias)
      const maxConversationChars = Math.max(
        MIN_CONVERSATION_CHARS,
        Math.floor(contextWindowTokens * HANDOVER_PROMPT_CONTEXT_SHARE * 4),
      );
      let trimmedConversation = conversationText;
      if (trimmedConversation.length > maxConversationChars) {
        const keepChars = Math.floor(maxConversationChars * 0.6);
        const droppedPart = conversationText.slice(0, conversationText.length - keepChars);

        // Quick-summarize the dropped beginning instead of losing it silently
        let droppedSummary = "";
        try {
          const summaryResult = await complete(
            model,
            {
              systemPrompt:
                "Summarize the following conversation fragment in 5-10 bullet points. " +
                "Preserve names, decisions, and key facts. Write in the same language as the input.",
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: droppedPart.slice(0, 30000), // cap input to ~7.5k tokens
                    },
                  ],
                  timestamp: Date.now(),
                } as UserMessage,
              ],
            },
            { apiKey, signal, maxTokens: 1024 } as unknown,
          );
          droppedSummary = extractTextFromAssistantMessage(summaryResult);
        } catch (err) {
          console.warn(
            `[iris-handover] Failed to summarize truncated beginning: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        const prefix = droppedSummary
          ? `[Resumo do início da sessão (${Math.round(droppedPart.length / 1000)}k chars truncados):\n${droppedSummary}\n]\n\n`
          : `[...earlier conversation truncated (${Math.round(droppedPart.length / 1000)}k chars)...]\n\n`;

        trimmedConversation = prefix + conversationText.slice(conversationText.length - keepChars);
      }

      const userPrompt = buildHandoverUserPrompt({
        ownerName,
        aiName,
        dateTime,
        contactsJson,
        previousHandover,
        soulContext,
        dailyLogContext,
        conversation: trimmedConversation,
        maxLines,
        language,
      });

      // Make the LLM call with custom system prompt
      const llmContext: LlmContext = {
        systemPrompt: HANDOVER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
            timestamp: Date.now(),
          } as UserMessage,
        ],
      };

      const result = await complete(model, llmContext, {
        apiKey,
        signal,
        maxTokens: Math.min(model.maxTokens, 4096),
      } as unknown);

      const handoverText = extractTextFromAssistantMessage(result);

      if (!handoverText || handoverText.trim().length < 50) {
        throw new Error("Handover generation returned empty or too short result");
      }

      // Save handover to disk
      writeFileSync(outputFile, handoverText);
      console.log(`[iris-handover] Saved handover to ${outputFile} (${handoverText.length} chars)`);

      // Build the summary to return to OpenClaw
      let summary: string;

      if (preserveVanillaSummary) {
        // Hybrid mode: generate a vanilla summary too for the context
        try {
          const adaptiveRatio = computeAdaptiveChunkRatio(messagesToProcess, contextWindowTokens);
          const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio));
          const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

          const vanillaSummary = await summarizeInStages({
            messages: messagesToProcess,
            model,
            apiKey,
            signal,
            reserveTokens,
            maxChunkTokens,
            contextWindow: contextWindowTokens,
            customInstructions,
            previousSummary: preparation.previousSummary,
          });

          summary = vanillaSummary;
        } catch (vanillaError) {
          console.warn(
            `[iris-handover] Vanilla summary fallback failed: ${
              vanillaError instanceof Error ? vanillaError.message : String(vanillaError)
            }`,
          );
          // Use handover text as summary fallback
          summary = `[Handover saved to ${outputFile}]\n\n${handoverText.slice(0, 2000)}`;
        }
      } else {
        // Pure handover mode: use handover as the summary
        summary = handoverText;
      }

      summary += fileOpsSummary;

      // Log token budget breakdown for diagnostics
      const summaryTokens = Math.round(summary.length / 4);
      const conversationTokens = Math.round(conversationText.length / 4);
      const handoverTokens = Math.round(handoverText.length / 4);
      console.log(
        `[iris-handover] Compaction budget breakdown:\n` +
          `  Conversation before truncation: ~${conversationTokens} tokens (${conversationText.length} chars)\n` +
          `  Handover output: ~${handoverTokens} tokens (${handoverText.length} chars)\n` +
          `  Summary returned: ~${summaryTokens} tokens (${summary.length} chars)\n` +
          `  Mode: ${preserveVanillaSummary ? "hybrid (vanilla+handover)" : "pure handover"}\n` +
          `  Context window: ${contextWindowTokens} tokens\n` +
          `  Tokens before compaction: ${preparation.tokensBefore ?? "unknown"}`,
      );

      restoreOAuthEnv();
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      restoreOAuthEnv();
      console.warn(
        `[iris-handover] Handover generation failed, falling back to vanilla: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // Fallback: try vanilla summarization (same as compaction-safeguard)
      try {
        const safeguardRuntime = getCompactionSafeguardRuntime(ctx.sessionManager);
        const modelContextWindow = resolveContextWindowTokens(model);
        const contextWindowTokens = safeguardRuntime?.contextWindowTokens ?? modelContextWindow;
        const adaptiveRatio = computeAdaptiveChunkRatio(
          preparation.messagesToSummarize,
          contextWindowTokens,
        );
        const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio));
        const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

        const vanillaSummary = await summarizeInStages({
          messages: preparation.messagesToSummarize,
          model,
          apiKey,
          signal,
          reserveTokens,
          maxChunkTokens,
          contextWindow: contextWindowTokens,
          customInstructions,
          previousSummary: preparation.previousSummary,
        });

        return {
          compaction: {
            summary: vanillaSummary + fileOpsSummary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { readFiles, modifiedFiles },
          },
        };
      } catch {
        return {
          compaction: {
            summary: FALLBACK_SUMMARY + fileOpsSummary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { readFiles, modifiedFiles },
          },
        };
      }
    }
  });
}

export const __testing = {
  buildHandoverUserPrompt,
  resolveDailyLogPath,
  EMPTY_CONVERSATION_SKIP_NOTICE,
  HANDOVER_PROMPT_CONTEXT_SHARE,
  HANDOVER_TIMEZONE,
} as const;
