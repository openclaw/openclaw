// Suggests changes to the curated recommended-models list: prints a markdown
// review report ending in a unified diff against the list file.
//   node --import ./scripts/tsx.mjs scripts/suggest-recommended-models.mts [--list <path>]
// OPENROUTER_API_KEY enables the usage signal. The ranking is LMArena Agent
// Arena score, then OpenRouter 30-day usage; the newest served family member
// without its own Arena row takes the slot of its newest ranked older sibling.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  canonicalModelFamily,
  canonicalModelKey,
  compareModelRecency,
} from "@openclaw/model-catalog-core";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const SCRIPT_LABEL = "suggest-recommended-models";
const DEFAULT_LIST_PATH = "scripts/lib/recommended-models.json";
// A daily run with a week of overlap, so a skipped day loses nothing.
const NEW_MODEL_DAYS = 7;
const NEW_CLASS_PRICE_RATIO = 2;
const LIST_KEY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const NON_CHAT =
  /embed|(^|[^a-z])tts([^a-z]|$)|transcri|whisper|speech|audio|realtime|moderation|rerank|(^|[-/ .])image|dall-e|imagen|flux|video|(^|[-/])veo|sora|hailuo|(^|[-/])ocr|voice|voxtral|sonic|music|lyria|guard/;
// Catalog provider that releases each model line. When every one of its rows
// for a model is deprecated or replaced, the model is retired on every host.
const FIRST_PARTY_PROVIDERS: Array<[RegExp, string]> = [
  [/^claude-/, "anthropic"],
  [/^(gpt|o\d)/, "openai"],
  [/^gemini/, "google"],
  [/^kimi/, "moonshot"],
  [/^glm/, "zai"],
  [/^deepseek/, "deepseek"],
  [/^qwen/, "qwen"],
  [/^grok/, "xai"],
  [/^muse/, "meta"],
  [/^(mistral|devstral|codestral|magistral|ministral|pixtral)/, "mistral"],
  [/^command/, "cohere"],
  [/^mimo/, "xiaomi"],
  [/^step/, "stepfun"],
  [/^longcat/, "longcat"],
  [/^hy\d/, "tencent-tokenhub"],
];
const SOURCES = {
  arena:
    "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=agent&split=latest&offset=0&length=100",
  catalog: "https://catalog.openclaw.ai/models/v2/catalog.json",
  openRouterModels: "https://openrouter.ai/api/v1/models",
  openRouterRankings: "https://openrouter.ai/api/v1/datasets/rankings-daily",
  vercelModels: "https://ai-gateway.vercel.sh/v1/models",
};

const arenaSchema = z.object({
  num_rows_total: z.number(),
  rows: z.array(
    z.object({
      row: z.object({
        model_name: z.string(),
        score: z.number(),
        rank: z.number(),
        category: z.string(),
        leaderboard_publish_date: z.string(),
      }),
    }),
  ),
});
const catalogSchema = z.object({
  generatedAt: z.number(),
  models: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      name: z.string().optional(),
      status: z.string().optional(),
      replacedBy: z.string().optional(),
      pricing: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
    }),
  ),
});
const openRouterModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      // "Vendor: Model"; rankings-daily permaslugs name models by canonical_slug.
      name: z.string(),
      canonical_slug: z.string(),
      created: z.number().optional(),
      architecture: z.object({ output_modalities: z.array(z.string()) }),
      pricing: z.object({ prompt: z.coerce.number(), completion: z.coerce.number() }).optional(),
    }),
  ),
});
const vercelModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      released: z.number().optional(),
      created: z.number().optional(),
    }),
  ),
});
const rankingsSchema = z.object({
  data: z.array(
    z.object({ date: z.string(), model_permaslug: z.string(), total_tokens: z.coerce.number() }),
  ),
  meta: z.object({ as_of: z.string(), start_date: z.string(), end_date: z.string() }),
});

type ArenaRow = z.infer<typeof arenaSchema>["rows"][number]["row"];
type ModelPrice = { input: number; output: number };

/** Every run fetches fresh; a failed or malformed response fails the run. */
async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return schema.parse(await response.json());
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatPrice(price: ModelPrice | undefined): string {
  return price ? `$${Number(price.input.toFixed(3))} / $${Number(price.output.toFixed(3))}` : "?";
}

export async function suggestRecommendedModels(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { list: { type: "string" } },
    strict: true,
  });
  const rootDir = resolveRepoRoot(import.meta.url);
  const listPath = path.resolve(rootDir, values.list ?? DEFAULT_LIST_PATH);
  if (!fs.existsSync(listPath)) {
    throw new Error(`curated list ${listPath} not found; pass --list <path>`);
  }
  const listText = fs.readFileSync(listPath, "utf8");
  const curated = z.array(z.string()).parse(JSON.parse(listText));
  const now = Date.now();

  const apiKey = process.env.OPENROUTER_API_KEY;
  const [arenaPage, catalog, openRouter, vercel, rankings] = await Promise.all([
    fetchJson(SOURCES.arena, arenaSchema),
    fetchJson(SOURCES.catalog, catalogSchema),
    fetchJson(SOURCES.openRouterModels, openRouterModelsSchema),
    fetchJson(SOURCES.vercelModels, vercelModelsSchema),
    apiKey
      ? fetchJson(SOURCES.openRouterRankings, rankingsSchema, {
          Authorization: `Bearer ${apiKey}`,
        })
      : undefined,
  ]);
  if (arenaPage.num_rows_total > arenaPage.rows.length) {
    throw new Error(
      `Arena has ${arenaPage.num_rows_total} rows; the page holds ${arenaPage.rows.length}`,
    );
  }
  const arenaRows = arenaPage.rows
    .map(({ row }) => row)
    .filter((row) => row.category === "overall");

  // Display names resolve dated aliases (mistral-small-2603 is Mistral Small 4).
  const catalogRows = catalog.models.map((model) => ({
    ...model,
    key: canonicalModelKey(model.id, model.name),
  }));
  const openRouterModels = openRouter.data.map((model) => ({
    ...model,
    key: canonicalModelKey(model.id, model.name.replace(/^[^:]*:\s*/, "")),
  }));
  const vercelModels = vercel.data.map((model) => ({
    ...model,
    key: canonicalModelKey(model.id, model.name),
  }));
  const retired = new Map<string, string | undefined>();
  const firstPartyRows = new Map<string, typeof catalogRows>();
  for (const row of catalogRows) {
    if (FIRST_PARTY_PROVIDERS.find(([pattern]) => pattern.test(row.key))?.[1] === row.provider) {
      firstPartyRows.set(row.key, [...(firstPartyRows.get(row.key) ?? []), row]);
    }
  }
  for (const [key, rows] of firstPartyRows) {
    if (
      rows.every(
        (row) => row.replacedBy || row.status === "deprecated" || row.status === "disabled",
      )
    ) {
      const replaced = rows.find((row) => row.replacedBy);
      const replacement = catalogRows.find(
        (row) => row.provider === replaced?.provider && row.id === replaced.replacedBy,
      );
      retired.set(key, replacement?.key);
    }
  }

  // Gateways label output modality; one non-text label excludes the model
  // everywhere because catalog rows only carry ids and names.
  const nonChat = new Set([
    ...openRouterModels
      .filter((model) => model.architecture.output_modalities.join(",") !== "text")
      .map((model) => model.key),
    ...vercelModels.filter((model) => model.type !== "language").map((model) => model.key),
  ]);
  const candidates = new Set<string>();
  const addCandidate = (key: string, text: string) => {
    if (
      !NON_CHAT.test(text.toLowerCase()) &&
      !nonChat.has(key) &&
      !retired.has(key) &&
      LIST_KEY.test(key) &&
      // Moving aliases name no fixed model.
      !key.endsWith("-latest")
    ) {
      candidates.add(key);
    }
  };
  for (const row of catalogRows) {
    if (!row.replacedBy && row.status !== "deprecated" && row.status !== "disabled") {
      addCandidate(row.key, `${row.id} ${row.name ?? ""}`);
    }
  }
  for (const model of [...openRouterModels, ...vercelModels]) {
    addCandidate(model.key, model.id);
  }

  // List prices per 1M tokens: the first party's catalog row, else OpenRouter.
  // Free tiers (zero) say nothing about a model's class.
  const prices = new Map<string, ModelPrice>();
  const notePrice = (key: string, input = 0, output = 0) => {
    if (input > 0 && output > 0 && !prices.has(key)) {
      prices.set(key, { input, output });
    }
  };
  for (const [key, rows] of firstPartyRows) {
    for (const row of rows) {
      notePrice(key, row.pricing?.input, row.pricing?.output);
    }
  }
  for (const model of openRouterModels) {
    // Variant ids (:free, :nitro) carry promotional prices.
    if (model.pricing && !model.id.includes(":")) {
      notePrice(model.key, model.pricing.prompt * 1e6, model.pricing.completion * 1e6);
    }
  }

  const releasedAt = new Map<string, number>();
  const noteRelease = (key: string, seconds: number | undefined) => {
    if (seconds && seconds * 1000 < (releasedAt.get(key) ?? Infinity)) {
      releasedAt.set(key, seconds * 1000);
    }
  };
  for (const model of openRouterModels) {
    noteRelease(model.key, model.created);
  }
  for (const model of vercelModels) {
    noteRelease(model.key, model.released ?? model.created);
  }

  const arena = new Map<string, ArenaRow>();
  for (const row of arenaRows) {
    const key = canonicalModelKey(row.model_name);
    // Effort variants (High, Max) collapse into one model; the best score counts.
    if (!(row.score <= (arena.get(key)?.score ?? -Infinity))) {
      arena.set(key, row);
    }
  }
  const keyBySlug = new Map(openRouterModels.map((model) => [model.canonical_slug, model.key]));
  const usage = new Map<string, number>();
  for (const row of rankings?.data ?? []) {
    if (row.model_permaslug !== "other") {
      const slug = row.model_permaslug.replace(/:.*/, "");
      const key = keyBySlug.get(slug) ?? canonicalModelKey(slug);
      usage.set(key, (usage.get(key) ?? 0) + row.total_tokens);
    }
  }

  const families = new Map<string, string[]>();
  for (const key of candidates) {
    const family = canonicalModelFamily(key).name;
    families.set(family, [...(families.get(family) ?? []), key]);
  }
  const newestOf = (keys: string[]) =>
    keys.reduce((newest, key) => (compareModelRecency(key, newest, releasedAt) > 0 ? key : newest));
  const inherits = new Map<string, string>();
  const effectiveUsage = new Map(usage);
  for (const keys of families.values()) {
    const latest = newestOf(keys);
    const ranked = keys.filter(
      (key) =>
        (arena.has(key) || usage.has(key)) && compareModelRecency(latest, key, releasedAt) > 0,
    );
    if (arena.has(latest) || ranked.length === 0) {
      continue;
    }
    const sibling = newestOf(ranked);
    // A successor with no Arena row of its own takes an Arena-ranked sibling's
    // slot; with no usage yet, it also takes a usage-ranked sibling's slot. It
    // counts the sibling's usage too, so it ties at least level and sorts first.
    if (arena.has(sibling) || !usage.has(latest)) {
      inherits.set(latest, sibling);
      effectiveUsage.set(latest, Math.max(usage.get(latest) ?? 0, usage.get(sibling) ?? 0));
    }
  }
  const arenaRowOf = (key: string) => arena.get(inherits.get(key) ?? key);
  // Usage breaks ties, then successors sort ahead of the sibling they inherit from.
  const byUsage = (a: string, b: string) =>
    (effectiveUsage.get(b) ?? 0) - (effectiveUsage.get(a) ?? 0) ||
    Number(!inherits.has(a)) - Number(!inherits.has(b)) ||
    a.localeCompare(b);
  const scored = [...candidates]
    .filter((key) => arenaRowOf(key))
    .toSorted((a, b) => arenaRowOf(b)!.score - arenaRowOf(a)!.score || byUsage(a, b));
  const scoredKeys = new Set(scored);
  // Without usage data, curated entries the Arena does not rank keep their order.
  const unscored = rankings
    ? [...candidates]
        .filter((key) => !scoredKeys.has(key) && effectiveUsage.get(key))
        .toSorted(byUsage)
    : curated.filter((key) => candidates.has(key) && !scoredKeys.has(key));
  const suggested = [...scored, ...unscored];

  const signalOf = (key: string) => {
    const via = inherits.has(key) ? ` via ${inherits.get(key)}` : "";
    const row = arenaRowOf(key);
    if (row) {
      return `Arena ${row.score.toFixed(3)} (#${row.rank})${via}`;
    }
    if (!rankings) {
      return "kept: no usage data";
    }
    const tokens = effectiveUsage.get(key)!;
    const amount =
      tokens >= 1e12 ? `${(tokens / 1e12).toFixed(1)}T` : `${Math.round(tokens / 1e9)}B`;
    return `OpenRouter ${amount}${via}`;
  };
  const curatedKeys = new Set(curated);
  const suggestedKeys = new Set(suggested);
  const position = (list: readonly string[], key: string) => list.indexOf(key) + 1;

  const lines = [
    `# Recommended models suggestion, ${formatDate(now)}`,
    "",
    "## Sources",
    `- LMArena Agent Arena, published ${arenaRows[0]?.leaderboard_publish_date ?? "?"}: ${arenaRows.length} rows, ${arena.size} models. Source: LMArena Agent Arena (lmarena-ai/leaderboard-dataset), CC BY 4.0.`,
    rankings
      ? `- OpenRouter rankings-daily ${rankings.meta.start_date}..${rankings.meta.end_date}. Source: OpenRouter (openrouter.ai/rankings), as of ${rankings.meta.as_of}. Licensed under CC BY 4.0.`
      : "- OpenRouter usage skipped: OPENROUTER_API_KEY is unset, so curated entries without an Arena score keep their order.",
    `- Catalog v2 generated ${formatDate(catalog.generatedAt)} (${catalog.models.length} rows), OpenRouter models (${openRouter.data.length}), Vercel AI Gateway models (${vercel.data.length}): ${candidates.size} served chat models.`,
  ];

  const newModels = [...candidates]
    .filter(
      (key) =>
        !curatedKeys.has(key) &&
        now - (releasedAt.get(key) ?? 0) <= NEW_MODEL_DAYS * 24 * 60 * 60 * 1000,
    )
    .toSorted((a, b) => releasedAt.get(b)! - releasedAt.get(a)!);
  lines.push("", `## New models (first seen in the last ${NEW_MODEL_DAYS} days, not listed)`);
  if (newModels.length === 0) {
    lines.push("", "None.");
  } else {
    lines.push(
      "",
      "| model | first seen | suggested | price in/out per 1M | predecessor | predecessor price | note |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
  }
  const known = [...new Set([...candidates, ...curated])];
  for (const key of newModels) {
    const family = canonicalModelFamily(key).name;
    const older = known.filter(
      (other) =>
        canonicalModelFamily(other).name === family &&
        compareModelRecency(key, other, releasedAt) > 0,
    );
    const predecessor = older.length > 0 ? newestOf(older) : undefined;
    const price = prices.get(key);
    const predecessorPrice = predecessor ? prices.get(predecessor) : undefined;
    const ratio =
      price && predecessorPrice
        ? Math.max(
            price.input / predecessorPrice.input,
            predecessorPrice.input / price.input,
            price.output / predecessorPrice.output,
            predecessorPrice.output / price.output,
          )
        : 1;
    const note = !predecessor
      ? "possible new class: no predecessor"
      : ratio > NEW_CLASS_PRICE_RATIO
        ? `possible new class: price ${ratio.toFixed(1)}x`
        : "";
    const rank = suggestedKeys.has(key) ? `#${position(suggested, key)}` : "no signal yet";
    lines.push(
      `| ${key} | ${formatDate(releasedAt.get(key)!)} | ${rank} | ${formatPrice(price)} | ${predecessor ?? "none"} | ${predecessor ? formatPrice(predecessorPrice) : ""} | ${note} |`,
    );
  }

  // Rank among the entries both lists keep, so additions and removals alone
  // move nothing; the largest moves come first.
  const kept = curated.filter((key) => suggestedKeys.has(key));
  const keptSuggested = suggested.filter((key) => curatedKeys.has(key));
  const shift = (key: string) => Math.abs(kept.indexOf(key) - keptSuggested.indexOf(key));
  const moved = keptSuggested
    .filter((key) => shift(key) > 0)
    .toSorted((a, b) => shift(b) - shift(a));
  const arenaMoves = moved.filter((key) => arenaRowOf(key));
  const usageMoves = moved.filter((key) => !arenaRowOf(key));
  lines.push("", "## Arena moves");
  if (arenaMoves.length === 0) {
    lines.push("", "None.");
  } else {
    lines.push("", "| model | listed | suggested | signal |", "| --- | --- | --- | --- |");
    for (const key of arenaMoves) {
      lines.push(
        `| ${key} | #${position(curated, key)} | #${position(suggested, key)} | ${signalOf(key)} |`,
      );
    }
  }
  if (usageMoves.length > 0) {
    lines.push("", `${usageMoves.length} usage-ranked entries also move; see the diff.`);
  }

  const dropped = curated.filter((key) => !suggestedKeys.has(key));
  lines.push("", "## Gone or deprecated", "");
  if (dropped.length === 0) {
    lines.push("None.");
  }
  for (const key of dropped) {
    const reason = retired.has(key)
      ? `retired by its first-party provider${retired.get(key) ? `; replaced by ${retired.get(key)}` : ""}`
      : candidates.has(key)
        ? "no Arena score and no OpenRouter usage in the window"
        : "no host serves it";
    lines.push(`- ${key}: ${reason}`);
  }

  const suggestedText = `${JSON.stringify(suggested, null, 2)}\n`;
  const relativeListPath = path.relative(rootDir, listPath);
  lines.push(
    "",
    "## Suggested list",
    "",
    `<details><summary>${suggested.length} models</summary>`,
    "",
    "| # | model | signal |",
    "| --- | --- | --- |",
    ...suggested.map((key, index) => `| ${index + 1} | ${key} | ${signalOf(key)} |`),
    "",
    "</details>",
    "",
  );
  if (suggestedText === listText) {
    lines.push("No changes to the curated list.");
  } else {
    const patch = createTwoFilesPatch(
      `a/${relativeListPath}`,
      `b/${relativeListPath}`,
      listText,
      suggestedText,
    );
    // Drop jsdiff's "=====" separator so the block reads as a plain unified diff.
    lines.push("```diff", patch.slice(patch.indexOf("---")).trimEnd(), "```");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await suggestRecommendedModels(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[${SCRIPT_LABEL}] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
