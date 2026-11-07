/**
 * Prompt presence check measurement harness (run via scripts/tsx.mjs).
 *
 * Prints measured latency (median/p95 over runs) and event sizes (UTF-8 bytes)
 * for representative and boundary fixtures. Numbers are machine-dependent:
 * record them in the PR for the machine that produced them; the script itself
 * is deterministic in setup.
 */
import { performance } from "node:perf_hooks";
import {
  collectResponsesRegions,
  runPromptPresenceCheck,
  type PromptPresenceExpectation,
} from "./prompt-presence-check.js";

const BODY_BASE =
  "产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性（第 N 条，占位正文用于测量扫描成本）。";
const BOUNDARY_BODY = "x".repeat(64 * 1024 - 4);

function buildRepresentativeExpectations(count: number): PromptPresenceExpectation[] {
  return Array.from({ length: count }, (_, index) => {
    const bodyText = BODY_BASE.replace("N", String(index)) + " pad".repeat(40);
    return {
      activationId: `act_prompt_${index}`,
      revision: 0,
      bodyText,
      bodyChars: bodyText.length,
      bodyComplete: true,
    };
  });
}

function buildRepresentativeRequest(expectationCount: number) {
  // System region in the 53–65k char range (observed production range), with
  // every expectation body embedded so each check performs a real substring scan.
  const bodies = buildRepresentativeExpectations(expectationCount);
  const filler = "g".repeat(Math.max(0, 58_000 - expectationCount * 220));
  const systemText = [filler, ...bodies.map((b) => b.bodyText)].join("\n");
  return {
    request: {
      instructions: systemText,
      input: [
        { role: "user", content: "continue" },
        { role: "user", content: "unrelated user text for wrong-role scanning" },
      ],
    },
    expectations: bodies,
  };
}

function measure(
  label: string,
  runs: number,
  build: () => { request: unknown; expectations: PromptPresenceExpectation[] },
) {
  // Warm-up (excluded from statistics).
  for (let i = 0; i < 3; i++) {
    const { request, expectations } = build();
    runPromptPresenceCheck({
      collected: collectResponsesRegions(request),
      expectations,
      attemptIndex: 0,
    });
  }
  const samples: number[] = [];
  let check: ReturnType<typeof runPromptPresenceCheck> | undefined;
  for (let i = 0; i < runs; i++) {
    const { request, expectations } = build();
    const collected = collectResponsesRegions(request);
    const started = performance.now();
    check = runPromptPresenceCheck({ collected, expectations, attemptIndex: 0 });
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  const eventBytes = Buffer.byteLength(JSON.stringify(check), "utf8");
  console.log(
    `${label}: runs=${runs} median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms ` +
      `eventUtf8Bytes=${eventBytes} outcomes=${check?.results.map((r) => r.outcome).join(",")}`,
  );
}

console.log("prompt presence check measurement (this machine)");
measure("representative 18 expectations × ~2.2KiB bodies, 58k system region", 30, () =>
  buildRepresentativeRequest(18),
);
measure("representative 1 expectation × ~2.2KiB body, 58k system region", 30, () =>
  buildRepresentativeRequest(1),
);
measure("boundary 64 expectations × 64KiB bodies (under limits)", 10, () => {
  const expectations = Array.from({ length: 64 }, (_, index) => ({
    activationId: `act_boundary_${index}`,
    revision: 0,
    bodyText: BOUNDARY_BODY + String(index).padStart(3, "0"),
    bodyChars: BOUNDARY_BODY.length + 3,
    bodyComplete: true,
  }));
  const systemText = expectations.map((e) => e.bodyText).join("\n");
  return {
    request: { instructions: systemText, input: [{ role: "user", content: "go" }] },
    expectations,
  };
});
