import { writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { toWire, fromWire, MODEL_IDS } from "./codec.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createDecisionProvider } from "./provider.js";
import { runCli } from "./transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { color: "red", count: 3 } },
  questions: {
    red: { type: "boolean", instructions: "Is it red?" },
    color: { type: "choice", criteria: { red: "Red", blue: "Blue" } },
    count: { type: "score", criteria: ["Zero", { count: 3 }] },
  },
};
function wire(model = "clef") {
  return {
    model,
    answers: {
      red: { type: "noul", noul: 0.97 },
      color: {
        type: "choice",
        choice: "red",
        probabilities: { red: 0.97, blue: 0.02 },
        confidence: 0.8,
      },
      count: {
        type: "score",
        score: 0.91,
        probabilities: { "0": 0.08, "1": 0.91 },
        legend: { "0": "Zero", "1": { count: 3 } },
      },
    },
    usage: { input_tokens: 42, output_tokens: 0 },
  };
}
function context(binaryPath?: string, model = "clef"): DecisionProviderContextV2 {
  return {
    model: { provider: "cloudflare-clef", id: model, name: model },
    config: { plugins: { entries: { "cloudflare-clef": { config: { binaryPath } } } } },
    auth: { apiKey: "cloudflare-cli", mode: "api-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 10000,
    isAdmissible: () => true,
  };
}
const provider = createDecisionProvider();

it("preserves typed evidence and estimates", () => {
  const model = "clef";
  expect(toWire(batch, model)?.questions.red?.type).toBe("noul");
  expect(toWire(batch, model)?.model).toBe(model);
  const result = fromWire({ success: true, result: wire(model) }, batch, model);
  expect(result?.answers).toEqual({
    red: { type: "boolean", probabilityTrue: 0.97 },
    color: {
      type: "choice",
      choice: "red",
      probabilities: { red: 0.97, blue: 0.02 },
      confidence: 0.8,
    },
    count: { type: "score", score: 0.91, probabilities: [0.08, 0.91] },
  });
  expect(result?.usage).toEqual({ inputTokens: 42, outputTokens: 0 });
});

it("maps native image evidence to an embedded image", () => {
  const imageBatch: DecisionBatchV2 = {
    ...batch,
    state: { type: "image", dataUri: "data:image/png;base64,AAAA", text: "Which color?" },
  };
  const value = toWire(imageBatch, "clef");
  expect(value?.images).toEqual(["data:image/png;base64,AAAA"]);
  expect(value?.state).toBe("Which color?");
});

it("rejects model, rubric, result and unsupported input mismatches", () => {
  expect(fromWire(wire("clef-omni"), batch, "clef")).toBeUndefined();
  expect(fromWire({ success: false, ...wire() }, batch, "clef")).toBeUndefined();
  for (const answers of [
    { ...wire().answers, extra: wire().answers.red },
    { ...wire().answers, red: { type: "noul", noul: -1 } },
    { ...wire().answers, color: { ...wire().answers.color, choice: "unknown" } },
    { ...wire().answers, count: { ...wire().answers.count, score: 2 } },
    {
      ...wire().answers,
      count: { ...wire().answers.count, legend: { "0": "Zero", "1": "Other" } },
    },
  ]) {
    expect(fromWire({ ...wire(), answers }, batch, "clef")).toBeUndefined();
  }
  expect(toWire(batch, "unknown")).toBeUndefined();
  expect(
    toWire({ ...batch, questions: { "invalid id": batch.questions.red! } }, "clef"),
  ).toBeUndefined();
  expect(
    toWire(
      {
        ...batch,
        questions: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [String(i), batch.questions.red!]),
        ),
      },
      "clef",
    ),
  ).toBeUndefined();
  expect(
    toWire({ ...batch, questions: { tags: { type: "tags", criteria: { a: "A" } } } }, "clef"),
  ).toBeUndefined();
  expect(toWire({ ...batch, state: { type: "list", items: [] } }, "clef")).toBeUndefined();
});

it("declares all three decision-only routes and no unsupported media capabilities", () => {
  const models = manifest.modelCatalog.providers["cloudflare-clef"].models;
  expect(models.map((m) => m.id)).toEqual([...MODEL_IDS]);
  expect(manifest.decisionModels.map((m) => m.id)).toEqual([...MODEL_IDS]);
  for (const model of models) {
    expect(model.inference.chat).toBe(false);
    expect(model.inference.decision.input).toEqual(["text", "image"]);
    expect(model.inference.decision.limits.maxQuestions).toBe(64);
  }
});

it.skipIf(process.platform === "win32")(
  "dispatches every selected model without a shell, keeps evidence private, and awaits cleanup",
  async () => {
    vi.stubEnv("OPENCLAW_CLEF_SYNTHETIC_SECRET", "synthetic-private-token");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic-wrong-account-token");
    const dir = tempDirs.make("clef-cli-test-");
    const capture = join(dir, "capture.json");
    const executable = join(dir, "fake-cf");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require("node:fs");
const args = process.argv.slice(2);
const file = args[args.indexOf("--body") + 1].slice(1);
const body = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, cwd: process.cwd(), file, body, mode: fs.statSync(file).mode & 511, account: process.env.CLOUDFLARE_ACCOUNT_ID, leakedGatewaySecret: process.env.OPENCLAW_CLEF_SYNTHETIC_SECRET !== undefined, leakedAuthOverride: process.env.CLOUDFLARE_API_TOKEN !== undefined }));
console.log(JSON.stringify({ ...${JSON.stringify(wire())}, model: body.model }));
`,
      { mode: 0o700 },
    );
    for (const model of MODEL_IDS) {
      const ctx = context(executable, model);
      ctx.config.plugins!.entries!["cloudflare-clef"]!.config = {
        binaryPath: executable,
        profile: "fixture-profile",
        accountId: "a".repeat(32),
      };
      const outcome = await provider.evaluate(batch, ctx);
      expect(outcome.status).toBe("ok");
      const captured = JSON.parse(await readFile(capture, "utf8"));
      expect(captured.args).toEqual([
        "ai",
        "run",
        `@cf/cloudflare/${model}`,
        "--body",
        `@${captured.file}`,
        "--profile",
        "fixture-profile",
      ]);
      expect(captured.cwd).not.toBe(dir);
      expect(captured.mode).toBe(0o600);
      expect(captured.body.state).toEqual({ color: "red", count: 3 });
      expect(captured.account).toBe("a".repeat(32));
      expect(captured.leakedGatewaySecret).toBe(false);
      expect(captured.leakedAuthOverride).toBe(false);
      await expect(access(captured.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("does not dispatch revoked, cancelled, unsupported routing or reasoning work", async () => {
  const ctx = context("/does-not-exist");
  await expect(provider.evaluate(batch, { ...ctx, isAdmissible: () => false })).rejects.toThrow(
    "authority closed",
  );
  const cancelled = AbortSignal.abort();
  await expect(provider.evaluate(batch, { ...ctx, signal: cancelled })).rejects.toThrow();
  expect(await provider.evaluate(batch, { ...ctx, reasoning: "on" })).toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(
    await provider.evaluate(batch, {
      ...ctx,
      model: { ...ctx.model, baseUrl: "https://example.invalid" },
    }),
  ).toEqual({ status: "unavailable", reason: "unsupported-input" });
});

it.skipIf(process.platform === "win32")(
  "settles physical child cancellation and timeout",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctl = new AbortController();
    const opts = { cwd: tmpdir(), env: process.env, signal: ctl.signal, timeoutMs: 10000 };
    const cancelled = runCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], opts);
    const rejected = expect(cancelled).rejects.toThrow();
    ctl.abort();
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    const timeout = runCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      ...opts,
      signal: new AbortController().signal,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(350);
    expect(await timeout).toMatchObject({ stopped: true });
  },
);

it.skipIf(process.platform === "win32").each([
  ["not logged in; cf auth login", "credentials-unavailable"],
  ["HTTP 401 unauthorized", "authentication"],
  ["HTTP 429 rate limit", "rate-limited"],
  ["HTTP 422 invalid input", "unsupported-input"],
  ["connection failed", "transport"],
])(
  "returns bounded failure categories for %s without leaking evidence",
  async (diagnostic, reason) => {
    const dir = tempDirs.make("clef-failure-test-");
    const executable = join(dir, "fake-cf");
    const capture = join(dir, "request-path.txt");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, args[args.indexOf("--body") + 1].slice(1));
console.error(${JSON.stringify(diagnostic + " synthetic-private-evidence")}); process.exit(1);\n`,
      { mode: 0o700 },
    );
    const outcome = await provider.evaluate(batch, context(executable));
    expect(outcome).toEqual({ status: "unavailable", reason });
    const requestPath = await readFile(capture, "utf8");
    await expect(access(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("admits a full-size host image instead of applying the CLI output ceiling to input", () => {
  const legal = {
    ...batch,
    state: {
      type: "image" as const,
      dataUri: "data:image/png;base64," + Buffer.alloc(4 * 1024 * 1024).toString("base64"),
    },
  };
  expect(toWire(legal, "clef-omni")?.images?.[0]).toBe(legal.state.dataUri);
});

it("rejects host API-key and auth-profile overrides rather than changing identity", async () => {
  const ctx = context("/does-not-exist");
  for (const auth of [
    { ...ctx.auth, apiKey: "synthetic-other-credential" },
    { ...ctx.auth, profileId: "cloudflare-clef:other" },
  ]) {
    expect(await provider.evaluate(batch, { ...ctx, auth })).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
  }
});
