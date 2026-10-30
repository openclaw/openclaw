import { afterEach, expect, it, vi } from "vitest";
import { memoryFixture } from "./memory-provider.test-support.js";
import { decide, parseRecallGate } from "./recall-gate.js";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();
afterEach(() => vi.unstubAllGlobals());

const gate = (extra = {}) => ({
  recallGate: { baseUrl: "http://decider.test/v1", model: "decider", ...extra },
});

// Chat completion with an optional yes/no top-logprob pair for the first token.
const reply = (content: string, logprobs?: { yes: number; no: number }) => ({
  choices: [
    {
      message: { content },
      logprobs: logprobs
        ? {
            content: [
              {
                token: content,
                top_logprobs: [
                  { token: "yes", logprob: Math.log(logprobs.yes) },
                  { token: " No", logprob: Math.log(logprobs.no) },
                ],
              },
            ],
          }
        : null,
    },
  ],
});

type Scores = Record<string, { yes: number; no: number } | "binary-yes">;

/** A decision endpoint: selection picks every entry whose label names a word in
 * `picks`; each score request answers from `scores`, keyed by a label word. */
function decider(picks: string[], scores: Scores) {
  const requests: Array<{ messages: Array<{ content: string }> }> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    requests.push(body);
    const prompt: string = body.messages[1].content;
    if (body.max_tokens !== 1) {
      const lines = prompt.split("\n").filter((l) => /^\d+\. /u.test(l));
      const chosen = lines
        .filter((l) => picks.some((p) => l.includes(p)))
        .map((l) => l.split(".")[0]);
      return Response.json(reply(chosen.length ? chosen.join(", ") : "none"));
    }
    const key = Object.keys(scores).find((k) => prompt.split("\n")[0]!.includes(k))!;
    const score = scores[key]!;
    return Response.json(score === "binary-yes" ? reply("Yes") : reply("x", score));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

async function setup(policy = gate()) {
  const f = await memoryFixture(tempDirs, {}, policy);
  const info = vi.fn();
  (f.api as { logger?: unknown }).logger = { info };
  const pages: Array<[string, string]> = [
    ["Nova vaccination schedule", "Nova's rabies booster is due in March."],
    ["Pizza oven project", "Firebrick order placed."],
    ["Garage door opener", "Model and remote codes."],
  ];
  for (const [title, body] of pages) {
    await f.service.save_page(
      {
        requestId: crypto.randomUUID(),
        expectedVaultId: f.vaultId,
        type: "note",
        title,
        body,
      },
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
  return { f, ctx, indexHook, run, logged };
}

it("scores yes/no from logprobs and falls back to a binary answer without them", async () => {
  const policy = parseRecallGate(gate().recallGate)!;
  // One entry per score reply; the selection call picks every entry.
  const answers = [
    reply("yes", { yes: 0.9, no: 0.1 }),
    // Case and leading-space variants of the answer tokens count.
    reply("no", { yes: 0.2, no: 0.6 }),
    reply("Yes."),
    reply("No"),
    { choices: [] },
  ];
  const entries = answers.map((_, i) => ({
    id: `r${i}`,
    line: `note: entry ${i}`,
    label: `e${i}`,
  }));
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (body.max_tokens !== 1) {
      return Response.json(reply("1, 2, 3, 4, 5"));
    }
    const n = Number(/entry (\d)/u.exec(body.messages[1].content)![1]);
    return Response.json(answers[n]);
  };
  const decisions = await decide({
    policy: { ...policy, maxCandidates: 5 },
    entries,
    message: "anything",
    signal: new AbortController().signal,
    fetchImpl,
  });
  expect(
    decisions.map((d) => [d.score === null ? null : Number(d.score.toFixed(2)), d.tier]),
  ).toEqual([
    [0.9, "high"],
    [0.25, "low"],
    [null, "medium"],
    [0, "low"],
    [0, "low"],
  ]);
  expect(policy.mode).toBe("shadow");
  expect(parseRecallGate({ ...gate().recallGate, mode: "off" })).toBe(undefined);
  expect(parseRecallGate({ ...gate().recallGate, apiKey: { source: "env" } })!.apiKey).toBe(
    undefined,
  );
});

it("shadow mode logs the decisions and injects nothing", async () => {
  const { run, logged } = await setup();
  decider(["Nova"], { Nova: { yes: 0.95, no: 0.05 } });
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  const [record] = logged();
  expect(record).toMatchObject({ mode: "shadow", outcome: "shadow", offered: 3 });
  expect(record.decisions).toEqual([
    { id: expect.any(String), score: expect.closeTo(0.95), tier: "high" },
  ]);
  // Logs carry IDs and scores, never message or record text.
  expect(JSON.stringify(record)).not.toMatch(/Nova|shots/u);
});

it("live mode injects high bodies, medium pointers and nothing for low", async () => {
  const { run, logged } = await setup(gate({ mode: "live" }));
  const { requests } = decider(["Nova", "Pizza", "Garage"], {
    Nova: { yes: 0.9, no: 0.1 },
    Pizza: { yes: 0.6, no: 0.4 },
    Garage: { yes: 0.1, no: 0.9 },
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
  // The index goes to the decision model only.
  expect(requests[0]!.messages[1]!.content).toContain("note: Garage door opener");
  expect(text).not.toContain("## Knowledge Index");
  expect(logged()[0]).toMatchObject({ mode: "live", outcome: "injected" });
});

it("treats a yes without logprobs as a pointer, never a body", async () => {
  const { run } = await setup(gate({ mode: "live" }));
  decider(["Nova"], { Nova: "binary-yes" });
  const text: string = (await run("Is Nova due for her shots?")).prependContext;
  expect(text).toContain("Knowledge has a page on Nova vaccination schedule");
  expect(text).not.toContain("rabies");
});

it("injects nothing when the decision model finds no match", async () => {
  const { run, logged } = await setup(gate({ mode: "live" }));
  const { fetchMock } = decider([], {});
  expect(await run("Turn on the TV")).toBe(undefined);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(logged()[0]).toMatchObject({ outcome: "none", decisions: [] });
});

it("injects nothing and never throws on endpoint errors or timeouts", async () => {
  const { run, logged } = await setup(gate({ mode: "live", timeoutMs: 100 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("down", { status: 503 })),
  );
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  // A hung endpoint is cut off at the budget, not at the host hook timeout.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ),
  );
  const started = Date.now();
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(logged().map((r) => [r.outcome, r.error])).toEqual([
    ["error", "decision endpoint returned HTTP 503"],
    ["error", "timed out after 100ms"],
  ]);
});

it("keeps the standing index in the system prompt and out of the gate", async () => {
  const { run, indexHook, ctx } = await setup(gate({ mode: "live" }));
  decider(["Nova"], { Nova: { yes: 0.99, no: 0.01 } });
  const index = await indexHook({ prompt: "x", messages: [] }, ctx);
  expect(index.appendSystemContext).toContain("## Knowledge Index");
  const text: string = (await run("Is Nova due for her shots?")).prependContext;
  expect(text).not.toContain("Pizza oven project");
});

it("skips non-user turns and sessions that cannot read the private partition", async () => {
  const { f, ctx, run } = await setup(gate({ mode: "live" }));
  const { fetchMock } = decider(["Nova"], { Nova: { yes: 0.99, no: 0.01 } });
  ctx.trigger = "heartbeat";
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  ctx.trigger = "user";
  ctx.memoryAudience = f.conversation;
  expect(await run("Is Nova due for her shots?")).toBe(undefined);
  expect(fetchMock).not.toHaveBeenCalled();
});
