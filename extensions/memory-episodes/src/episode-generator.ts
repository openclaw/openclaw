/**
 * Episode Generator
 *
 * Takes a session transcript (messages) and produces a structured episode
 * summary using an LLM via the OpenAI-compatible chat completions API
 * (works with OpenRouter, local proxies, etc).
 */

export type ExtractionConfig = {
  model: string;
  baseUrl: string;
  apiKey: string;
  maxSummaryTokens: number;
};

export type EpisodeSummary = {
  summary: string;
  keyDecisions: string[];
  filesTouched: string[];
  tasksCompleted: string[];
  tasksPending: string[];
  errorsEncountered: string[];
};

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

const EXTRACTION_SYSTEM_PROMPT = `You are summarizing a completed work session between a user and an AI assistant.

Return JSON with these exact keys:
- summary: string (2-4 sentences, understandable without the original transcript)
- key_decisions: string[] (why major decisions were made)
- files_touched: string[] (exact file paths where known)
- tasks_completed: string[] (what was finished)
- tasks_pending: string[] (unfinished work that matters next session)
- errors_encountered: string[] (significant errors, not transient ones)

Rules:
- The summary must be understandable without the original transcript
- Include WHY major decisions were made, not just what
- Keep file paths exact where known
- tasks_pending should capture unfinished work that matters in the next session
- Omit temporary details that do not matter beyond this session
- Return ONLY valid JSON, no markdown fences`;

/** Minimum messages needed to justify generating an episode. */
export const MIN_MESSAGES_FOR_EPISODE = 4;

/** Extract text content from a transcript message. */
function extractText(msg: TranscriptMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!)
      .join("\n");
  }
  return "";
}

/** Build a compact transcript for the LLM (role: text). */
function buildCompactTranscript(messages: TranscriptMessage[], maxChars = 30_000): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const msg of messages) {
    const role = msg.role ?? "unknown";
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractText(msg).trim();
    if (!text) {
      continue;
    }
    const truncated = text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
    const line = `${role}: ${truncated}`;
    if (totalChars + line.length > maxChars) {
      break;
    }
    lines.push(line);
    totalChars += line.length;
  }

  return lines.join("\n\n");
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
};

export async function generateEpisode(
  messages: TranscriptMessage[],
  config: ExtractionConfig,
): Promise<EpisodeSummary> {
  const transcript = buildCompactTranscript(messages);
  if (!transcript) {
    throw new Error("Empty transcript, cannot generate episode");
  }

  // OpenAI-compatible chat completions (works with OpenRouter)
  const url = `${config.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxSummaryTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: `Session transcript:\n\n${transcript}` },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Extraction LLM error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  if (data.error) {
    throw new Error(`Extraction LLM error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Extraction LLM returned empty response");
  }

  // Parse JSON response, stripping markdown fences if present
  const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse extraction response as JSON: ${cleaned.slice(0, 200)}`);
  }

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    keyDecisions: toStringArray(parsed.key_decisions),
    filesTouched: toStringArray(parsed.files_touched),
    tasksCompleted: toStringArray(parsed.tasks_completed),
    tasksPending: toStringArray(parsed.tasks_pending),
    errorsEncountered: toStringArray(parsed.errors_encountered),
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}
