import { afterAll, expect, it } from "vitest";
import * as fx from "../test/runtime-tool-fixture-helpers.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const tool = "web_search";

function transcript(phase: "happy" | "failure") {
  const happy = phase === "happy";
  return [
    fx.transcriptToolCall(tool, phase, { query: happy ? "qa" : "" }),
    fx.transcriptToolResult(tool, phase, happy ? "result" : "required", happy ? undefined : true),
  ];
}

async function makeFixture(patch: Partial<QaSuiteRuntimeEnv> = {}) {
  const env = await fx.makeEnv({ runtimeId: "codex", runtimeSelection: "configured", ...patch });
  if (patch.runtimeSelection === "forced") {
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = patch.runtimeId;
  }
  await fx.writeRuntimeToolTranscripts(env, tool, transcript("happy"), transcript("failure"));
  return env;
}

afterAll(fx.cleanupRuntimeToolFixtureTempRoots);

const config = fx.runtimeToolFixtureConfig(tool, {
  toolCoverage: {
    bucket: "openclaw-dynamic-integration",
    expectedLayer: "openclaw-dynamic",
    capabilityLayer: "openclaw-dynamic-searchable",
    required: true,
  },
});

const run = (env: QaSuiteRuntimeEnv) =>
  fx.runLiveRuntimeToolFixture(env, { toolName: tool, config });

it.each(["happy", "failure"] as const)(
  "rejects a discovery receipt for a different %s target call",
  async (mismatchedPhase) => {
    const env = await makeFixture();
    for (const phase of ["happy", "failure"] as const) {
      fx.writeToolSearchDiscoveryEvidence(
        env,
        tool,
        phase,
        phase === mismatchedPhase ? `other-${phase}` : `call-web_search-${phase}`,
      );
    }
    await expect(run(env)).rejects.toThrow(
      `expected live ${mismatchedPhase}-path tool_search discovery for web_search`,
    );
  },
);

it("requires linked discovery receipts for configured live searchable Codex tools", async () => {
  await expect(run(await makeFixture())).rejects.toThrow(
    "expected live happy-path tool_search discovery for web_search",
  );

  const observedEnv = await makeFixture();
  fx.writeToolSearchDiscoveryEvidence(observedEnv, tool, "happy", undefined, {
    callStatus: null,
  });
  fx.writeToolSearchDiscoveryEvidence(observedEnv, tool, "failure");
  const details = await run(observedEnv);
  expect(details).toContain(
    "web_search live provider discovery receipts: happy=search-happy failure=search-failure",
  );
  expect(details).toContain(
    "phase=happy search=search-happy search-call=client search-output=client/completed",
  );
});

it.each([
  { runtimeId: "codex", runtimeSelection: "forced" },
  { runtimeId: "openclaw", runtimeSelection: "forced" },
  { runtimeId: "openclaw", runtimeSelection: "configured" },
  { runtimeId: "openclaw", runtimeSelection: undefined },
] as const)(
  "accepts shared searchable fixtures without Codex receipts in a direct cell ($runtimeId/$runtimeSelection)",
  async ({ runtimeId, runtimeSelection }) => {
    const details = await run(await makeFixture({ runtimeId, runtimeSelection }));
    expect(details).toContain("web_search live provider happy planned args");
    expect(details).not.toContain("discovery receipts");
  },
);
