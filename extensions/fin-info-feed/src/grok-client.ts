/**
 * xAI Grok API client for KOL monitoring via x_search.
 *
 * Uses the Responses API (`/v1/responses`) with `x_search` tool to fetch
 * and analyze X/Twitter posts from specified handles.
 */

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";

// ── Types ────────────────────────────────────────────────────────

export type KolNewsItem = {
  id: string;
  source: "x_search";
  handle: string;
  title: string;
  summary: string;
  /** Importance score 1-10 (10 = most urgent) */
  score: number;
  category: string;
  symbols: string[];
  sentiment: "bullish" | "bearish" | "neutral";
  sourceUrls: string[];
  scannedAt: string;
  pushed: boolean;
};

export type ScanResult = {
  items: KolNewsItem[];
  batchCount: number;
  totalHandles: number;
  scannedAt: string;
};

type XaiResponseOutput = {
  type: string;
  content?: Array<{
    type: string;
    text?: string;
    annotations?: Array<{ type: string; url?: string }>;
  }>;
  text?: string;
  annotations?: Array<{ type: string; url?: string }>;
};

type XaiResponse = {
  output?: XaiResponseOutput[];
  output_text?: string;
  citations?: string[];
};

export type SearchKolBatchParams = {
  apiKey: string;
  model: string;
  handles: string[];
  topic?: string;
  fromDate?: string;
  toDate?: string;
  timeoutMs?: number;
};

export type ScanAllKolsParams = {
  apiKey: string;
  model: string;
  handles: string[];
  topic?: string;
  fromDate?: string;
  toDate?: string;
  timeoutMs?: number;
};

// ── Response parsing ─────────────────────────────────────────────

/**
 * Extract text content and citation URLs from xAI Responses API output.
 * Handles three response shapes: message-wrapped, direct output_text blocks,
 * and the deprecated top-level output_text field.
 */
export function extractGrokContent(data: XaiResponse): {
  text: string | undefined;
  citations: string[];
} {
  // Shape 1: message wrapper → output_text blocks
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: block.text, citations: [...new Set(urls)] };
        }
      }
    }
    // Shape 2: direct output_text block (no message wrapper)
    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const rawAnnotations =
        "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
      const urls = rawAnnotations
        .filter((a: { type?: string; url?: string }) => a.type === "url_citation" && typeof a.url === "string")
        .map((a: { type?: string; url?: string }) => a.url as string);
      return { text: output.text, citations: [...new Set(urls)] };
    }
  }
  // Shape 3: deprecated top-level output_text
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, citations: data.citations ?? [] };
}

/**
 * Parse structured KolNewsItem[] from Grok analysis text.
 * Tolerant of markdown fences and partial JSON.
 */
export function parseAnalysisResponse(
  rawText: string,
  citations: string[],
  source: "x_search",
): KolNewsItem[] {
  // Strip markdown code fences if present
  let jsonStr = rawText;
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to find a JSON array in the text
    const arrayMatch = rawText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  const items = Array.isArray(parsed) ? parsed : [];
  const now = new Date().toISOString();

  return items
    .filter((item: unknown): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item): KolNewsItem => {
      const score = Math.max(1, Math.min(10, Number(item.score) || 5));
      const handle = String(item.handle ?? item.author ?? "unknown");
      const title = String(item.title ?? "Untitled").slice(0, 200);
      const summary = String(item.summary ?? item.content ?? "").slice(0, 500);
      const category = String(item.category ?? "general");
      const sentiment = (["bullish", "bearish", "neutral"] as const).includes(
        item.sentiment as "bullish" | "bearish" | "neutral",
      )
        ? (item.sentiment as "bullish" | "bearish" | "neutral")
        : "neutral";
      const symbols = Array.isArray(item.symbols)
        ? (item.symbols as unknown[]).map(String)
        : [];
      const itemUrls = Array.isArray(item.urls)
        ? (item.urls as unknown[]).map(String)
        : [];

      return {
        id: `grok-${handle}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source,
        handle,
        title,
        summary,
        score,
        category,
        symbols,
        sentiment,
        sourceUrls: [...new Set([...itemUrls, ...citations])],
        scannedAt: now,
        pushed: false,
      };
    });
}

// ── API calls ────────────────────────────────────────────────────

const ANALYSIS_PROMPT = `You are a financial intelligence analyst. Analyze the X/Twitter posts found and extract actionable financial intelligence.

For each notable post, return a JSON array with objects containing:
- handle: the @handle of the poster
- title: brief headline (max 100 chars)
- summary: key insight or claim (max 300 chars)
- score: importance 1-10 (10=market-moving, 7+=notable, 4-6=routine, 1-3=noise). Only include items with score >= 4.
- category: one of "market_move", "policy", "earnings", "macro", "crypto", "sector", "opinion", "breaking"
- sentiment: "bullish", "bearish", or "neutral"
- symbols: relevant ticker symbols (e.g. ["BTC", "AAPL"])
- urls: source URLs if available

Return ONLY a JSON array, no other text. If nothing notable found, return [].`;

/**
 * Single x_search batch call (max 10 handles per xAI API limit).
 */
export async function searchKolBatch(params: SearchKolBatchParams): Promise<KolNewsItem[]> {
  const { apiKey, model, handles, topic, fromDate, toDate, timeoutMs = 30_000 } = params;

  if (handles.length === 0) return [];
  if (handles.length > 10) {
    throw new Error("x_search supports max 10 handles per call");
  }

  const userContent = topic
    ? `Analyze recent posts from these KOL handles about: ${topic}`
    : "Analyze recent notable financial posts from these KOL handles";

  const xSearchTool: Record<string, unknown> = {
    type: "x_search",
    allowed_x_handles: handles,
  };
  if (fromDate) xSearchTool.from_date = fromDate;
  if (toDate) xSearchTool.to_date = toDate;

  const body = {
    model,
    instructions: ANALYSIS_PROMPT,
    input: [{ role: "user", content: userContent }],
    tools: [xSearchTool],
  };

  const response = await fetch(XAI_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`xAI API error (${response.status}): ${errText.slice(0, 240)}`);
  }

  const data = (await response.json()) as XaiResponse;
  const { text, citations } = extractGrokContent(data);

  if (!text) return [];
  return parseAnalysisResponse(text, citations, "x_search");
}

/**
 * Scan all KOL handles, auto-splitting into batches of 10.
 * Batches run sequentially to respect rate limits.
 */
export async function scanAllKols(params: ScanAllKolsParams): Promise<ScanResult> {
  const { handles, ...rest } = params;
  const uniqueHandles = [...new Set(handles.map((h) => h.replace(/^@/, "").toLowerCase()))];
  const batchSize = 10;
  const allItems: KolNewsItem[] = [];
  let batchCount = 0;

  for (let i = 0; i < uniqueHandles.length; i += batchSize) {
    const batch = uniqueHandles.slice(i, i + batchSize);
    batchCount++;
    const items = await searchKolBatch({ ...rest, handles: batch });
    allItems.push(...items);
  }

  // Deduplicate by handle+title
  const seen = new Set<string>();
  const dedupedItems = allItems.filter((item) => {
    const key = `${item.handle}:${item.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    items: dedupedItems,
    batchCount,
    totalHandles: uniqueHandles.length,
    scannedAt: new Date().toISOString(),
  };
}
