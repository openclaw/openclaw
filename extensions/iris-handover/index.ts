import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginConfig = {
  anthropicAuthToken?: string; // OAuth/setup token (sk-ant-oat01-...). Prioridade sobre anthropicApiKey.
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
// Auth resolution
// ---------------------------------------------------------------------------

/** Remove espaços, tabs e quebras de linha que podem corromper tokens */
function normalizeSecret(raw: string): string {
  return raw.replace(/[\r\n\t]/g, "").trim();
}

type AnthropicCreds =
  | { source: string; mode: "oauth"; authToken: string }
  | { source: string; mode: "apikey"; apiKey: string };

/**
 * Resolve credenciais Anthropic com ordem de precedência definida.
 *
 * Ordem:
 *   1. config.anthropicAuthToken (OAuth explícito)
 *   2. config.anthropicApiKey (API key explícita — ou OAuth legado com warning)
 *   3. auth-profiles.json do agente (preferindo lastGood[anthropic])
 *   4. ANTHROPIC_AUTH_TOKEN env (OAuth — lido nativamente pelo SDK)
 *   5. ANTHROPIC_API_KEY env (legado — detecta OAuth por prefixo)
 */
function resolveAnthropicCreds(config: PluginConfig, agentId = "main"): AnthropicCreds | null {
  // 1. Config explícita: campo OAuth dedicado
  if (config.anthropicAuthToken) {
    return {
      source: "config.anthropicAuthToken",
      mode: "oauth",
      authToken: normalizeSecret(config.anthropicAuthToken),
    };
  }

  // 2. Config explícita: campo de API key (mas pode ser OAuth legado)
  if (config.anthropicApiKey) {
    const key = normalizeSecret(config.anthropicApiKey);
    if (key.startsWith("sk-ant-oat")) {
      console.warn(
        "[iris-handover] config.anthropicApiKey parece ser um OAuth token (sk-ant-oat...). " +
          "Prefira usar config.anthropicAuthToken para tokens OAuth. Tratando como legacy oauth.",
      );
      return { source: "config.anthropicApiKey (legacy oauth)", mode: "oauth", authToken: key };
    }
    return { source: "config.anthropicApiKey", mode: "apikey", apiKey: key };
  }

  // 3. Auth-profiles store: ~/.openclaw/agents/{agentId}/agent/auth-profiles.json
  try {
    const storePath = path.join(
      os.homedir(),
      ".openclaw",
      "agents",
      agentId,
      "agent",
      "auth-profiles.json",
    );
    const raw = fs.readFileSync(storePath, "utf-8");
    const store = JSON.parse(raw) as {
      profiles?: Record<string, unknown>;
      lastGood?: Record<string, string>;
    };
    const profiles = store.profiles ?? {};
    const lastGoodId = store.lastGood?.["anthropic"];

    // Montar lista de candidatos: lastGood primeiro, depois os demais ordenados
    const typeOrder: Record<string, number> = { api_key: 0, token: 1, oauth: 2 };
    const candidates: [string, Record<string, string>][] = [];
    if (lastGoodId && profiles[lastGoodId]) {
      candidates.push([lastGoodId, profiles[lastGoodId] as Record<string, string>]);
    }
    const others = Object.entries(profiles)
      .filter(
        ([id, v]) => id !== lastGoodId && (v as Record<string, string>).provider === "anthropic",
      )
      .sort(([, a], [, b]) => {
        return (
          (typeOrder[(a as Record<string, string>).type] ?? 9) -
          (typeOrder[(b as Record<string, string>).type] ?? 9)
        );
      });
    for (const [id, cred] of others) candidates.push([id, cred as Record<string, string>]);

    for (const [profileId, c] of candidates) {
      if (c.provider !== "anthropic") continue;
      if (c.type === "api_key" && c.key) {
        return {
          source: `auth-profiles (${profileId})`,
          mode: "apikey",
          apiKey: normalizeSecret(c.key),
        };
      }
      if (c.type === "token" && c.token) {
        return {
          source: `auth-profiles (${profileId})`,
          mode: "oauth",
          authToken: normalizeSecret(c.token),
        };
      }
      if (c.type === "oauth" && c.access) {
        return {
          source: `auth-profiles (${profileId})`,
          mode: "oauth",
          authToken: normalizeSecret(c.access),
        };
      }
    }
  } catch {
    // Store ausente ou malformado — continua para env vars
  }

  // 4. Env OAuth dedicada (diferente de ANTHROPIC_API_KEY — não é lida automaticamente como apiKey)
  const envAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (envAuthToken) {
    return {
      source: "ANTHROPIC_AUTH_TOKEN env",
      mode: "oauth",
      authToken: normalizeSecret(envAuthToken),
    };
  }

  // 5. Env legacy: ANTHROPIC_API_KEY (pode conter OAuth token colocado no lugar errado)
  const envApiKey = process.env.ANTHROPIC_API_KEY;
  if (envApiKey) {
    const key = normalizeSecret(envApiKey);
    if (key.startsWith("sk-ant-oat")) {
      console.warn(
        "[iris-handover] ANTHROPIC_API_KEY contém OAuth token (sk-ant-oat...). " +
          "Use ANTHROPIC_AUTH_TOKEN para tokens OAuth. Tratando como legacy oauth.",
      );
      return { source: "ANTHROPIC_API_KEY env (legacy oauth)", mode: "oauth", authToken: key };
    }
    return { source: "ANTHROPIC_API_KEY env", mode: "apikey", apiKey: key };
  }

  return null;
}

/**
 * Instancia o Anthropic SDK com opções MUTUAMENTE EXCLUSIVAS.
 *
 * CRÍTICO: Sempre passar null explicitamente no campo não-usado.
 * O SDK v0.39.0 auto-lê process.env.ANTHROPIC_API_KEY como `apiKey` por padrão.
 * Se apiKey não for null, ele prevalece sobre authToken (X-Api-Key tem prioridade).
 * OAuth token em X-Api-Key → 401 invalid x-api-key.
 */
function createAnthropicClient(creds: AnthropicCreds): Anthropic {
  if (creds.mode === "oauth") {
    return new Anthropic({ apiKey: null, authToken: creds.authToken });
  }
  return new Anthropic({ apiKey: creds.apiKey, authToken: null });
}

// Exported for testing
export { resolveAnthropicCreds, createAnthropicClient, type AnthropicCreds };

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

  // Verificação em registration time (usa agentId "main" como padrão)
  const registrationCreds = resolveAnthropicCreds(config);
  if (!registrationCreds) {
    console.warn(
      "[iris-handover] Nenhuma credencial Anthropic encontrada. " +
        "Fontes verificadas: config.anthropicAuthToken, config.anthropicApiKey, " +
        "auth-profiles.json, ANTHROPIC_AUTH_TOKEN env, ANTHROPIC_API_KEY env. " +
        "Plugin desativado.",
    );
    return;
  }
  console.log(
    `[iris-handover] Plugin registrado. Credencial: ${registrationCreds.source} (modo: ${registrationCreds.mode})`,
  );

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

    // Call Anthropic SDK with properly resolved credentials
    const agentId = ctx.agentId ?? "main";
    let creds: AnthropicCreds | null = null;
    try {
      creds = resolveAnthropicCreds(config, agentId);
      if (!creds) throw new Error("Sem credencial Anthropic disponível");
      const client = createAnthropicClient(creds);
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
        `[iris-handover] Falhou ao gerar handover` +
          (creds ? ` (fonte: ${creds.source}, modo: ${creds.mode})` : "") +
          `:\n  ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
