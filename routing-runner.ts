#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SingleField = "audience" | "stance" | "safety" | "exposure" | "pace" | "authority";
export type MultiField = "urgency" | "population" | "interaction" | "outcomes" | "boundaries";

export const SINGLE_FIELDS: SingleField[] = [
  "audience",
  "stance",
  "safety",
  "exposure",
  "pace",
  "authority",
];
export const MULTI_FIELDS: MultiField[] = [
  "urgency",
  "population",
  "interaction",
  "outcomes",
  "boundaries",
];
const RELAX_LEVEL: Record<string, number> = {
  pace: 1,
  interaction: 2,
  stance: 3,
};

export interface Card {
  id: string;
  card_number: number;
  name: string;
  attrs: Record<string, string[]>;
  witness_seed: WizardInput;
}

export interface WizardInput {
  audience: string;
  stance: string;
  safety: string;
  exposure: string;
  pace: string;
  authority: string;
  urgency: string[];
  population: string[];
  interaction: string[];
  outcomes: string[];
  boundaries: string[];
}

export interface RoutingSpec {
  schema_version: string;
  band_rules: {
    intent_band: Array<{
      id: string;
      if_urgency_any: string[];
      priority: number;
    }>;
    risk_band: Array<{
      id: string;
      if_safety_any: string[];
      or_urgency_any?: string[];
    }>;
    cadence_band: Record<string, string[]>;
    authority_band: Record<string, string[]>;
  };
  selection_policy: {
    top_k: number;
    slots: Array<{
      id: string;
      label: string;
      objective: string;
    }>;
    weights: Record<string, number>;
    fallback_order: string[];
    non_relaxable_first: string[];
  };
  groups: RoutingGroup[];
}

export interface RoutingGroup {
  id: string;
  label: string;
  when: {
    intent_band?: string[];
    risk_band?: string[];
    authority_band?: string[];
    cadence_band?: string[];
  };
  slot_recipes: Record<
    string,
    {
      must_match: Record<string, string[]>;
      seed_card_ids: string[];
    }
  >;
  commercial_hint: {
    primary: string;
    secondary: string[];
    add_ons: string[];
    enterprise: boolean;
  };
}

export interface MemorySignals {
  accepted_card_ids?: string[];
  rejected_card_ids?: string[];
  recently_shown_card_ids?: string[];
}

export interface Recommendation {
  card_id: string;
  card_name: string;
  slot: string;
  slot_label: string;
  match_confidence: number;
  score: number;
  fallback_level: number;
  why_this_showed_up: string[];
  tradeoffs: string[];
  commercial_hint: RoutingGroup["commercial_hint"];
}

export interface RecommendDebug {
  derived_bands: {
    intent_band: string[];
    risk_band: string;
    authority_band: string;
    cadence_band: string;
  };
  matched_groups_exact: string[];
  matched_groups_partial: string[];
  chosen_group_id: string;
  chosen_group_mode: "exact" | "partial";
  slot_fallback_levels: Record<string, number>;
}

export interface RecommendResult {
  recommendations: Recommendation[];
  debug: RecommendDebug;
}

export const DEFAULT_SPEC_PATH = path.resolve(process.cwd(), "routing-groups.v1.json");
export const DEFAULT_CARDS_PATH = path.resolve(process.cwd(), "cards.metadata.merged64.json");
export const DEFAULT_REPORT_PATH = path.resolve(process.cwd(), "routing-groups.coverage-report.md");

export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith("--")) {
      continue;
    }
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function intersects(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) {
    return false;
  }
  const setB = new Set(b);
  for (const v of a) {
    if (setB.has(v)) {
      return true;
    }
  }
  return false;
}

export function overlapCount(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0) {
    return 0;
  }
  const setB = new Set(b);
  let n = 0;
  for (const v of a) {
    if (setB.has(v)) {
      n++;
    }
  }
  return n;
}

export function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function getCards(cardsPath: string): Card[] {
  const raw = readJson<{ cards: Card[] }>(cardsPath);
  return raw.cards;
}

export function deriveBands(
  spec: RoutingSpec,
  input: WizardInput,
): RecommendDebug["derived_bands"] {
  const intentMatches = spec.band_rules.intent_band
    .filter((r) => intersects(input.urgency, r.if_urgency_any))
    .toSorted((a, b) => a.priority - b.priority)
    .map((r) => r.id);
  const intentBand = intentMatches.length > 0 ? intentMatches : ["discovery"];

  let riskBand = "medium_uneven";
  for (const r of spec.band_rules.risk_band) {
    const safetyMatch = r.if_safety_any.includes(input.safety);
    const urgencyMatch = intersects(input.urgency, r.or_urgency_any ?? []);
    if ((r.or_urgency_any && (safetyMatch || urgencyMatch)) || (!r.or_urgency_any && safetyMatch)) {
      riskBand = r.id;
      break;
    }
  }

  let cadenceBand = "short_cycle";
  for (const [band, values] of Object.entries(spec.band_rules.cadence_band)) {
    if (values.includes(input.pace)) {
      cadenceBand = band;
      break;
    }
  }

  let authorityBand = "advisory";
  for (const [band, values] of Object.entries(spec.band_rules.authority_band)) {
    if (values.includes(input.authority)) {
      authorityBand = band;
      break;
    }
  }

  return {
    intent_band: intentBand,
    risk_band: riskBand,
    authority_band: authorityBand,
    cadence_band: cadenceBand,
  };
}

export function groupMatchScore(
  group: RoutingGroup,
  bands: RecommendDebug["derived_bands"],
): { exact: boolean; score: number } {
  let score = 0;
  let checks = 0;
  let matched = 0;

  const entries: Array<[keyof RoutingGroup["when"], string[] | undefined, string[]]> = [
    ["intent_band", group.when.intent_band, bands.intent_band],
    ["risk_band", group.when.risk_band, [bands.risk_band]],
    ["authority_band", group.when.authority_band, [bands.authority_band]],
    ["cadence_band", group.when.cadence_band, [bands.cadence_band]],
  ];

  for (const [, expected, actual] of entries) {
    if (!expected || expected.length === 0) {
      continue;
    }
    checks++;
    const ok = intersects(expected, actual);
    if (ok) {
      matched++;
      score += 1;
    }
  }

  return { exact: checks > 0 && matched === checks, score };
}

export function isHardConflict(input: WizardInput, card: Card): boolean {
  if (input.safety === "unknown" && input.exposure === "identified_trusted_group") {
    if (
      !card.attrs.exposure.includes("anonymous") &&
      !card.attrs.exposure.includes("pseudonymous")
    ) {
      return true;
    }
  }

  if (
    input.stance === "care_before_clarity" &&
    card.attrs.boundaries.includes("performance_evaluations")
  ) {
    return true;
  }

  const highRisk =
    input.safety === "fragile" ||
    input.safety === "unknown" ||
    input.urgency.includes("risk_ethics_accountability");
  if (highRisk && input.authority === "none" && card.attrs.outcomes.includes("clear_direction")) {
    return true;
  }

  if (
    input.outcomes.includes("unresolved_tension") &&
    !card.attrs.outcomes.includes("unresolved_tension") &&
    card.attrs.outcomes.includes("clear_direction")
  ) {
    return true;
  }

  return false;
}

export function cardMatchesMust(
  card: Card,
  must: Record<string, string[]>,
  relaxLevel: number,
): boolean {
  for (const [field, wanted] of Object.entries(must)) {
    const requiredAt = RELAX_LEVEL[field];
    if (requiredAt !== undefined && relaxLevel >= requiredAt) {
      continue;
    }
    const values = card.attrs[field] ?? [];
    if (!intersects(values, wanted)) {
      return false;
    }
  }
  return true;
}

export function scoreCard(
  spec: RoutingSpec,
  card: Card,
  input: WizardInput,
  slotId: string,
  seedIds: string[],
  memory?: MemorySignals,
): number {
  const w = spec.selection_policy.weights;
  let score = 0;

  for (const field of SINGLE_FIELDS) {
    if ((card.attrs[field] ?? []).includes(input[field])) {
      score += w.single_match;
    }
  }

  score += overlapCount(card.attrs.urgency, input.urgency) * w.multi_overlap;
  score += overlapCount(card.attrs.population, input.population) * w.multi_overlap;
  score += overlapCount(card.attrs.interaction, input.interaction) * w.multi_overlap;
  score += overlapCount(card.attrs.outcomes, input.outcomes) * w.outcome_overlap;
  score += overlapCount(card.attrs.boundaries, input.boundaries) * w.boundary_overlap;

  if (card.attrs.authority.includes(input.authority)) {
    score += w.authority_match_bonus;
  }
  if (card.attrs.pace.includes(input.pace)) {
    score += w.pace_match_bonus;
  }
  if (card.attrs.safety.includes(input.safety)) {
    score += w.safety_match_bonus;
  }

  if (seedIds.includes(card.id)) {
    score += 3;
  }

  if (slotId === "safer_governed") {
    const protectedCount = overlapCount(card.attrs.boundaries, [
      "verdicts_judgments",
      "attribution_to_individuals",
      "public_commitments",
      "consensus_statements",
      "performance_evaluations",
    ]);
    score += protectedCount * 2;
  }

  if (slotId === "faster_lighter") {
    const fastPace = overlapCount(card.attrs.pace, ["one_time", "short_cycle_weeks"]);
    const asyncBias = overlapCount(card.attrs.interaction, ["async_over_time"]);
    const livePenalty =
      card.attrs.interaction.length === 1 && card.attrs.interaction[0] === "live_conversation"
        ? 1
        : 0;
    score += fastPace * 3 + asyncBias * 2 - livePenalty * 2;
  }

  if (memory) {
    if ((memory.accepted_card_ids ?? []).includes(card.id)) {
      score += w.memory_accept_boost;
    }
    if ((memory.rejected_card_ids ?? []).includes(card.id)) {
      score += w.memory_reject_penalty;
    }
    if ((memory.recently_shown_card_ids ?? []).includes(card.id)) {
      score += w.recent_shown_penalty;
    }
  }

  return score;
}

export function explainWhy(card: Card, input: WizardInput): string[] {
  const notes: string[] = [];
  for (const field of SINGLE_FIELDS) {
    if ((card.attrs[field] ?? []).includes(input[field])) {
      notes.push(`matched ${field}=${input[field]}`);
    }
  }
  const multiNotes: Array<[MultiField, string[]]> = [
    ["urgency", input.urgency],
    ["population", input.population],
    ["interaction", input.interaction],
    ["outcomes", input.outcomes],
    ["boundaries", input.boundaries],
  ];
  for (const [field, values] of multiNotes) {
    const overlap = (card.attrs[field] ?? []).filter((v) => values.includes(v));
    if (overlap.length > 0) {
      notes.push(`overlap ${field}: ${overlap.join(", ")}`);
    }
  }
  return notes.slice(0, 6);
}

export function explainTradeoffs(card: Card, input: WizardInput): string[] {
  const tradeoffs: string[] = [];
  for (const field of SINGLE_FIELDS) {
    if (!(card.attrs[field] ?? []).includes(input[field])) {
      tradeoffs.push(`${field} differs (${input[field]})`);
    }
  }
  return tradeoffs.slice(0, 4);
}

export function pickGroup(spec: RoutingSpec, bands: RecommendDebug["derived_bands"]) {
  const exact: string[] = [];
  const partial: Array<{ id: string; score: number }> = [];

  for (const g of spec.groups) {
    const m = groupMatchScore(g, bands);
    if (m.exact) {
      exact.push(g.id);
    }
    if (m.score > 0) {
      partial.push({ id: g.id, score: m.score });
    }
  }

  partial.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const chosen = exact.length > 0 ? exact[0] : (partial[0]?.id ?? spec.groups[0].id);
  const mode: "exact" | "partial" = exact.length > 0 ? "exact" : "partial";
  return { chosen, mode, exact, partial: partial.map((p) => p.id) };
}

export function recommend(
  spec: RoutingSpec,
  cards: Card[],
  input: WizardInput,
  memory?: MemorySignals,
): RecommendResult {
  const bands = deriveBands(spec, input);
  const groupPick = pickGroup(spec, bands);
  const group = spec.groups.find((g) => g.id === groupPick.chosen) ?? spec.groups[0];
  const selected: Recommendation[] = [];
  const used = new Set<string>();
  const slotFallbackLevels: Record<string, number> = {};

  for (const slot of spec.selection_policy.slots) {
    const recipe = group.slot_recipes[slot.id];
    if (!recipe) {
      continue;
    }

    let picked: Recommendation | null = null;
    for (let relax = 0; relax <= 3; relax++) {
      const candidates = cards
        .filter((c) => !used.has(c.id))
        .filter((c) => !isHardConflict(input, c))
        .filter((c) => cardMatchesMust(c, recipe.must_match, relax))
        .map((c) => ({
          card: c,
          score: scoreCard(spec, c, input, slot.id, recipe.seed_card_ids, memory),
        }))
        .toSorted((a, b) => b.score - a.score || a.card.card_number - b.card.card_number);

      if (candidates.length === 0) {
        continue;
      }

      const bestScore = candidates[0].score || 1;
      const row = candidates[0];
      picked = {
        card_id: row.card.id,
        card_name: row.card.name,
        slot: slot.id,
        slot_label: slot.label,
        match_confidence: Number(Math.max(0, Math.min(1, row.score / bestScore)).toFixed(2)),
        score: row.score,
        fallback_level: relax,
        why_this_showed_up: explainWhy(row.card, input),
        tradeoffs: explainTradeoffs(row.card, input),
        commercial_hint: group.commercial_hint,
      };
      slotFallbackLevels[slot.id] = relax;
      break;
    }

    if (picked) {
      selected.push(picked);
      used.add(picked.card_id);
    }
  }

  if (selected.length < spec.selection_policy.top_k) {
    const backfill = cards
      .filter((c) => !used.has(c.id))
      .filter((c) => !isHardConflict(input, c))
      .map((c) => ({ card: c, score: scoreCard(spec, c, input, "best_fit_now", [], memory) }))
      .toSorted((a, b) => b.score - a.score || a.card.card_number - b.card.card_number);

    for (const row of backfill) {
      if (selected.length >= spec.selection_policy.top_k) {
        break;
      }
      const slot = spec.selection_policy.slots[selected.length];
      selected.push({
        card_id: row.card.id,
        card_name: row.card.name,
        slot: slot?.id ?? `backfill_${selected.length + 1}`,
        slot_label: slot?.label ?? `Backfill ${selected.length + 1}`,
        match_confidence: 0.35,
        score: row.score,
        fallback_level: 4,
        why_this_showed_up: explainWhy(row.card, input),
        tradeoffs: explainTradeoffs(row.card, input),
        commercial_hint: group.commercial_hint,
      });
      used.add(row.card.id);
    }
  }

  return {
    recommendations: selected.slice(0, spec.selection_policy.top_k),
    debug: {
      derived_bands: bands,
      matched_groups_exact: groupPick.exact,
      matched_groups_partial: groupPick.partial,
      chosen_group_id: group.id,
      chosen_group_mode: groupPick.mode,
      slot_fallback_levels: slotFallbackLevels,
    },
  };
}

export function baselineInputFromSingles(single: Record<SingleField, string>): WizardInput {
  return {
    ...single,
    urgency: ["lived_experience"],
    population: ["specific_stakeholder"],
    interaction: ["async_over_time"],
    outcomes: ["partial_clarity", "unresolved_tension"],
    boundaries: ["attribution_to_individuals"],
  };
}

export function generateCoverageReport(spec: RoutingSpec, cards: Card[], outPath: string): string {
  const audience = [
    "org_project",
    "consultant_researcher_facilitator",
    "educator",
    "learning_method",
  ];
  const stance = [
    "listening_without_responding",
    "learning_without_fixing",
    "awareness_before_action",
    "care_before_clarity",
    "holding_tension",
    "supporting_decisions_without_agreement",
  ];
  const safety = ["fragile", "uneven", "stable", "unknown"];
  const exposure = ["anonymous", "pseudonymous", "identified_trusted_group", "mixed"];
  const pace = ["one_time", "short_cycle_weeks", "ongoing_longitudinal", "undetermined"];
  const authority = ["none", "advisory", "exists_not_exercised_here", "exists_exercised_later"];

  let total = 0;
  let exactGroup = 0;
  let partialGroup = 0;
  let lessThan3 = 0;
  const byGroup = new Map<string, number>();
  const fallbackUse = new Map<number, number>();

  for (const a of audience) {
    for (const st of stance) {
      for (const sa of safety) {
        for (const ex of exposure) {
          for (const pa of pace) {
            for (const au of authority) {
              total++;
              const input = baselineInputFromSingles({
                audience: a,
                stance: st,
                safety: sa,
                exposure: ex,
                pace: pa,
                authority: au,
              });
              const result = recommend(spec, cards, input);
              if (result.debug.chosen_group_mode === "exact") {
                exactGroup++;
              } else {
                partialGroup++;
              }
              if (result.recommendations.length < 3) {
                lessThan3++;
              }
              byGroup.set(
                result.debug.chosen_group_id,
                (byGroup.get(result.debug.chosen_group_id) ?? 0) + 1,
              );
              for (const lvl of Object.values(result.debug.slot_fallback_levels)) {
                fallbackUse.set(lvl, (fallbackUse.get(lvl) ?? 0) + 1);
              }
            }
          }
        }
      }
    }
  }

  let witnessHit = 0;
  const witnessRows: string[] = [];
  for (const c of cards) {
    const result = recommend(spec, cards, c.witness_seed);
    const inTop3 = result.recommendations.some((r) => r.card_id === c.id);
    if (inTop3) {
      witnessHit++;
    }
    witnessRows.push(
      `| ${c.id} | ${result.debug.chosen_group_id} | ${inTop3 ? "yes" : "no"} | ${result.debug.chosen_group_mode} |`,
    );
  }

  const groupRows = [...byGroup.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([id, count]) => `| ${id} | ${count} | ${((count / total) * 100).toFixed(2)}% |`)
    .join("\n");

  const fallbackRows = [...fallbackUse.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([level, count]) => `| ${level} | ${count} |`)
    .join("\n");

  const md = `# Routing Groups Coverage Report\n\nGenerated from:\n- \`${DEFAULT_SPEC_PATH}\`\n- \`${DEFAULT_CARDS_PATH}\`\n\n## Summary\n- Single-choice combinations evaluated: **${total}**\n- Group matched in exact mode: **${exactGroup}**\n- Group matched in partial mode: **${partialGroup}**\n- Returns with fewer than 3 cards: **${lessThan3}**\n- Card witness self-hit in top-3: **${witnessHit}/${cards.length}**\n\n## Group Catch Distribution (single-choice grid)\n| Group | Combos Caught | Share |\n|---|---:|---:|\n${groupRows}\n\n## Fallback Invocation Counts\nFallback level meaning:\n- \`0\` strict recipe\n- \`1\` relax \`pace\`\n- \`2\` relax \`pace + interaction\`\n- \`3\` relax \`pace + interaction + stance\`\n- \`4\` global backfill\n\n| Fallback Level | Slot Selections |\n|---:|---:|\n${fallbackRows}\n\n## Witness Routing Check (64 cards)\n| Card | Routed Group | Card in Top-3 | Group Mode |\n|---|---|---|---|\n${witnessRows.join("\n")}\n\n## Notes\n- This report uses a baseline multi-select profile for the single-choice grid:\n  - \`urgency=[lived_experience]\`\n  - \`population=[specific_stakeholder]\`\n  - \`interaction=[async_over_time]\`\n  - \`outcomes=[partial_clarity, unresolved_tension]\`\n  - \`boundaries=[attribution_to_individuals]\`\n- Use real wizard traffic replay to refine group thresholds and memory boosts.\n`;

  fs.writeFileSync(outPath, md, "utf8");
  return md;
}

export function printUsage() {
  process.stdout.write(
    `Usage:\n` +
      `  bun routing-runner.ts recommend --input /path/to/input.json [--spec routing-groups.v1.json] [--cards cards.metadata.merged64.json] [--memory /path/to/memory.json]\\n` +
      `  bun routing-runner.ts coverage-report [--spec routing-groups.v1.json] [--cards cards.metadata.merged64.json] [--out routing-groups.coverage-report.md]\\n`,
  );
}

export function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    process.exit(0);
  }

  const specPath = path.resolve(args.spec ?? DEFAULT_SPEC_PATH);
  const cardsPath = path.resolve(args.cards ?? DEFAULT_CARDS_PATH);
  const spec = readJson<RoutingSpec>(specPath);
  const cards = getCards(cardsPath);

  if (cmd === "recommend") {
    const inputPath = args.input ? path.resolve(args.input) : "";
    if (!inputPath) {
      throw new Error("Missing --input JSON file");
    }
    const input = readJson<WizardInput>(inputPath);
    const memory = args.memory ? readJson<MemorySignals>(path.resolve(args.memory)) : undefined;
    const result = recommend(spec, cards, input, memory);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (cmd === "coverage-report") {
    const outPath = path.resolve(args.out ?? DEFAULT_REPORT_PATH);
    generateCoverageReport(spec, cards, outPath);
    process.stdout.write(`${outPath}\n`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  main();
}
