import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginConfig = {
  anthropicApiKey?: string;
  model?: string;
  ownerName?: string;
  aiName?: string;
  language?: string;
  maxLines?: number;
  contactsFile?: string;
  soulFile?: string;
  outputFile?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  openaiApiKey?: string;
};

// ---------------------------------------------------------------------------
// Constants — ported from iris-handover.ts
// ---------------------------------------------------------------------------

const HANDOVER_TIMEZONE = "America/Manaus";
const DAILY_LOG_MAX_CHARS = 2_000;
const PREVIOUS_HANDOVER_MAX_CHARS = 12_000;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Generate embedding via OpenAI text-embedding-3-small and insert handover + vector into Supabase.
 */
async function supabaseInsertHandoverWithEmbedding(
  config: PluginConfig,
  row: {
    session_key: string;
    agent_id: string;
    content: string;
    char_count: number;
    token_count: number | null;
    model: string;
  },
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return;

  let embedding: number[] | null = null;
  const openaiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY;

  if (openaiKey) {
    try {
      const embRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: row.content.slice(0, 8000),
        }),
      });
      if (embRes.ok) {
        const embJson = (await embRes.json()) as { data: { embedding: number[] }[] };
        embedding = embJson.data?.[0]?.embedding ?? null;
      } else {
        console.warn(`[iris-handover] Embedding API error ${embRes.status}`);
      }
    } catch (embErr) {
      console.warn(
        `[iris-handover] Embedding failed: ${embErr instanceof Error ? embErr.message : String(embErr)}`,
      );
    }
  }

  const payload: Record<string, unknown> = { ...row };
  if (embedding) {
    payload.embedding = JSON.stringify(embedding);
  }

  const url = `${config.supabaseUrl}/rest/v1/handovers`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase handover insert error ${res.status}: ${body}`);
  }
}

/**
 * Save a timestamped copy to memory/handovers/ for local archive.
 */
function saveHandoverArchive(workspace: string, handoverText: string, date: Date): void {
  const tz = "America/Manaus";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const stamp = `${get("year")}-${get("month")}-${get("day")}_${get("hour")}h${get("minute")}`;
  const dir = path.resolve(workspace, "memory", "handovers");
  fs.mkdirSync(dir, { recursive: true });
  const archivePath = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(archivePath, handoverText, "utf-8");
  console.log(`[iris-handover] Arquivo local: ${archivePath}`);
}

function formatDateStampInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function resolveDailyLogPath(workspace: string, date: Date): string {
  const stamp = formatDateStampInTimeZone(date, HANDOVER_TIMEZONE);
  return path.resolve(workspace, "memory", `${stamp}.md`);
}

function formatDateTime(date: Date): string {
  return date.toLocaleString("pt-BR", {
    timeZone: HANDOVER_TIMEZONE,
    dateStyle: "full",
    timeStyle: "short",
  });
}

/**
 * Serializes the messages array from the before_compaction event into plain text.
 * Replaces the internal serializeConversation/convertToLlm utilities.
 */
function serializeMessages(messages: unknown[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role.toUpperCase() : "UNKNOWN";

    let text = "";
    if (Array.isArray(m.content)) {
      text = m.content
        .filter(
          (b: unknown) =>
            b && typeof b === "object" && (b as Record<string, unknown>).type === "text",
        )
        .map((b: unknown) => {
          const block = b as Record<string, unknown>;
          return typeof block.text === "string" ? block.text : "";
        })
        .join("\n")
        .trim();
    } else if (typeof m.content === "string") {
      text = m.content.trim();
    }

    if (text) {
      lines.push(`${role}: ${text}`);
    }
  }

  return lines.join("\n\n");
}

/**
 * Truncates a conversation to maxChars, keeping the last ~60% for recency bias.
 * Ported from iris-handover.ts (simplified: no sub-summarization of dropped part).
 */
function truncateConversation(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const keepChars = Math.floor(maxChars * 0.6);
  const dropped = text.length - keepChars;
  const prefix = `[...início da sessão truncado (${Math.round(dropped / 1000)}k chars)...]\n\n`;
  return prefix + text.slice(text.length - keepChars);
}

// ---------------------------------------------------------------------------
// Handover prompt builder — ported verbatim from iris-handover.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  const config = (api.pluginConfig ?? {}) as PluginConfig;

  // anthropicApiKey is optional: Anthropic SDK auto-reads ANTHROPIC_API_KEY env var if not set
  const hasKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!hasKey) {
    console.warn(
      "[iris-handover] Nenhum anthropicApiKey no config nem ANTHROPIC_API_KEY no env — plugin desativado.",
    );
    return;
  }

  api.on("before_compaction", async (event, ctx) => {
    const workspace = ctx.workspaceDir ?? process.cwd();

    // Resolve paths
    const contactsFile = path.resolve(workspace, config.contactsFile ?? "contacts-briefing.json");
    const outputFile = path.resolve(workspace, config.outputFile ?? "memory/handover.md");
    const soulFile = path.resolve(workspace, config.soulFile ?? "SOUL.md");

    // Read auxiliary files (silent on missing)
    const contactsJson = readFileSafe(contactsFile) ?? "{}";
    const soulContext = readFileSafe(soulFile);
    const previousHandover = readFileSafe(outputFile);
    const now = new Date();
    const dailyLogPath = resolveDailyLogPath(workspace, now);
    const dailyLogContext = readFileSafe(dailyLogPath);

    // Serialize conversation from event messages (fallback to sessionFile JSONL if empty)
    let rawMessages: unknown[] =
      Array.isArray(event.messages) && event.messages.length > 0 ? event.messages : [];

    if (rawMessages.length === 0) {
      const sessionFilePath = (event as Record<string, unknown>).sessionFile;
      if (typeof sessionFilePath === "string") {
        const fileContent = readFileSafe(sessionFilePath);
        if (fileContent) {
          for (const line of fileContent.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.type === "message" && parsed.message) {
                const msg = parsed.message as Record<string, unknown>;
                if (msg.role === "user" || msg.role === "assistant") {
                  rawMessages.push(msg);
                }
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      }
    }

    const conversationText = serializeMessages(rawMessages);

    if (!conversationText.trim()) {
      console.warn("[iris-handover] Sem conteúdo de conversa — handover skipped.");
      return;
    }

    // Truncate if needed
    const maxChars = 70_000;
    const trimmedConversation = truncateConversation(conversationText, maxChars);

    // Build prompt
    const userPrompt = buildHandoverUserPrompt({
      ownerName: config.ownerName ?? "Lucas",
      aiName: config.aiName ?? "Iris",
      dateTime: formatDateTime(now),
      contactsJson,
      previousHandover,
      soulContext,
      dailyLogContext,
      conversation: trimmedConversation,
      maxLines: config.maxLines ?? 150,
      language: config.language ?? "pt-BR",
    });

    // Call Anthropic SDK directly
    try {
      const client = new Anthropic(
        config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {},
      );
      const response = await client.messages.create({
        model: config.model ?? "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: HANDOVER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      });

      const handoverText = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");

      if (!handoverText || handoverText.trim().length < 50) {
        throw new Error("Handover gerado muito curto ou vazio");
      }

      // Save to disk
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, handoverText, "utf-8");
      console.log(
        `[iris-handover] Salvo em ${outputFile} (${handoverText.length} chars, ${response.usage.output_tokens} tokens)`,
      );

      // Save timestamped archive locally
      saveHandoverArchive(workspace, handoverText, now);

      // Save to Supabase with embedding (non-fatal)
      try {
        await supabaseInsertHandoverWithEmbedding(config, {
          session_key: ctx.sessionKey ?? "unknown",
          agent_id: ctx.agentId ?? "main",
          content: handoverText,
          char_count: handoverText.length,
          token_count: response.usage.output_tokens ?? null,
          model: config.model ?? "claude-sonnet-4-20250514",
        });
        console.log("[iris-handover] Handover salvo no Supabase com embedding.");
      } catch (supaErr) {
        console.warn(
          `[iris-handover] Falhou ao salvar no Supabase (handover local OK): ${supaErr instanceof Error ? supaErr.message : String(supaErr)}`,
        );
      }
    } catch (err) {
      // Silent fallback — must not crash the compaction
      console.warn(
        `[iris-handover] Falhou ao gerar handover: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
