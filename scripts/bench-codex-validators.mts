// Run: node --import ./scripts/tsx.mjs scripts/bench-codex-validators.mts <mode> [iterations] [warmup] [fixture]
// Compare five interleaved fresh processes. Owner setup includes its import; kernel setup excludes module loading.

type Check = (value: unknown) => boolean;
const mode = process.argv[2] ?? "precompiled";
if (!["runtime", "fallback", "precompiled", "owner", "owner-fallback"].includes(mode)) {
  throw new Error("Expected runtime, fallback, precompiled, owner, or owner-fallback mode");
}
const iterations = Number(process.argv[3] ?? 20_000);
const warmup = Number(process.argv[4] ?? 20_000);
if (
  !Number.isSafeInteger(iterations) ||
  iterations <= 0 ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0
) {
  throw new Error("Iterations must be positive and warmup nonnegative safe integers");
}

let checks: Record<string, Check>;
let setupMs = 0;
let runtimeCompilations: number | undefined;
if (mode === "owner" || mode === "owner-fallback") {
  if (mode === "owner-fallback") {
    const { Settings } = await import("typebox/system");
    Settings.Set({ useAcceleration: false });
  }
  const started = performance.now();
  const owner = await import("../extensions/codex/src/app-server/protocol-validators.js");
  setupMs = performance.now() - started;
  checks = {
    isCodexModelListResponse: (value) => owner.assertCodexModelListResponse(value) !== undefined,
    isCodexTurnStartResponse: (value) => owner.assertCodexTurnStartResponse(value) !== undefined,
    isCodexDynamicToolCallParams: (value) =>
      owner.readCodexDynamicToolCallParams(value) !== undefined,
  };
} else if (mode === "precompiled") {
  checks = await import("../extensions/codex/src/app-server/protocol-validators.generated.js");
  runtimeCompilations = 0;
} else {
  const { Compile } = await import("typebox/compile");
  const { Settings } = await import("typebox/system");
  const { createCodexValidationSchemas } =
    await import("../extensions/codex/src/app-server/protocol-validator-schemas.js");
  if (mode === "fallback") {
    Settings.Set({ useAcceleration: false });
  }
  const started = performance.now();
  const { context, schemas } = createCodexValidationSchemas();
  let compilations = 0;
  checks = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]): [string, Check] => {
      const validator = Compile(context, schema);
      compilations++;
      return [`is${name}`, (value) => validator.Check(value)];
    }),
  );
  runtimeCompilations = compilations;
  setupMs = performance.now() - started;
}

const model = {
  id: "synthetic-model",
  model: "synthetic-model",
  displayName: "Synthetic model",
  description: "Validator benchmark fixture",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
};
const turn = {
  id: "synthetic-turn",
  status: "inProgress",
  items: [{ type: "agentMessage", id: "synthetic-item", text: "Synthetic fixture" }],
};
const dynamic = {
  arguments: { text: "synthetic" },
  callId: "synthetic-call",
  threadId: "synthetic-thread",
  turnId: "synthetic-turn",
  tool: "synthetic_tool",
};
// Wire fixtures keep decoded values unknown at the validation boundary.
const cases = [
  {
    name: "model-list",
    binding: "isCodexModelListResponse",
    good: JSON.stringify({ data: [model] }),
    bad: JSON.stringify({ data: [{ ...model, hidden: "false" }] }),
  },
  {
    name: "turn-start",
    binding: "isCodexTurnStartResponse",
    good: JSON.stringify({ turn }),
    bad: JSON.stringify({ turn: { ...turn, status: "synthetic-invalid" } }),
  },
  {
    name: "dynamic-tool",
    binding: "isCodexDynamicToolCallParams",
    good: JSON.stringify(dynamic),
    bad: JSON.stringify({ ...dynamic, tool: 42 }),
  },
];
const fixture = process.argv[5];
if (fixture && !cases.some(({ name }) => name === fixture)) {
  throw new Error(`Unknown fixture: ${fixture}`);
}
const results = cases
  .filter(({ name }) => !fixture || name === fixture)
  .map(({ name, binding, good, bad }) => {
    const check = checks[binding];
    const input: unknown = JSON.parse(good);
    const invalid: unknown = JSON.parse(bad);
    const firstCheckStarted = performance.now();
    if (!check || !check(input)) {
      throw new Error(`${name}: positive control failed`);
    }
    const firstCheckMs = performance.now() - firstCheckStarted;
    let acceptsInvalid = false;
    const firstInvalidStarted = performance.now();
    try {
      acceptsInvalid = check(invalid);
    } catch {
      // Public assertion APIs reject by throwing.
    }
    const firstInvalidMs = performance.now() - firstInvalidStarted;
    if (acceptsInvalid) {
      throw new Error(`${name}: negative control failed`);
    }
    const other = structuredClone(input);
    let accepted = 0;
    for (let index = 0; index < warmup; index++) {
      accepted += Number(check(index & 1 ? input : other));
    }
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const cpu = process.cpuUsage();
      const started = performance.now();
      for (let index = 0; index < iterations; index++) {
        accepted += Number(check(index & 1 ? input : other));
      }
      const wallMs = performance.now() - started;
      const usage = process.cpuUsage(cpu);
      samples.push({ wallMs, cpuNsPerCheck: ((usage.user + usage.system) * 1000) / iterations });
    }
    if (accepted !== warmup + 5 * iterations) {
      throw new Error(`${name}: checksum failed`);
    }
    return { name, accepted, firstCheckMs, firstInvalidMs, samples };
  });
console.log(JSON.stringify({ mode, iterations, warmup, setupMs, runtimeCompilations, results }));
