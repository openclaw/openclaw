#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CARDS_PATH,
  DEFAULT_SPEC_PATH,
  type Card,
  type RoutingSpec,
  type WizardInput,
  parseArgs,
  readJson,
  recommend,
  deriveBands,
} from "./routing-runner.ts";

interface CardsFile {
  enums_reference: Record<string, string[]>;
  cards: Card[];
}

interface MultiTemplate {
  urgency: string[];
  population: string[];
  interaction: string[];
  outcomes: string[];
  boundaries: string[];
}

interface BucketAccumulator {
  key: string;
  support: number;
  macro_group_id: string;
  selectors: {
    audience: string;
    stance: string;
    safety: string;
    exposure: string;
    pace: string;
    authority: string;
    intent_band: string[];
    risk_band: string;
    authority_band: string;
    cadence_band: string;
    masks: {
      urgency: string;
      population: string;
      interaction: string;
      outcomes: string;
      boundaries: string;
    };
  };
  trio: {
    card_ids: string[];
    card_names: string[];
  };
  confidence_sum: number;
  confidence_min: number;
  confidence_max: number;
  representative_input: WizardInput;
}

type SelectionMode = "support" | "balanced";

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN<T>(items: T[], n: number): T[] {
  if (items.length <= n) {
    return [...items];
  }
  return items.slice(0, n);
}

function sortStrings(values: string[]): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

function templateKey(t: MultiTemplate): string {
  return [
    sortStrings(t.urgency).join(","),
    sortStrings(t.population).join(","),
    sortStrings(t.interaction).join(","),
    sortStrings(t.outcomes).join(","),
    sortStrings(t.boundaries).join(","),
  ].join("|");
}

function makeMask(enumList: string[], selected: string[]): string {
  const set = new Set(selected);
  const bits = enumList.map((v) => (set.has(v) ? "1" : "0")).join("");
  const num = Number.parseInt(bits, 2);
  return num.toString(16).padStart(Math.max(1, Math.ceil(bits.length / 4)), "0");
}

function buildPrimaryKey(
  input: WizardInput,
  spec: RoutingSpec,
  enums: CardsFile["enums_reference"],
  macroGroupId: string,
): {
  key: string;
  selectors: BucketAccumulator["selectors"];
} {
  const bands = deriveBands(spec, input);
  const selectors: BucketAccumulator["selectors"] = {
    audience: input.audience,
    stance: input.stance,
    safety: input.safety,
    exposure: input.exposure,
    pace: input.pace,
    authority: input.authority,
    intent_band: bands.intent_band,
    risk_band: bands.risk_band,
    authority_band: bands.authority_band,
    cadence_band: bands.cadence_band,
    masks: {
      urgency: makeMask(enums.urgency, input.urgency),
      population: makeMask(enums.population, input.population),
      interaction: makeMask(enums.interaction, input.interaction),
      outcomes: makeMask(enums.outcomes, input.outcomes),
      boundaries: makeMask(enums.boundaries, input.boundaries),
    },
  };

  const key = [
    `g=${macroGroupId}`,
    `a=${selectors.audience}`,
    `st=${selectors.stance}`,
    `sa=${selectors.safety}`,
    `ex=${selectors.exposure}`,
    `pa=${selectors.pace}`,
    `au=${selectors.authority}`,
    `ib=${selectors.intent_band.join("+")}`,
    `rb=${selectors.risk_band}`,
    `ab=${selectors.authority_band}`,
    `cb=${selectors.cadence_band}`,
    `um=${selectors.masks.urgency}`,
    `pm=${selectors.masks.population}`,
    `im=${selectors.masks.interaction}`,
    `om=${selectors.masks.outcomes}`,
    `bm=${selectors.masks.boundaries}`,
  ].join("|");

  return { key, selectors };
}

function dedupeTemplates(cards: Card[]): MultiTemplate[] {
  const seen = new Map<string, MultiTemplate>();
  for (const c of cards) {
    const t: MultiTemplate = {
      urgency: sortStrings(c.witness_seed.urgency),
      population: sortStrings(c.witness_seed.population),
      interaction: sortStrings(c.witness_seed.interaction),
      outcomes: sortStrings(c.witness_seed.outcomes),
      boundaries: sortStrings(c.witness_seed.boundaries),
    };
    const k = templateKey(t);
    if (!seen.has(k)) {
      seen.set(k, t);
    }
  }
  return [...seen.values()];
}

function randomSubset(rand: () => number, options: string[], min = 1, max = 2): string[] {
  const n = Math.min(options.length, Math.max(min, Math.floor(rand() * (max - min + 1)) + min));
  const copy = [...options];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

function mutateInput(
  rand: () => number,
  base: WizardInput,
  enums: CardsFile["enums_reference"],
): WizardInput {
  const out: WizardInput = JSON.parse(JSON.stringify(base));

  if (rand() < 0.35) {
    out.safety = enums.safety[Math.floor(rand() * enums.safety.length)];
  }
  if (rand() < 0.35) {
    out.exposure = enums.exposure[Math.floor(rand() * enums.exposure.length)];
  }
  if (rand() < 0.35) {
    out.pace = enums.pace[Math.floor(rand() * enums.pace.length)];
  }
  if (rand() < 0.35) {
    out.authority = enums.authority[Math.floor(rand() * enums.authority.length)];
  }
  if (rand() < 0.3) {
    out.stance = enums.stance[Math.floor(rand() * enums.stance.length)];
  }

  if (rand() < 0.55) {
    out.urgency = randomSubset(rand, enums.urgency, 1, 3);
  }
  if (rand() < 0.55) {
    out.population = randomSubset(rand, enums.population, 1, 2);
  }
  if (rand() < 0.55) {
    out.interaction = randomSubset(rand, enums.interaction, 1, 2);
  }
  if (rand() < 0.55) {
    out.outcomes = randomSubset(rand, enums.outcomes, 1, 3);
  }
  if (rand() < 0.55) {
    out.boundaries = randomSubset(rand, enums.boundaries, 1, 3);
  }

  return out;
}

function forceBucketForCard(
  card: Card,
  spec: RoutingSpec,
  cardsData: CardsFile,
): BucketAccumulator {
  const cards = cardsData.cards;
  const enums = cardsData.enums_reference;
  const rec = recommend(spec, cards, card.witness_seed);
  const top = rec.recommendations
    .map((r) => r.card_id)
    .filter((id) => id !== card.id)
    .slice(0, 2);

  while (top.length < 2) {
    const fallback = cards.find((c) => c.id !== card.id && !top.includes(c.id));
    if (!fallback) {
      break;
    }
    top.push(fallback.id);
  }

  const trioIds = [card.id, ...top].slice(0, 3);
  const trioNames = trioIds.map((id) => cards.find((c) => c.id === id)?.name ?? id);
  const avgConf =
    rec.recommendations.length > 0
      ? rec.recommendations.reduce((sum, r) => sum + r.match_confidence, 0) /
        rec.recommendations.length
      : 0.5;
  const { key: primary, selectors } = buildPrimaryKey(
    card.witness_seed,
    spec,
    enums,
    rec.debug.chosen_group_id,
  );

  return {
    key: `${primary}::forced-${card.id}-${trioIds.join("+")}`,
    support: 0,
    macro_group_id: rec.debug.chosen_group_id,
    selectors,
    trio: {
      card_ids: trioIds,
      card_names: trioNames,
    },
    confidence_sum: avgConf,
    confidence_min: avgConf,
    confidence_max: avgConf,
    representative_input: card.witness_seed,
  };
}

function countByGroup(buckets: BucketAccumulator[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of buckets) {
    counts.set(b.macro_group_id, (counts.get(b.macro_group_id) ?? 0) + 1);
  }
  return counts;
}

function selectBucketsByMode(
  allBucketsSorted: BucketAccumulator[],
  target: number,
  mode: SelectionMode,
  maxGroupShare: number,
): BucketAccumulator[] {
  if (mode === "support") {
    return allBucketsSorted.slice(0, target);
  }

  const groups = new Map<string, BucketAccumulator[]>();
  for (const b of allBucketsSorted) {
    const arr = groups.get(b.macro_group_id);
    if (arr) {
      arr.push(b);
    } else {
      groups.set(b.macro_group_id, [b]);
    }
  }

  const activeGroups = [...groups.keys()];
  if (activeGroups.length === 0) {
    return [];
  }

  // Cap how many any single macro group can take in the balanced phase.
  const shareCap = Math.max(1, Math.floor(target * Math.max(0.01, Math.min(1, maxGroupShare))));
  const groupOrder = [...groups.entries()]
    .toSorted((a, b) => {
      const as = a[1].reduce((sum, x) => sum + x.support, 0);
      const bs = b[1].reduce((sum, x) => sum + x.support, 0);
      return bs - as || a[0].localeCompare(b[0]);
    })
    .map(([id]) => id);

  const picks: BucketAccumulator[] = [];
  const used = new Set<string>();
  const nextIndex = new Map<string, number>();
  const pickedPerGroup = new Map<string, number>();
  for (const g of groupOrder) {
    nextIndex.set(g, 0);
    pickedPerGroup.set(g, 0);
  }

  // Phase 1: balanced round-robin with per-group share cap.
  while (picks.length < target) {
    let progressed = false;
    for (const g of groupOrder) {
      if (picks.length >= target) {
        break;
      }
      if ((pickedPerGroup.get(g) ?? 0) >= shareCap) {
        continue;
      }
      const arr = groups.get(g) ?? [];
      let idx = nextIndex.get(g) ?? 0;
      while (idx < arr.length && used.has(arr[idx].key)) {
        idx++;
      }
      nextIndex.set(g, idx);
      if (idx >= arr.length) {
        continue;
      }
      const pick = arr[idx];
      picks.push(pick);
      used.add(pick.key);
      nextIndex.set(g, idx + 1);
      pickedPerGroup.set(g, (pickedPerGroup.get(g) ?? 0) + 1);
      progressed = true;
    }
    if (!progressed) {
      break;
    }
  }

  // Phase 2: fill remainder by global support ranking if cap/exhaustion blocks target.
  if (picks.length < target) {
    for (const b of allBucketsSorted) {
      if (picks.length >= target) {
        break;
      }
      if (used.has(b.key)) {
        continue;
      }
      picks.push(b);
      used.add(b.key);
    }
  }

  return picks.slice(0, target);
}

function generateBuckets(
  spec: RoutingSpec,
  cardsData: CardsFile,
  target: number,
  templateCount: number,
  randomSamples: number,
  mode: SelectionMode,
  maxGroupShare: number,
): {
  buckets: BucketAccumulator[];
  stats: {
    total_samples: number;
    unique_bucket_candidates: number;
    template_count: number;
    random_samples: number;
    witness_seed_samples: number;
    single_combo_samples: number;
    selection_mode: SelectionMode;
    balanced_max_group_share: number;
    selection_phase1_by_group?: Record<string, number>;
  };
} {
  const cards = cardsData.cards;
  const enums = cardsData.enums_reference;

  const templates = pickN(dedupeTemplates(cards), templateCount);
  const accumulator = new Map<string, BucketAccumulator>();

  let totalSamples = 0;
  let singleComboSamples = 0;
  let witnessSeedSamples = 0;

  function ingest(input: WizardInput) {
    const result = recommend(spec, cards, input);
    if (result.recommendations.length < 3) {
      return;
    }
    const trioIds = result.recommendations.map((r) => r.card_id);
    const trioNames = result.recommendations.map((r) => r.card_name);
    const confidenceAvg =
      result.recommendations.reduce((sum, r) => sum + r.match_confidence, 0) /
      result.recommendations.length;
    const { key: primary, selectors } = buildPrimaryKey(
      input,
      spec,
      enums,
      result.debug.chosen_group_id,
    );
    const fullKey = `${primary}::${trioIds.join("+")}`;

    const existing = accumulator.get(fullKey);
    if (!existing) {
      accumulator.set(fullKey, {
        key: fullKey,
        support: 1,
        macro_group_id: result.debug.chosen_group_id,
        selectors,
        trio: {
          card_ids: trioIds,
          card_names: trioNames,
        },
        confidence_sum: confidenceAvg,
        confidence_min: confidenceAvg,
        confidence_max: confidenceAvg,
        representative_input: input,
      });
      return;
    }

    existing.support += 1;
    existing.confidence_sum += confidenceAvg;
    existing.confidence_min = Math.min(existing.confidence_min, confidenceAvg);
    existing.confidence_max = Math.max(existing.confidence_max, confidenceAvg);
  }

  // 1) Witness seeds
  for (const c of cards) {
    totalSamples++;
    witnessSeedSamples++;
    ingest(c.witness_seed);
  }

  // 2) Full single-choice cartesian x selected multi templates
  const audiences = enums.audience;
  const stances = enums.stance;
  const safeties = enums.safety;
  const exposures = enums.exposure;
  const paces = enums.pace;
  const authorities = enums.authority;

  for (const audience of audiences) {
    for (const stance of stances) {
      for (const safety of safeties) {
        for (const exposure of exposures) {
          for (const pace of paces) {
            for (const authority of authorities) {
              for (const t of templates) {
                const input: WizardInput = {
                  audience,
                  stance,
                  safety,
                  exposure,
                  pace,
                  authority,
                  urgency: t.urgency,
                  population: t.population,
                  interaction: t.interaction,
                  outcomes: t.outcomes,
                  boundaries: t.boundaries,
                };
                totalSamples++;
                singleComboSamples++;
                ingest(input);
              }
            }
          }
        }
      }
    }
  }

  // 3) Random mutations around witness seeds for additional variety
  const rand = mulberry32(102803);
  for (let i = 0; i < randomSamples; i++) {
    const base = cards[Math.floor(rand() * cards.length)]?.witness_seed;
    if (!base) {
      continue;
    }
    const input = mutateInput(rand, base, enums);
    totalSamples++;
    ingest(input);
  }

  const buckets = [...accumulator.values()].toSorted(
    (a, b) => b.support - a.support || a.key.localeCompare(b.key),
  );
  if (buckets.length < target) {
    throw new Error(`Only ${buckets.length} unique buckets generated, below target ${target}`);
  }

  const selected = selectBucketsByMode(buckets, target, mode, maxGroupShare);
  const phase1ByGroup = Object.fromEntries(countByGroup(selected).entries());

  function computeCardCoverage(arr: BucketAccumulator[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const b of arr) {
      for (const id of b.trio.card_ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }

  function missingCardIds(arr: BucketAccumulator[]): string[] {
    const covered = computeCardCoverage(arr);
    return cards.filter((c) => !covered.has(c.id)).map((c) => c.id);
  }

  function chooseReplaceIndex(arr: BucketAccumulator[]): number {
    const counts = computeCardCoverage(arr);
    for (let i = arr.length - 1; i >= 0; i--) {
      const b = arr[i];
      const wouldDropUnique = b.trio.card_ids.some((id) => (counts.get(id) ?? 0) <= 1);
      if (!wouldDropUnique) {
        return i;
      }
    }
    return arr.length - 1;
  }

  // Iteratively enforce full card coverage without shrinking bucket count.
  let guard = 0;
  while (guard < cards.length * 2) {
    guard++;
    const missingIds = missingCardIds(selected);
    if (missingIds.length === 0) {
      break;
    }
    for (const id of missingIds) {
      const card = cards.find((c) => c.id === id);
      if (!card) {
        continue;
      }
      const forced = forceBucketForCard(card, spec, cardsData);
      const idx = chooseReplaceIndex(selected);
      selected[idx] = forced;
    }
  }

  selected.sort((a, b) => b.support - a.support || a.key.localeCompare(b.key));

  return {
    buckets: selected,
    stats: {
      total_samples: totalSamples,
      unique_bucket_candidates: buckets.length,
      template_count: templates.length,
      random_samples: randomSamples,
      witness_seed_samples: witnessSeedSamples,
      single_combo_samples: singleComboSamples,
      selection_mode: mode,
      balanced_max_group_share: maxGroupShare,
      selection_phase1_by_group: phase1ByGroup,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = path.resolve(args.spec ?? DEFAULT_SPEC_PATH);
  const cardsPath = path.resolve(args.cards ?? DEFAULT_CARDS_PATH);
  const target = Number.parseInt(args.target ?? "1028", 10);
  const templateCount = Number.parseInt(args.templates ?? "20", 10);
  const randomSamples = Number.parseInt(args.random ?? "30000", 10);
  const mode = (args.mode ?? "support") as SelectionMode;
  if (mode !== "support" && mode !== "balanced") {
    throw new Error(`Invalid --mode '${mode}'. Expected 'support' or 'balanced'.`);
  }
  const maxGroupShare = Number.parseFloat(args["max-group-share"] ?? "0.22");
  if (!Number.isFinite(maxGroupShare) || maxGroupShare <= 0 || maxGroupShare > 1) {
    throw new Error(
      `Invalid --max-group-share '${args["max-group-share"] ?? ""}'. Expected number in (0,1].`,
    );
  }
  const outPath = path.resolve(
    args.out ?? path.resolve(process.cwd(), `routing-buckets-${target}.v1.json`),
  );

  const spec = readJson<RoutingSpec>(specPath);
  const cardsData = readJson<CardsFile>(cardsPath);

  const generated = generateBuckets(
    spec,
    cardsData,
    target,
    templateCount,
    randomSamples,
    mode,
    maxGroupShare,
  );
  const byGroup: Record<string, number> = {};
  for (const b of generated.buckets) {
    byGroup[b.macro_group_id] = (byGroup[b.macro_group_id] ?? 0) + 1;
  }

  const output = {
    schema_version: `routing-buckets-${target}-v1`,
    generated_at: new Date().toISOString(),
    source: {
      routing_spec: specPath,
      cards: cardsPath,
    },
    generation_params: {
      target_buckets: target,
      template_count: templateCount,
      random_samples: randomSamples,
      mode,
      max_group_share: maxGroupShare,
    },
    stats: {
      ...generated.stats,
      selected_bucket_count: generated.buckets.length,
      by_macro_group: byGroup,
    },
    assignment_contract: {
      key_strategy:
        "Compute primary selectors from wizard input (macro-group + single choices + multi masks), then pick exact key+trio bucket if available; else nearest primary key in same macro-group by max shared selectors.",
      return_size: 3,
    },
    buckets: generated.buckets.map((b, i) => ({
      bucket_id: `B${String(i + 1).padStart(4, "0")}`,
      key: b.key,
      support: b.support,
      macro_group_id: b.macro_group_id,
      selectors: b.selectors,
      trio: b.trio,
      confidence: {
        avg: Number((b.confidence_sum / b.support).toFixed(4)),
        min: Number(b.confidence_min.toFixed(4)),
        max: Number(b.confidence_max.toFixed(4)),
      },
      representative_input: b.representative_input,
    })),
  };

  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
}

main();
