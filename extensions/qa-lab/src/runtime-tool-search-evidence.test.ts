import { afterAll, expect, it } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  runLiveRuntimeToolFixture,
  runtimeToolFixtureConfig,
  transcriptToolCall,
  transcriptToolResult,
  writeRuntimeToolTranscripts,
  writeToolSearchDiscoveryEvidence,
} from "../test/runtime-tool-fixture-helpers.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

async function writeLiveRuntimeToolEvidence(env: QaSuiteRuntimeEnv) {
  await writeRuntimeToolTranscripts(
    env,
    "web_search",
    [
      transcriptToolCall("web_search", "happy", { query: "qa" }),
      transcriptToolResult("web_search", "happy", "result"),
    ],
    [
      transcriptToolCall("web_search", "failure", { query: "" }),
      transcriptToolResult("web_search", "failure", "required", true),
    ],
  );
}

afterAll(cleanupRuntimeToolFixtureTempRoots);

const config = runtimeToolFixtureConfig("web_search", {
  toolCoverage: {
    bucket: "openclaw-dynamic-integration",
    expectedLayer: "openclaw-dynamic",
    capabilityLayer: "openclaw-dynamic-searchable",
    required: true,
  },
});

it.each(["happy", "failure"] as const)(
  "rejects a discovery receipt for a different %s target call",
  async (mismatchedPhase) => {
    const env = await makeEnv({ runtimeId: "codex", runtimeSelection: "configured" });
    await writeLiveRuntimeToolEvidence(env);
    for (const phase of ["happy", "failure"] as const) {
      writeToolSearchDiscoveryEvidence(
        env,
        "web_search",
        phase,
        phase === mismatchedPhase ? `other-${phase}` : `call-web_search-${phase}`,
      );
    }
    await expect(
      runLiveRuntimeToolFixture(env, { toolName: "web_search", config }),
    ).rejects.toThrow(`expected live ${mismatchedPhase}-path tool_search discovery for web_search`);
  },
);

it("requires linked discovery receipts for configured live searchable Codex tools", async () => {
  const missingEnv = await makeEnv({ runtimeId: "codex", runtimeSelection: "configured" });
  await writeLiveRuntimeToolEvidence(missingEnv);
  await expect(
    runLiveRuntimeToolFixture(missingEnv, { toolName: "web_search", config }),
  ).rejects.toThrow("expected live happy-path tool_search discovery for web_search");

  const observedEnv = await makeEnv({ runtimeId: "codex", runtimeSelection: "configured" });
  await writeLiveRuntimeToolEvidence(observedEnv);
  writeToolSearchDiscoveryEvidence(observedEnv, "web_search", "happy", undefined, {
    callStatus: null,
  });
  writeToolSearchDiscoveryEvidence(observedEnv, "web_search", "failure");
  const details = await runLiveRuntimeToolFixture(observedEnv, {
    toolName: "web_search",
    config,
  });
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
    const env = await makeEnv({ runtimeId, runtimeSelection });
    if (runtimeSelection === "forced") {
      env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = runtimeId;
    }
    await writeLiveRuntimeToolEvidence(env);
    const details = await runLiveRuntimeToolFixture(env, { toolName: "web_search", config });
    expect(details).toContain("web_search live provider happy planned args");
    expect(details).not.toContain("discovery receipts");
  },
);
