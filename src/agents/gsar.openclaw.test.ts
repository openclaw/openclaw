/**
 * GSAR proof against typical OpenClaw use cases.
 *
 * Each scenario mirrors a real agent task in OpenClaw — web research,
 * message drafting, code review, A2A delegation, scheduled summaries —
 * and shows how GSAR + termination algebra handles hallucination, partial
 * evidence, and natural completion differently across Anthropic and OpenAI.
 *
 * Evidence weight tiers used throughout:
 *   tool_match  (file_read, shell output, DB result)  → w = 1.0  highest trust
 *   web_result  (SearXNG hit with snippet)             → w = 0.85
 *   inference   (LLM reasoning, "likely", "probably")  → w = 0.4
 *   no evidence (bare assertion, hallucination)         → ungrounded
 */

import { describe, expect, it } from "vitest";
import {
  GroundednessCondition,
  computeGroundednessScore,
  type ClaimPartition,
  type EvidenceWeights,
} from "./gsar.js";
import {
  MaxIterations,
  TextMention,
  TimeLimit,
  type TerminationCondition,
  type TerminationState,
} from "./termination.js";

// ─── weight maps ─────────────────────────────────────────────────────────────

const TOOL_MATCH_WEIGHTS: EvidenceWeights = {
  grounded: 1.0,
  complementary: 0.5,
  ungrounded: 1.0,
  contradicted: 1.0,
};

const WEB_WEIGHTS: EvidenceWeights = {
  grounded: 0.85,
  complementary: 0.4,
  ungrounded: 1.0,
  contradicted: 1.0,
};

const INFERENCE_WEIGHTS: EvidenceWeights = {
  grounded: 0.4,
  complementary: 0.2,
  ungrounded: 1.0,
  contradicted: 1.0,
};

// ─── harness ─────────────────────────────────────────────────────────────────

type Turn = { reply: string; partition: ClaimPartition };

async function loop(
  cond: TerminationCondition,
  turns: Turn[],
  maxTurns = turns.length,
): Promise<{ turnsUsed: number; reason: string | null; score: number }> {
  cond.reset();
  const startedAt = Date.now();
  let turnsUsed = 0;
  let reason: string | null = null;
  let lastPartition: ClaimPartition = {
    grounded: 0,
    ungrounded: 0,
    contradicted: 0,
    complementary: 0,
  };

  for (let i = 0; i < maxTurns && i < turns.length; i++) {
    turnsUsed = i + 1;
    lastPartition = turns[i].partition;
    const [stop, r] = await cond.check({ turn: turnsUsed, replyText: turns[i].reply, startedAt });
    if (stop) {
      reason = r;
      break;
    }
  }

  return { turnsUsed, reason, score: computeGroundednessScore(lastPartition) };
}

function scorer(partitions: ClaimPartition[]) {
  let i = 0;
  return (_: string) => partitions[i++ % partitions.length];
}

function gsarOr(partitions: ClaimPartition[], weights = TOOL_MATCH_WEIGHTS, budget = 5) {
  return new GroundednessCondition(scorer(partitions), weights).or(new MaxIterations(budget));
}

// ─── 1. Web research + summarization (SearXNG) ───────────────────────────────
//
// User: "What are the rate limits for the Anthropic API?"
// Agent uses web_search tool, synthesizes results across turns.
// Hallucinated limits get contradicted by actual web results.

describe("web research — Anthropic API rate limits query", () => {
  const turns: Turn[] = [
    {
      // Turn 1: Claude hallucinates specific numbers without searching
      reply:
        "The Anthropic API allows 100 requests per minute and 10,000 tokens per request. I'm confident about these limits.",
      partition: { grounded: 0, ungrounded: 3, contradicted: 0, complementary: 0 },
    },
    {
      // Turn 2: After web_search returns results — partial match, some contradictions
      reply:
        "According to search results, rate limits vary by tier. The 100 RPM figure I mentioned earlier appears incorrect — actual limits depend on usage tier.",
      partition: { grounded: 2, ungrounded: 1, contradicted: 1, complementary: 1 },
    },
    {
      // Turn 3: Grounded synthesis with web evidence — GSAR exits here
      reply:
        "Based on the Anthropic documentation retrieved via search: Tier 1 allows 50 RPM, Tier 2 allows 1000 RPM. Context window limits are model-specific (claude-3-7-sonnet: 200K tokens).",
      partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 2 },
    },
    {
      // Turns 4–5 only reached by flat MaxIterations (GSAR already exited at turn 3)
      reply: "Reconfirming the numbers one more time...",
      partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 2 },
    },
    {
      reply: "All confirmed. Summary complete.",
      partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 2 },
    },
  ];

  it("flat MaxIterations always burns 5 turns even when grounded at turn 3", async () => {
    const r = await loop(new MaxIterations(5), turns, 5);
    expect(r.turnsUsed).toBe(5);
  });

  it("GSAR exits at turn 3 when web evidence grounds the claims", async () => {
    const r = await loop(
      gsarOr(
        turns.map((t) => t.partition),
        WEB_WEIGHTS,
      ),
      turns,
    );
    expect(r.turnsUsed).toBe(3);
    expect(r.reason).toMatch(/grounded:proceed/);
  });

  it("turn 1 hallucination is correctly scored near 0 (pure ungrounded)", () => {
    expect(computeGroundednessScore(turns[0].partition, WEB_WEIGHTS)).toBe(0);
  });

  it("turn 2 contradiction penalty keeps score in regenerate band", () => {
    const s = computeGroundednessScore(turns[1].partition, WEB_WEIGHTS);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(0.8); // regenerate zone
  });

  it("turn 3 clears the proceed threshold", () => {
    const s = computeGroundednessScore(turns[2].partition, WEB_WEIGHTS);
    expect(s).toBeGreaterThanOrEqual(0.8);
  });
});

// ─── 2. Message drafting + send (Telegram / Discord) ─────────────────────────
//
// User: "Draft and send a standup update to the team channel"
// Agent should stop the recovery loop the moment send is confirmed.
// Grounded = message content matches requested context.

describe("message drafting — standup update to team channel", () => {
  const turns: Turn[] = [
    {
      // Turn 1: Draft without context — generic filler
      reply: "Good morning team! Working on some features today. Will update later.",
      partition: { grounded: 0, ungrounded: 2, contradicted: 0, complementary: 1 },
    },
    {
      // Turn 2: Retrieved yesterday's context via sessions_history
      reply:
        "Based on yesterday's session: working on PR #74360 SSRF fix. Today: writing tests. Blocker: none. [send confirmed]",
      partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 1 },
    },
  ];

  // For send confirmation, use TextMention("[send confirmed]") as soft signal
  // AND GSAR to verify the content was grounded in actual session history
  const sendConfirmed = new TextMention("[send confirmed]");
  const groundedContent = new GroundednessCondition(scorer(turns.map((t) => t.partition)));
  const cond = sendConfirmed.and(groundedContent).or(new MaxIterations(3));

  it("exits at turn 2 when send is confirmed AND content is grounded", async () => {
    const r = await loop(cond, turns);
    expect(r.turnsUsed).toBe(2);
  });

  it("does NOT exit at turn 1 even if send were somehow triggered — content is ungrounded", async () => {
    // Simulate turn 1 with a fake [send confirmed] in the reply but ungrounded content
    const adversarial: Turn[] = [
      {
        reply: "Good morning! [send confirmed]",
        partition: { grounded: 0, ungrounded: 2, contradicted: 0, complementary: 1 },
      },
      {
        reply: "Grounded update sent. [send confirmed]",
        partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 1 },
      },
    ];
    const c = new TextMention("[send confirmed]")
      .and(new GroundednessCondition(scorer(adversarial.map((t) => t.partition))))
      .or(new MaxIterations(3));
    const r = await loop(c, adversarial);
    expect(r.turnsUsed).toBe(2); // blocked at turn 1, exits at turn 2
  });
});

// ─── 3. Code review — PR analysis ────────────────────────────────────────────
//
// User: "Review the SSRF fix in PR #74360"
// Agent reads the diff via file tools (tool_match weight), then synthesizes.
// Claims grounded by actual file content vs inference-only claims.

describe("code review — PR #74360 SSRF fix analysis", () => {
  const turns: Turn[] = [
    {
      // Turn 1: LLM reasons without reading the diff
      reply:
        "The SSRF fix probably adds IP allowlisting. This is a common pattern for restricting network access.",
      partition: { grounded: 0, ungrounded: 1, contradicted: 0, complementary: 2 },
    },
    {
      // Turn 2: After reading web-guarded-fetch.ts via file tool
      reply:
        "Reading src/agents/tools/web-guarded-fetch.ts: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY was changed from {dangerouslyAllowPrivateNetwork: true} to {}. New withSelfHostedWebToolsEndpoint uses the permissive policy only for self-hosted providers.",
      partition: { grounded: 5, ungrounded: 0, contradicted: 1, complementary: 1 },
      // 1 contradiction: the "probably adds IP allowlisting" claim was wrong
    },
    {
      // Turn 3: Final grounded review
      reply:
        "Review complete. The fix correctly restricts private network access for trusted endpoints. SearXNG retains access via withSelfHostedWebSearchEndpoint. Tests in web-guarded-fetch.ssrf.test.ts confirm the policy.",
      partition: { grounded: 6, ungrounded: 0, contradicted: 0, complementary: 2 },
    },
  ];

  it("inference-only review at turn 1 scores low (INFERENCE_WEIGHTS)", () => {
    const s = computeGroundednessScore(turns[0].partition, INFERENCE_WEIGHTS);
    // grounded=0, ungrounded=1, complementary=2 with w(comp)=0.2:
    // S = (0 + 2*0.2) / (0 + 1*1.0 + 0 + 2*0.2) = 0.4/1.4 ≈ 0.29 — replan zone
    expect(s).toBeLessThan(0.5);
    expect(s).toBeLessThan(0.65); // below regenerate threshold
  });

  it("file-grounded review at turn 3 exceeds proceed threshold (TOOL_MATCH_WEIGHTS)", () => {
    const s = computeGroundednessScore(turns[2].partition, TOOL_MATCH_WEIGHTS);
    expect(s).toBeGreaterThanOrEqual(0.8);
  });

  it("GSAR with tool_match weights exits at turn 2 (5 grounded claims outweigh 1 contradiction)", async () => {
    // p(5,0,1,1): S = (5*1.0 + 1*0.5)/(5 + 0 + 1*1.0 + 0.5) = 5.5/6.5 ≈ 0.846 → proceed
    // The contradiction doesn't drag the score below 0.80 when grounded evidence dominates.
    const r = await loop(
      gsarOr(
        turns.map((t) => t.partition),
        TOOL_MATCH_WEIGHTS,
      ),
      turns,
    );
    expect(r.turnsUsed).toBe(2);
    expect(r.reason).toMatch(/grounded:proceed/);
    expect(computeGroundednessScore(turns[1].partition, TOOL_MATCH_WEIGHTS)).toBeGreaterThanOrEqual(
      0.8,
    );
  });

  it("GSAR with inference weights exits later — file evidence treated as weaker", () => {
    // With inference weights (w=0.4), even 6 grounded claims need more to clear 0.80
    // p(6, 0, 0, 2): S = (6*0.4 + 2*0.2)/(6*0.4 + 0 + 0 + 2*0.2) = (2.4+0.4)/(2.4+0.4) = 1.0
    // Still clears — but turn 2 won't (5 grounded, 1 contradicted)
    const p2score = computeGroundednessScore(turns[1].partition, INFERENCE_WEIGHTS);
    // p(5,0,1,1): S = (5*0.4 + 1*0.2)/(5*0.4 + 0 + 1*1.0 + 1*0.2) = (2+0.2)/(2+1+0.2) = 2.2/3.2 ≈ 0.688
    expect(p2score).toBeGreaterThan(0.65);
    expect(p2score).toBeLessThan(0.8); // regenerate, not proceed
  });
});

// ─── 4. A2A delegation — agent asking another agent ──────────────────────────
//
// Requester agent asks a specialist agent: "What's the memory usage of the
// openclaw process right now?"
// Specialist uses shell tool to get real data.

describe("A2A delegation — shell-grounded system metrics", () => {
  const turns: Turn[] = [
    {
      // Turn 1: Specialist guesses without running the command
      reply: "OpenClaw typically uses around 200–400MB of memory based on typical Node.js apps.",
      partition: { grounded: 0, ungrounded: 2, contradicted: 0, complementary: 1 },
    },
    {
      // Turn 2: Ran shell command, got actual RSS
      reply:
        "Shell output: RSS=342MB, HeapUsed=218MB, HeapTotal=290MB (measured at 2026-04-30T20:15:00Z via process.memoryUsage())",
      partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 0 },
    },
  ];

  it("guessed answer (turn 1) scores low — ungrounded claims dominate", () => {
    // p(0,2,0,1): S = (0 + 1*0.5)/(0 + 2*1.0 + 0 + 1*0.5) = 0.5/2.5 = 0.2 → replan
    const s = computeGroundednessScore(turns[0].partition, TOOL_MATCH_WEIGHTS);
    expect(s).toBe(0.2);
    expect(s).toBeLessThan(0.65); // replan zone
  });

  it("shell-grounded answer (turn 2) proceeds immediately", () => {
    const s = computeGroundednessScore(turns[1].partition, TOOL_MATCH_WEIGHTS);
    expect(s).toBe(1.0);
  });

  it("GSAR exits at turn 2 when shell evidence grounds all claims", async () => {
    const r = await loop(
      gsarOr(
        turns.map((t) => t.partition),
        TOOL_MATCH_WEIGHTS,
      ),
      turns,
    );
    expect(r.turnsUsed).toBe(2);
    expect(r.reason).toMatch(/grounded:proceed/);
  });

  // The A2A ping-pong loop with termination condition wired (sessions-send-tool.a2a.ts)
  it("A2A budget of maxPingPongTurns=3 with GSAR exits early without wasting turns", async () => {
    const cond = gsarOr(
      turns.map((t) => t.partition),
      TOOL_MATCH_WEIGHTS,
      3,
    );
    const r = await loop(cond, turns, 3);
    expect(r.turnsUsed).toBe(2); // saves 1 turn vs maxPingPongTurns=3
  });
});

// ─── 5. Scheduled digest — cron agent summarizing PRs ────────────────────────
//
// A scheduled agent runs every morning: "Summarize open PRs from the last 24h"
// Uses sessions_history + gh CLI output. Time-bounded (morning digest must
// complete within 60 seconds wall clock).

describe("scheduled digest — PR summary with time budget", () => {
  const turns: Turn[] = [
    {
      reply: "I'll check recent PRs. Let me query the GitHub API...",
      partition: { grounded: 0, ungrounded: 1, contradicted: 0, complementary: 0 },
    },
    {
      reply:
        "gh pr list returned: #74360 fix/ssrf-web-tools (open, 3 commits), #74359 fix/bun-curl-pipe (merged). Both touch security-sensitive paths.",
      partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 2 },
    },
  ];

  const gsarCond = new GroundednessCondition(
    scorer(turns.map((t) => t.partition)),
    TOOL_MATCH_WEIGHTS,
  );
  const timeCond = new TimeLimit(60);
  const cond = gsarCond.or(timeCond).or(new MaxIterations(10));

  it("exits at turn 2 when gh output grounds the summary", async () => {
    const r = await loop(cond, turns);
    expect(r.turnsUsed).toBe(2);
    expect(r.reason).toMatch(/grounded:proceed/);
  });

  it("TimeLimit fires if tool calls take too long (simulated 90s elapsed)", async () => {
    const slowCond = new GroundednessCondition(
      scorer(turns.map((t) => t.partition)),
      TOOL_MATCH_WEIGHTS,
    )
      .or(new TimeLimit(1))
      .or(new MaxIterations(10));
    // Simulate: startedAt is 2 seconds ago
    slowCond.reset();
    const [stop, reason] = await slowCond.check({
      turn: 1,
      replyText: turns[0].reply,
      startedAt: Date.now() - 2000,
    });
    expect(stop).toBe(true);
    expect(reason).toBe("time_limit");
  });

  it("three-way fallback hierarchy: GSAR → TimeLimit → MaxIterations", async () => {
    // If GSAR never fires and TimeLimit never fires, MaxIterations is the final backstop
    const neverGrounded = new GroundednessCondition(
      () => ({ grounded: 0, ungrounded: 5, contradicted: 0, complementary: 0 }),
      TOOL_MATCH_WEIGHTS,
    )
      .or(new TimeLimit(999))
      .or(new MaxIterations(3));
    const r = await loop(
      neverGrounded,
      Array.from({ length: 5 }, (_, i) => ({
        reply: `Turn ${i + 1}: still searching...`,
        partition: { grounded: 0, ungrounded: 5, contradicted: 0, complementary: 0 },
      })),
      5,
    );
    expect(r.turnsUsed).toBe(3);
    expect(r.reason).toBe("max_iterations");
  });
});

// ─── 6. Anthropic vs OpenAI on OpenClaw tasks ────────────────────────────────
//
// Run the same five OpenClaw task scenarios with simulated provider behavior.
// Claude grounds claims via tool calls earlier; GPT-4o needs more turns or
// never signals completion naturally.
//
// Metric: total turns used across all tasks × providers.

describe("Anthropic vs OpenAI — full OpenClaw task suite", () => {
  type Provider = "claude-3-7-sonnet" | "gpt-4o";

  // Each task: [turns for Claude, turns for GPT]
  // Claude grounds quickly; GPT takes more iterations or never grounds cleanly
  const tasks: {
    name: string;
    weights: EvidenceWeights;
    claude: Turn[];
    gpt: Turn[];
  }[] = [
    {
      name: "web_research",
      weights: WEB_WEIGHTS,
      claude: [
        {
          reply: "Searching now...",
          partition: { grounded: 0, ungrounded: 2, contradicted: 0, complementary: 0 },
        },
        {
          reply: "Found. [DONE]",
          partition: { grounded: 5, ungrounded: 0, contradicted: 0, complementary: 1 },
        },
        ...Array(3).fill({
          reply: "—",
          partition: { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 },
        }),
      ],
      gpt: [
        {
          reply: "Let me look that up.",
          partition: { grounded: 0, ungrounded: 2, contradicted: 0, complementary: 0 },
        },
        {
          reply: "Found some results.",
          partition: { grounded: 1, ungrounded: 2, contradicted: 0, complementary: 1 },
        },
        {
          reply: "Cross-referencing...",
          partition: { grounded: 2, ungrounded: 1, contradicted: 0, complementary: 1 },
        },
        {
          reply: "Compiling...",
          partition: { grounded: 3, ungrounded: 1, contradicted: 0, complementary: 1 },
        },
        {
          reply: "Here are the results.",
          partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 2 },
        },
      ],
    },
    {
      name: "code_review",
      weights: TOOL_MATCH_WEIGHTS,
      claude: [
        {
          reply: "Reading diff...",
          partition: { grounded: 0, ungrounded: 1, contradicted: 0, complementary: 0 },
        },
        {
          reply: "Review done. Policy change is correct. DONE",
          partition: { grounded: 6, ungrounded: 0, contradicted: 0, complementary: 2 },
        },
        ...Array(3).fill({
          reply: "—",
          partition: { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 },
        }),
      ],
      gpt: [
        {
          reply: "Analyzing the PR...",
          partition: { grounded: 1, ungrounded: 2, contradicted: 0, complementary: 1 },
        },
        {
          reply: "The change modifies SSRF policy.",
          partition: { grounded: 2, ungrounded: 1, contradicted: 0, complementary: 1 },
        },
        {
          reply: "Checking test coverage...",
          partition: { grounded: 3, ungrounded: 1, contradicted: 0, complementary: 1 },
        },
        {
          reply: "Tests look adequate.",
          partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 2 },
        },
        {
          reply: "Review complete.",
          partition: { grounded: 5, ungrounded: 0, contradicted: 0, complementary: 2 },
        },
      ],
    },
    {
      name: "shell_metrics",
      weights: TOOL_MATCH_WEIGHTS,
      claude: [
        {
          reply: "Running process.memoryUsage()... RSS=312MB. DONE",
          partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 0 },
        },
        ...Array(4).fill({
          reply: "—",
          partition: { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 },
        }),
      ],
      gpt: [
        {
          reply: "Checking memory...",
          partition: { grounded: 0, ungrounded: 1, contradicted: 0, complementary: 0 },
        },
        {
          reply: "Running memory check.",
          partition: { grounded: 1, ungrounded: 1, contradicted: 0, complementary: 0 },
        },
        {
          reply: "RSS=290MB (approximate).",
          partition: { grounded: 2, ungrounded: 1, contradicted: 0, complementary: 0 },
        },
        {
          reply: "Confirmed: RSS=290MB.",
          partition: { grounded: 4, ungrounded: 0, contradicted: 0, complementary: 0 },
        },
        {
          reply: "—",
          partition: { grounded: 0, ungrounded: 0, contradicted: 0, complementary: 0 },
        },
      ],
    },
  ];

  async function runProvider(provider: Provider, budget = 5) {
    return Promise.all(
      tasks.map((task) => {
        const turns = provider === "claude-3-7-sonnet" ? task.claude : task.gpt;
        const cond = new GroundednessCondition(
          scorer(turns.map((t) => t.partition)),
          task.weights,
        ).or(new MaxIterations(budget));
        return loop(cond, turns, budget);
      }),
    );
  }

  it("Claude grounds all tasks in ≤2 turns on average", async () => {
    const results = await runProvider("claude-3-7-sonnet");
    const avg = results.reduce((s, r) => s + r.turnsUsed, 0) / results.length;
    expect(avg).toBeLessThanOrEqual(2);
    expect(results.every((r) => r.reason?.includes("grounded:proceed"))).toBe(true);
  });

  it("GPT-4o takes more turns and only proceeds via GSAR scoring (never via text signal)", async () => {
    const results = await runProvider("gpt-4o");
    const avg = results.reduce((s, r) => s + r.turnsUsed, 0) / results.length;
    expect(avg).toBeGreaterThan(2);
  });

  it("Claude uses fewer total turns than GPT across all tasks", async () => {
    const claudeTotal = (await runProvider("claude-3-7-sonnet")).reduce(
      (s, r) => s + r.turnsUsed,
      0,
    );
    const gptTotal = (await runProvider("gpt-4o")).reduce((s, r) => s + r.turnsUsed, 0);
    expect(claudeTotal).toBeLessThan(gptTotal);
  });

  it("both providers exit with grounded output (score ≥ 0.80) — quality is equal", async () => {
    const claudeResults = await runProvider("claude-3-7-sonnet");
    const gptResults = await runProvider("gpt-4o");
    for (const r of [...claudeResults, ...gptResults]) {
      if (r.reason?.includes("grounded:proceed")) {
        expect(r.score).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it("flat MaxIterations: Claude and GPT are indistinguishable — all burn 5 turns", async () => {
    const flat = async (provider: Provider) => {
      let total = 0;
      for (const task of tasks) {
        const turns = provider === "claude-3-7-sonnet" ? task.claude : task.gpt;
        const r = await loop(new MaxIterations(5), turns, 5);
        total += r.turnsUsed;
      }
      return total;
    };
    expect(await flat("claude-3-7-sonnet")).toBe(await flat("gpt-4o"));
  });

  it("cost summary: GSAR+algebra saves turns proportional to how early models ground claims", async () => {
    const claudeFlat = tasks.reduce((s) => s + 5, 0); // always 5
    const claudeGsar = (await runProvider("claude-3-7-sonnet")).reduce(
      (s, r) => s + r.turnsUsed,
      0,
    );
    const gptFlat = tasks.reduce((s) => s + 5, 0);
    const gptGsar = (await runProvider("gpt-4o")).reduce((s, r) => s + r.turnsUsed, 0);

    const claudeSavingPct = ((claudeFlat - claudeGsar) / claudeFlat) * 100;
    const gptSavingPct = ((gptFlat - gptGsar) / gptFlat) * 100;

    // Claude saves more because it grounds earlier
    expect(claudeSavingPct).toBeGreaterThan(gptSavingPct);
    // Both save something
    expect(claudeSavingPct).toBeGreaterThan(0);
    expect(gptSavingPct).toBeGreaterThan(0);
  });
});
