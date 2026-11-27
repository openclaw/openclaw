import type {
  DecisionAnswerV2,
  DecisionBatchV2,
  DecisionEvaluateOptionsV2,
  DecisionOutcomeV2,
  DecisionRuntimeV2,
} from "openclaw/plugin-sdk/decisions";
import { expect, it, vi } from "vitest";
import { memoryFixture } from "./memory-provider.test-support.js";
import {
  decide,
  GATE_SKIP_HINT,
  parseRecallGate,
  renderInjection,
  type GateEntry,
} from "./recall-gate.js";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const gate = (extra = {}) => ({ recallGate: { ...extra } });

type Calls = Array<{ batch: DecisionBatchV2; options: DecisionEvaluateOptionsV2 }>;
/** Choice: option probabilities keyed by the option label after "note: "; the rest goes to
 * "None of these" so every distribution is a valid, normalized categorical result.
 * Boolean: P(true) keyed by a word in the page label; "yes" answers without one. */
type Script = {
  choice?: Record<string, number>;
  relevant?: Record<string, number | "yes">;
  unavailable?: "not-configured" | "deadline";
};

function runtime(script: Script) {
  const calls: Calls = [];
  const answer = (question: DecisionBatchV2["questions"][string]): DecisionAnswerV2 => {
    if (question.type === "choice") {
      const probabilities: Record<string, number> = {};
      let used = 0;
      for (const name of Object.keys(question.criteria)) {
        const key = Object.keys(script.choice ?? {}).find((k) => name === `note: ${k}`);
        probabilities[name] = key ? script.choice![key]! : 0;
        used += probabilities[name];
      }
      expect(used).toBeLessThanOrEqual(1 + 1e-9);
      probabilities["None of these"] = 1 - used;
      const choice = Object.entries(probabilities).toSorted((a, b) => b[1] - a[1])[0]![0];
      return { type: "choice", choice, probabilities };
    }
    const label = typeof question.instructions === "string" ? question.instructions : "";
    const key = Object.keys(script.relevant ?? {}).find((k) => label.split("\n")[0]!.includes(k));
    const p = key ? script.relevant![key]! : 0.01;
    return p === "yes"
      ? { type: "boolean", answer: true }
      : { type: "boolean", probabilityTrue: p };
  };
  const evaluateV2 = vi.fn(
    async (
      batch: DecisionBatchV2,
      options: DecisionEvaluateOptionsV2,
    ): Promise<DecisionOutcomeV2> => {
      calls.push({ batch, options });
      if (script.unavailable) {
        return { status: "unavailable", reason: script.unavailable };
      }
      const answers = Object.fromEntries(
        Object.entries(batch.questions).map(([id, q]) => [id, answer(q)]),
      );
      return {
        status: "ok",
        result: { model: "test/decider", answers },
        provenance: {
          providerId: "test",
          rubricVersion: options.rubricVersion,
          runtimeGeneration: "g",
        },
      };
    },
  );
  const decisions = { evaluate: vi.fn(), evaluateV2 } as unknown as DecisionRuntimeV2;
  return { decisions, calls, evaluateV2 };
}

const entries = (n: number, line = (i: number) => `note: entry ${i}`): GateEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, line: line(i), label: `e${i}` }));

const policy = (extra = {}) => ({ ...parseRecallGate(gate().recallGate)!, ...extra });
/** Model-pick mode with the pointer tier on: the index-shortlist cases below. */
const MODEL = { candidates: "model", highThreshold: 0.85, mediumThreshold: 0.5, maxCandidates: 5 };

async function decideWith(script: Script, list: GateEntry[], extra = {}) {
  const rt = runtime(script);
  const result = await decide({
    policy: policy({ ...MODEL, ...extra }),
    entries: list,
    message: "anything",
    decisions: rt.decisions,
    agentId: "main",
    signal: new AbortController().signal,
  });
  return { ...rt, result };
}

async function setup(config = gate(), script: Script = {}) {
  const f = await memoryFixture(tempDirs, {}, config);
  const info = vi.fn();
  (f.api as { logger?: unknown }).logger = { info };
  const rt = runtime(script);
  (f.api.runtime as { decisions?: unknown }).decisions = rt.decisions;
  const pages: Array<[string, string]> = [
    ["Nova vaccination schedule", "Nova's rabies booster is due in March."],
    ["Pizza oven project", "Firebrick order placed."],
    ["Garage door opener", "Model and remote codes."],
  ];
  for (const [title, body] of pages) {
    await f.service.save_page(
      { requestId: crypto.randomUUID(), expectedVaultId: f.vaultId, type: "note", title, body },
      f.tool,
    );
  }
  const ctx: Record<string, unknown> = {
    agentId: "main",
    trigger: "user",
    sessionKey: f.context.authority.sessionKey,
    sessionId: f.sessionId,
    sandboxed: false,
    memoryAudience: f.context.authority.audience,
    assertMemoryAudienceCurrent: f.context.assertCurrent,
  };
  const [indexHook, gateHook] = f.hookList.before_prompt_build!;
  const run = (prompt: string) => gateHook({ prompt, messages: [] }, ctx);
  const logged = () =>
    info.mock.calls.map((call) => JSON.parse(String(call[0]).replace(/^[^{]*/u, "")));
  return { f, ctx, indexHook, run, logged, ...rt };
}

it("parses defaults and turns off cleanly", () => {
  // The measured keyword-shortlist setup; pointer tier and skip hint stay off.
  expect(parseRecallGate(gate().recallGate)).toEqual({
    mode: "shadow",
    candidates: "keyword",
    highThreshold: 0.75,
    timeoutMs: 1500,
    maxIndexChars: 24_000,
    maxCandidates: 10,
    excerpts: 4,
    excerptChars: 1_000,
    pageChars: 2_800,
  });
  expect(parseRecallGate({ mode: "off" })).toBe(undefined);
  expect(parseRecallGate({ highThreshold: 0.3, mediumThreshold: 0.6 })!.highThreshold).toBe(0.6);
  expect(parseRecallGate({ skipHintBelow: 0.858 })).toMatchObject({ skipHintBelow: 0.858 });
});

it("without the pointer tier, mid scores and bare yeses inject nothing", async () => {
  const { result } = await decideWith(
    { relevant: { "entry 1": "yes", "entry 2": 0.6 } },
    entries(3),
    {
      mediumThreshold: undefined,
      highThreshold: 0.75,
    },
  );
  expect(result.status === "ok" && result.decisions.map((d) => d.tier)).toEqual([
    "low",
    "low",
    "low",
  ]);
});

it("scores pages independently: two relevant pages that split choice mass both pass", async () => {
  // Reviewer case 1: {A:.43, B:.43, None:.14} must not suppress both pages.
  const list = entries(12, (i) =>
    i === 3 ? "note: meds A" : i === 8 ? "note: plan B" : `note: e${i}`,
  );
  const { result, calls } = await decideWith(
    { choice: { "meds A": 0.43, "plan B": 0.43 }, relevant: { "meds A": 0.92, "plan B": 0.7 } },
    list,
  );
  expect(calls.map((c) => Object.values(c.batch.questions).map((q) => q.type))).toEqual([
    ["choice"],
    ["boolean", "boolean"],
  ]);
  expect(result).toEqual({
    status: "ok",
    offered: 12,
    shortlisted: 2,
    decisions: [
      { id: "r3", score: 0.92, tier: "high" },
      { id: "r8", score: 0.7, tier: "medium" },
    ],
  });
});

it("injects only the page the message needs", async () => {
  // Reviewer case 2: {A:.90, None:.10}; B never reaches scoring.
  const list = entries(8, (i) =>
    i === 2 ? "note: meds A" : i === 5 ? "note: plan B" : `note: e${i}`,
  );
  const { result } = await decideWith(
    { choice: { "meds A": 0.9 }, relevant: { "meds A": 0.95 } },
    list,
  );
  expect(result).toMatchObject({ shortlisted: 1, decisions: [{ id: "r2", tier: "high" }] });
});

it("injects nothing when no page fits, even after a weak shortlist", async () => {
  // Reviewer case 3: {A:.05, B:.05, None:.90}; independent scores stay low.
  const list = entries(8, (i) =>
    i === 1 ? "note: meds A" : i === 4 ? "note: plan B" : `note: e${i}`,
  );
  const { result } = await decideWith(
    { choice: { "meds A": 0.05, "plan B": 0.05 }, relevant: { "meds A": 0.04, "plan B": 0.06 } },
    list,
  );
  expect(result.status === "ok" && result.decisions.map((d) => d.tier)).toEqual(["low", "low"]);
});

it("ranks across chunks and scores each candidate on the same scale", async () => {
  // Reviewer case 4: per-chunk None options do not exclude a strong page elsewhere.
  const list = entries(300, (i) => (i === 7 ? "note: entry 3" : `note: entry ${i}`));
  const { result, calls } = await decideWith(
    {
      choice: { "entry 3 (2)": 0.3, "entry 270": 0.2, "entry 12": 0.1 },
      relevant: { "entry 270": 0.9, "entry 3": 0.6 },
    },
    list,
    { maxCandidates: 3 },
  );
  const pick = calls[0]!.batch.questions;
  expect(
    Object.values(pick).map((q) => q.type === "choice" && Object.keys(q.criteria).length),
  ).toEqual([255, 47]);
  // Repeated labels get a suffix so both stay options.
  expect(JSON.stringify(pick)).toContain("note: entry 3 (2)");
  expect(result.status === "ok" && result.decisions).toEqual([
    { id: "r7", score: 0.6, tier: "medium" },
    { id: "r270", score: 0.9, tier: "high" },
    { id: "r12", score: 0.01, tier: "low" },
  ]);
  expect(
    calls.every(
      (c) => c.options.agentId === "main" && c.options.purpose === "knowledge.recall-gate",
    ),
  ).toBe(true);
});

it("skips the shortlist when the index fits in maxCandidates", async () => {
  const { calls, result } = await decideWith({ relevant: { "entry 1": "yes" } }, entries(3));
  expect(calls).toHaveLength(1);
  // A yes without a probability earns a pointer, never a body.
  expect(result.status === "ok" && result.decisions.map((d) => [d.score, d.tier])).toEqual([
    [0.01, "low"],
    [null, "medium"],
    [0.01, "low"],
  ]);
});

it("only offers entries inside the index budget and reports that count", async () => {
  const { result, calls } = await decideWith({}, entries(400), { maxIndexChars: 500 });
  const offered = result.offered;
  expect(offered).toBeGreaterThan(10);
  expect(offered).toBeLessThan(400);
  const pick = calls[0]!.batch.questions.pick0!;
  expect(pick.type === "choice" && Object.keys(pick.criteria).length).toBe(offered + 1);
});

it("rechecks authority before every Decision request", async () => {
  const rt = runtime({ choice: { "entry 1": 0.9 } });
  let live = true;
  const assertCurrent = () => {
    if (!live) {
      throw new Error("audience changed");
    }
  };
  rt.evaluateV2.mockImplementationOnce(async () => {
    live = false;
    return {
      status: "ok",
      result: { model: "m", answers: { pick0: { type: "choice", choice: "note: entry 1" } } },
      provenance: { providerId: "t", rubricVersion: "v", runtimeGeneration: "g" },
    };
  });
  await expect(
    decide({
      policy: policy(MODEL),
      entries: entries(9),
      message: "x",
      decisions: rt.decisions,
      agentId: "main",
      signal: new AbortController().signal,
      assertCurrent,
    }),
  ).rejects.toThrow("audience changed");
  expect(rt.evaluateV2).toHaveBeenCalledTimes(1);
  // The runtime carries the same predicate to physical dispatch and every retry.
  expect(rt.evaluateV2.mock.calls[0]![1].assertCurrent).toBe(assertCurrent);
});

it("counts the header inside the injection budget", () => {
  // Enough pointers to fill the budget; the header must not push the total past it.
  const items = Array.from({ length: 200 }, (_, i) => ({
    entry: { id: `r${i}`, line: "", label: `page ${i}` },
    tier: "medium" as const,
  }));
  const text = renderInjection(items, 2_800);
  expect(text.startsWith("## Knowledge recall")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(6_000);
  expect(text.length).toBeGreaterThan(5_800);
});

it("reserves the heading and header before clipping a full-budget page", () => {
  const entry = { id: "r1", line: "", label: "Long page" };
  const text = renderInjection([{ entry, tier: "high", body: "x".repeat(6_000) }], 6_000);
  expect(text).toContain("### Long page (id r1)\nxxx");
  expect(text.endsWith("…")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(6_000);
});

it("shadow mode logs the decisions and injects nothing", async () => {
  const { run, logged } = await setup(gate(), { relevant: { Nova: 0.95 } });
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  const [record] = logged();
  // Keyword search ran over all three pages and shortlisted the one sharing words.
  expect(record).toMatchObject({ mode: "shadow", outcome: "shadow", offered: 3, shortlisted: 1 });
  expect(record.decisions.filter((d: { tier: string }) => d.tier === "high")).toHaveLength(1);
  // Logs carry IDs and scores, never message or record text.
  expect(JSON.stringify(record)).not.toMatch(/Nova|shots/u);
});

it("keyword mode never scores when no page shares a word with the message", async () => {
  const { run, calls, logged } = await setup(gate({ mode: "live", skipHintBelow: 0.9 }));
  expect(await run("Quantum chromodynamics?")).toBe(undefined);
  expect(calls).toHaveLength(0);
  expect(logged()[0]).toMatchObject({ outcome: "none", offered: 3, shortlisted: 0 });
});

it("the skip hint is off by default and opt-in below its cutoff", async () => {
  const off = await setup(gate({ mode: "live" }), { relevant: { Nova: 0.2 } });
  expect(await off.run("Is Nova due for her shots?")).toBe(undefined);
  expect(off.logged()[0]).toMatchObject({ outcome: "none" });
  const on = await setup(gate({ mode: "live", skipHintBelow: 0.858 }), { relevant: { Nova: 0.2 } });
  expect(await on.run("Is Nova due for her shots?")).toEqual({ prependContext: GATE_SKIP_HINT });
  expect(on.logged()[0]).toMatchObject({ outcome: "skip-hint" });
  // A score at or above the cutoff gives no hint.
  const near = await setup(gate({ mode: "live", skipHintBelow: 0.858, highThreshold: 0.9 }), {
    relevant: { Nova: 0.86 },
  });
  expect(await near.run("Is Nova due for her shots?")).toBe(undefined);
  // Shadow mode logs the hint it would add and injects nothing.
  const shadow = await setup(gate({ skipHintBelow: 0.858 }), { relevant: { Nova: 0.2 } });
  expect(await shadow.run("Is Nova due for her shots?")).toBe(undefined);
  expect(shadow.logged()[0]).toMatchObject({ outcome: "shadow" });
});

it("model mode injects high bodies, medium pointers and nothing for low", async () => {
  const { run, logged, calls } = await setup(gate({ mode: "live", ...MODEL }), {
    relevant: { Nova: 0.9, Pizza: 0.6, Garage: 0.1 },
  });
  const result = await run("Is Nova due for her shots?");
  // Only the user turn changes: no system prompt or system context.
  expect(Object.keys(result)).toEqual(["prependContext"]);
  const text: string = result.prependContext;
  expect(text).toContain("### Nova vaccination schedule");
  expect(text).toContain("rabies booster is due in March");
  expect(text).toMatch(/Knowledge has a page on Pizza oven project; use knowledge_lookup/u);
  expect(text).not.toContain("Firebrick");
  expect(text).not.toContain("Garage");
  // The index goes to the Decision model only.
  expect(JSON.stringify(calls[0]!.batch)).toContain("note: Garage door opener");
  expect(text).not.toContain("## Knowledge Index");
  expect(logged()[0]).toMatchObject({ mode: "live", outcome: "injected" });
});

it("injects nothing when the agent has no Decision model or the provider is down", async () => {
  const { run, logged } = await setup(gate({ mode: "live", ...MODEL }), {
    unavailable: "not-configured",
  });
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  expect(logged()[0]).toMatchObject({
    outcome: "unavailable",
    stage: "score",
    reason: "not-configured",
  });
});

it("injects nothing and never throws on runtime errors or timeouts", async () => {
  // The budget leaves room for vault reads on a loaded runner; the gate's own
  // deadline, not the host hook timeout, is what logs "timed out".
  const { run, logged, evaluateV2 } = await setup(gate({ mode: "live", timeoutMs: 3_000 }));
  evaluateV2.mockRejectedValueOnce(new Error("boom"));
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  evaluateV2.mockImplementationOnce(
    (_b, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  expect(logged().map((r) => [r.outcome, r.error])).toEqual([
    ["error", "boom"],
    ["error", "timed out after 3000ms"],
  ]);
});

it("keeps the standing index in the system prompt and out of the gate", async () => {
  const { run, indexHook, ctx } = await setup(gate({ mode: "live", ...MODEL }), {
    relevant: { Nova: 0.99 },
  });
  const index = await indexHook({ prompt: "x", messages: [] }, ctx);
  expect(index.appendSystemContext).toContain("## Knowledge Index");
  const text: string = (await run("Is Nova due for her shots?")).prependContext;
  expect(text).not.toContain("Pizza oven project");
});

it("skips non-user turns, agentless turns and sessions that cannot read the private partition", async () => {
  const { f, ctx, run, evaluateV2 } = await setup(gate({ mode: "live" }), {
    relevant: { Nova: 0.99 },
  });
  ctx.trigger = "heartbeat";
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  ctx.trigger = "user";
  delete ctx.agentId;
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  ctx.agentId = "main";
  ctx.memoryAudience = f.conversation;
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  expect(evaluateV2).not.toHaveBeenCalled();
});
