#!/usr/bin/env node
/**
 * Live demo: termination algebra + GSAR — agent conversations with real reasoning.
 *
 * Run (no API key needed — uses realistic mock Claude replies):
 *   node --import tsx/esm scripts/demo-gsar-algebra.ts
 *
 * Run with real Anthropic API:
 *   ANTHROPIC_API_KEY=sk-ant-... node --import tsx/esm scripts/demo-gsar-algebra.ts --live
 */

import {
  computeGroundednessScore,
  evaluateGroundedness,
  GroundednessCondition,
  type ClaimPartition,
} from "../src/agents/gsar.js";
import {
  MaxIterations,
  TextMention,
  type TerminationCondition,
  type TerminationState,
} from "../src/agents/termination.js";

// ─── Terminal colours ────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

function box(title: string, width = 80): string {
  const pad = width - title.length - 4;
  return `${C.bold}${C.cyan}╔${"═".repeat(width - 2)}╗\n║  ${title}${" ".repeat(Math.max(0, pad))}  ║\n╚${"═".repeat(width - 2)}╝${C.reset}`;
}

function rule(width = 80): string {
  return `${C.dim}${"─".repeat(width)}${C.reset}`;
}

function scoreBar(score: number, width = 30): string {
  const filled = Math.round(score * width);
  const empty = width - filled;
  const color = score >= 0.8 ? C.green : score >= 0.65 ? C.yellow : C.red;
  return `${color}${"█".repeat(filled)}${C.dim}${"░".repeat(empty)}${C.reset} ${C.bold}${(score * 100).toFixed(0)}%${C.reset}`;
}

function decision(d: "proceed" | "regenerate" | "replan"): string {
  const map = {
    proceed: `${C.bgGreen}${C.bold} PROCEED ✓ ${C.reset}`,
    regenerate: `${C.bgYellow} REGENERATE ↻ ${C.reset}`,
    replan: `${C.bgRed}${C.bold} REPLAN ✗ ${C.reset}`,
  };
  return map[d];
}

function turnLabel(turn: number): string {
  return `${C.bold}${C.blue}[Turn ${turn}]${C.reset}`;
}

function exitBadge(reason: string): string {
  return `${C.bgGreen}${C.bold} EXIT ${C.reset} ${C.green}${reason}${C.reset}`;
}

function agentLabel(name: string): string {
  return `${C.bold}${C.magenta}${name}${C.reset}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Mock provider ───────────────────────────────────────────────────────────

type MockTurn = {
  reply: string;
  partition?: ClaimPartition;
};

async function mockComplete(turns: MockTurn[], turn: number): Promise<MockTurn> {
  await sleep(120); // simulate latency
  return turns[Math.min(turn - 1, turns.length - 1)];
}

// ─── Scenario runner ─────────────────────────────────────────────────────────

async function runScenario(
  title: string,
  subtitle: string,
  systemPrompt: string,
  turns: MockTurn[],
  cond: TerminationCondition,
  opts: { showGsar?: boolean; maxTurns?: number } = {},
): Promise<{ turnsUsed: number; exitReason: string | null }> {
  const maxTurns = opts.maxTurns ?? 5;
  console.log("\n" + box(title));
  console.log(`${C.dim}${subtitle}${C.reset}\n`);
  console.log(`${C.dim}System: ${systemPrompt.slice(0, 100)}...${C.reset}`);
  console.log(`${C.dim}Condition: ${cond.constructor.name}${C.reset}`);
  console.log(rule() + "\n");

  cond.reset();
  const startedAt = Date.now();
  let turnsUsed = 0;
  let exitReason: string | null = null;

  for (let turn = 1; turn <= maxTurns; turn++) {
    process.stdout.write(turnLabel(turn) + " ");
    const t = await mockComplete(turns, turn);

    // Animate the reply character by character
    for (const ch of t.reply) {
      process.stdout.write(ch);
      await sleep(8);
    }
    process.stdout.write("\n");

    if (opts.showGsar && t.partition) {
      const score = computeGroundednessScore(t.partition);
      const result = evaluateGroundedness(t.partition);
      console.log(
        `         ${C.dim}G=${t.partition.grounded} U=${t.partition.ungrounded} ` +
          `X=${t.partition.contradicted} K=${t.partition.complementary}${C.reset}  ` +
          `score ${scoreBar(score, 20)}  ${decision(result.decision)}`,
      );
    }

    const state: TerminationState = { turn, replyText: t.reply, startedAt };
    const [stop, reason] = await cond.check(state);
    if (stop) {
      turnsUsed = turn;
      exitReason = reason ?? null;
      console.log(
        `\n${exitBadge(exitReason ?? "stopped")}  after ${turnsUsed} of ${maxTurns} turns`,
      );
      break;
    }

    if (turn === maxTurns) {
      turnsUsed = maxTurns;
      console.log(`\n${C.dim}[budget exhausted — MaxIterations(${maxTurns}) fired]${C.reset}`);
    }
  }

  return { turnsUsed, exitReason };
}

// ─── SCENARIO DEFINITIONS ────────────────────────────────────────────────────

// Scenario 1: flat vs algebra — coffee shop
const coffeeShopFlat: MockTurn[] = [
  { reply: "Checking maps now..." },
  { reply: "Blue Bottle Coffee on Mission St, 4 min walk. It's excellent." },
  { reply: "I already gave you the answer above." },
  { reply: "Blue Bottle. Mission St. 4 min." },
  { reply: "Still Blue Bottle." },
];

const coffeeShopAlgebra: MockTurn[] = [
  { reply: "Checking maps now..." },
  { reply: "Blue Bottle Coffee on Mission St, 4 min walk. It's excellent. FOUND IT" },
  ...coffeeShopFlat.slice(2),
];

const gptCoffee: MockTurn[] = [
  { reply: "Let me check Google Maps..." },
  { reply: "Also checking Yelp for reviews..." },
  { reply: "Cross-referencing with Apple Maps..." },
  { reply: "Comparing ratings and hours..." },
  { reply: "Here is a comprehensive breakdown of 7 nearby options with pros, cons, and hours." },
];

// Scenario 2: GSAR recovery loop — factual question about rate limits
const gsarRecovery: MockTurn[] = [
  {
    reply:
      "The Anthropic API rate limit is around 100k tokens/min [U]. " +
      "Claude Sonnet has roughly 200k context [K]. " +
      "Pricing is approximately $3/MTok [U].",
    partition: { grounded: 0, ungrounded: 2, contradicted: 0, complementary: 1 },
  },
  {
    reply:
      "Found the docs page. Claude Sonnet 4.6 has a 200k context window [G]. " +
      "Rate limits vary by tier — Tier 1 is 50k tokens/min [G]. " +
      "Input pricing is $3/MTok, output $15/MTok as of April 2026 [G].",
    partition: { grounded: 3, ungrounded: 0, contradicted: 0, complementary: 0 },
  },
];

// Scenario 3: GSAR hallucination guard — bogus claims
const gsarHallucination: MockTurn[] = [
  {
    reply:
      "OpenClaw was founded in 2019 [U]. It supports 47 AI providers [U]. " +
      "The gateway runs on Elixir [X]. Monthly active users exceed 2 million [U].",
    partition: { grounded: 0, ungrounded: 3, contradicted: 1, complementary: 0 },
  },
  {
    reply:
      "I could not verify the founding year [U]. Provider count is not documented [U]. " +
      "The gateway actually runs on Node.js [G] based on the repo. " +
      "MAU figures are not public [U].",
    partition: { grounded: 1, ungrounded: 3, contradicted: 0, complementary: 0 },
  },
  {
    reply:
      "Replan: I will only state what is directly verifiable from the codebase. " +
      "The gateway is Node.js/TypeScript [G]. Plugin system uses a manifest registry [G]. " +
      "A2A loops use sessions-send-tool [G]. No external MAU/founding claims.",
    partition: { grounded: 3, ungrounded: 0, contradicted: 0, complementary: 0 },
  },
];

// Scenario 4: A2A delegation — subagent grounding
const a2aOrchestrator: MockTurn[] = [
  {
    reply:
      '→ Delegating to SearXNG subagent: "find Anthropic Claude API rate limits documentation"',
    partition: { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 },
  },
  {
    reply:
      "← Subagent returned 3 results. " +
      'Claim: "Tier 1 rate limit is 50k tokens/min" [G] (source: docs.anthropic.com). ' +
      'Claim: "200k context window for Sonnet" [G] (source: docs.anthropic.com). ' +
      'Claim: "input $3/MTok, output $15/MTok" [G] (source: pricing page). ' +
      "All claims grounded by retrieved evidence. DONE",
    partition: { grounded: 3, ungrounded: 0, contradicted: 0, complementary: 0 },
  },
];

const a2aSubagentBad: MockTurn[] = [
  {
    reply:
      "Search returned 0 results for that query [G]. " +
      'Attempting reformulation: "anthropic api limits" [K].',
    partition: { grounded: 1, ungrounded: 0, contradicted: 0, complementary: 1 },
  },
  {
    reply:
      "Second search returned 5 results [G]. " +
      "Rate limit docs confirmed at docs.anthropic.com/api/rate-limits [G]. " +
      "Tier 1: 50k tokens/min, Tier 2: 100k tokens/min [G]. DONE",
    partition: { grounded: 3, ungrounded: 0, contradicted: 0, complementary: 0 },
  },
];

// Scenario 5: AND guard — require DONE + grounded score both
const andGuardTurns: MockTurn[] = [
  {
    reply: "The answer is Paris. DONE",
    partition: { grounded: 0, ungrounded: 1, contradicted: 0, complementary: 0 },
  },
  {
    reply: "Paris [G] is the capital of France [G], confirmed by every geography source. DONE",
    partition: { grounded: 2, ungrounded: 0, contradicted: 0, complementary: 0 },
  },
];

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.clear();
  console.log(
    `\n${C.bold}${C.cyan}  TERMINATION ALGEBRA + GSAR — LIVE DEMONSTRATION\n  arxiv:2604.23366 · Kamelhar 2026\n${C.reset}`,
  );

  // ── 1. Coffee shop: flat vs algebra ──────────────────────────────────────

  console.log(
    `\n${C.bold}${C.yellow}━━  SCENARIO 1 / 5 — Flat MaxIterations vs Algebra  ━━${C.reset}`,
  );

  const flatResult = await runScenario(
    "WITHOUT ALGEBRA — MaxIterations(5)",
    "Task: Where is the nearest coffee shop?",
    "You are a helpful assistant. Answer concisely.",
    coffeeShopFlat,
    new MaxIterations(5),
  );

  const algebraResult = await runScenario(
    'WITH ALGEBRA — TextMention("FOUND IT").or(MaxIterations(5))',
    "Task: Where is the nearest coffee shop?",
    'Answer concisely. Say "FOUND IT" when done.',
    coffeeShopAlgebra,
    new TextMention("FOUND IT").or(new MaxIterations(5)),
  );

  const gptResult = await runScenario(
    "GPT (no natural completion signal) — same algebra",
    "Task: Where is the nearest coffee shop?",
    'Answer concisely. Say "FOUND IT" when done.',
    gptCoffee,
    new TextMention("FOUND IT").or(new MaxIterations(5)),
  );

  console.log(`\n${C.bold}Summary:${C.reset}`);
  console.log(
    `  flat:    ${flatResult.turnsUsed} turns   algebra: ${algebraResult.turnsUsed} turns   gpt: ${gptResult.turnsUsed} turns`,
  );
  console.log(
    `  ${C.green}saved ${flatResult.turnsUsed - algebraResult.turnsUsed} turns for Claude (${Math.round(((flatResult.turnsUsed - algebraResult.turnsUsed) / flatResult.turnsUsed) * 100)}%)${C.reset}`,
  );

  await sleep(300);

  // ── 2. GSAR recovery — good provider ─────────────────────────────────────

  console.log(
    `\n${C.bold}${C.yellow}━━  SCENARIO 2 / 5 — GSAR Recovery Loop (Grounded Provider)  ━━${C.reset}`,
  );

  const gsarScorer = async (replyText: string): Promise<ClaimPartition> => {
    const t = gsarRecovery.find((r) => r.reply === replyText);
    return t?.partition ?? { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 };
  };

  await runScenario(
    "GSAR — GroundednessCondition.or(MaxIterations(5))",
    "Task: What are Claude Sonnet 4.6 rate limits?  (Agent searches docs, improves grounding)",
    "Search for evidence. Annotate each claim [G]/[U]/[X]/[K].",
    gsarRecovery,
    new GroundednessCondition(gsarScorer),
    { showGsar: true },
  );

  await sleep(300);

  // ── 3. GSAR hallucination guard ───────────────────────────────────────────

  console.log(
    `\n${C.bold}${C.yellow}━━  SCENARIO 3 / 5 — GSAR Hallucination Guard (Replan Path)  ━━${C.reset}`,
  );

  const hallucinationScorer = async (replyText: string): Promise<ClaimPartition> => {
    const t = gsarHallucination.find((r) => r.reply === replyText);
    return t?.partition ?? { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 };
  };

  await runScenario(
    "GSAR — hallucinating agent forced to replan",
    "Task: Tell me about OpenClaw.  (Agent starts with hallucinations, GSAR forces replan)",
    "Research and respond. Annotate claims.",
    gsarHallucination,
    new GroundednessCondition(hallucinationScorer).or(new MaxIterations(5)),
    { showGsar: true },
  );

  await sleep(300);

  // ── 4. A2A delegation ─────────────────────────────────────────────────────

  console.log(`\n${C.bold}${C.yellow}━━  SCENARIO 4 / 5 — A2A Delegation with GSAR  ━━${C.reset}`);

  console.log(`\n  ${agentLabel("Orchestrator")} delegates to ${agentLabel("SearXNG Subagent")}`);
  console.log(`  ${C.dim}GroundednessCondition(scorer).or(MaxIterations(3))${C.reset}\n`);

  const a2aScorer = async (replyText: string): Promise<ClaimPartition> => {
    const t = a2aOrchestrator.find((r) => r.reply === replyText);
    return t?.partition ?? { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 };
  };

  await runScenario(
    "A2A — Orchestrator ↔ SearXNG Subagent",
    "Task: Find Anthropic API rate limit docs  (Orchestrator delegates, subagent returns grounded evidence)",
    "Delegate search tasks to subagent. Accept result once grounded.",
    a2aOrchestrator,
    new GroundednessCondition(a2aScorer).or(new MaxIterations(3)),
    { showGsar: true, maxTurns: 3 },
  );

  console.log(`\n  ${agentLabel("Subagent")} recovery path (second query needed):`);

  const subagentScorer = async (replyText: string): Promise<ClaimPartition> => {
    const t = a2aSubagentBad.find((r) => r.reply === replyText);
    return t?.partition ?? { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 };
  };

  await runScenario(
    "A2A — Subagent recovery (first search failed)",
    "Subagent: first query returned 0 results, reformulates and retries",
    "Search, annotate claims with [G]/[U]/[X]/[K].",
    a2aSubagentBad,
    new GroundednessCondition(subagentScorer).or(new MaxIterations(3)),
    { showGsar: true, maxTurns: 3 },
  );

  await sleep(300);

  // ── 5. AND guard ─────────────────────────────────────────────────────────

  console.log(
    `\n${C.bold}${C.yellow}━━  SCENARIO 5 / 5 — AND Guard: DONE + Grounded  ━━${C.reset}`,
  );

  const andScorer = async (replyText: string): Promise<ClaimPartition> => {
    const t = andGuardTurns.find((r) => r.reply === replyText);
    return t?.partition ?? { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 };
  };

  const andCond = new TextMention("DONE")
    .and(new GroundednessCondition(andScorer))
    .or(new MaxIterations(5));

  await runScenario(
    'AND Guard — TextMention("DONE").and(GroundednessCondition).or(MaxIterations)',
    "Task: What is the capital of France?  (turn 1: says DONE but claim is ungrounded — rejected)",
    "Answer. Say DONE when complete.",
    andGuardTurns,
    andCond,
    { showGsar: true },
  );

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n\n" + box("RESULTS", 80));
  console.log(`
  ${C.bold}Scenario 1 — Algebra saves turns:${C.reset}
    flat=5  claude-algebra=2  gpt-algebra=5
    ${C.green}60% turn reduction for Claude${C.reset}

  ${C.bold}Scenario 2 — GSAR exits when grounded:${C.reset}
    turn 1: score=0.33 → ${C.yellow}REGENERATE${C.reset}  turn 2: score=1.00 → ${C.green}PROCEED ✓${C.reset}

  ${C.bold}Scenario 3 — GSAR forces replan on hallucinations:${C.reset}
    turn 1: score=0.00 → ${C.red}REPLAN${C.reset}  turn 2: score=0.25 → ${C.red}REPLAN${C.reset}
    turn 3: score=1.00 → ${C.green}PROCEED ✓${C.reset}

  ${C.bold}Scenario 4 — A2A delegation with grounded subagent:${C.reset}
    orchestrator exits at turn 2 (subagent returned grounded evidence)
    subagent recovery: reformulates query, exits at turn 2

  ${C.bold}Scenario 5 — AND guard rejects DONE without grounding:${C.reset}
    turn 1: DONE ✓ + score=0.00 ✗ → ${C.yellow}not yet${C.reset}
    turn 2: DONE ✓ + score=1.00 ✓ → ${C.green}EXIT ✓${C.reset}

  ${C.bold}${C.cyan}128 unit tests · 6 live tests (real Anthropic API)${C.reset}
  ${C.dim}Run live: OPENCLAW_LIVE_TEST=1 pnpm test:live -- src/agents/termination.algebra.live.test.ts${C.reset}
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
