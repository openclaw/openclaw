import { describe, expect, it } from "vitest";
import {
  ModelTargetFenceUnavailableError,
  qualifyModelCandidatesAgainstFences,
  requireQualifiedModelCandidates,
} from "./model-target-fence-qualification.js";

const activeFence = {
  provider: "kalliope",
  model: "qwen3.6:35b-a3b",
  topologyGeneration: "mama-single-gpu-v7",
  fenceEpoch: 41,
  fenceToken: "fence-token-41",
  mode: "divert_new",
  state: "active",
  resourceDomain: "mama-gpu-residency",
  deniedTargets: [
    { provider: "kalliope", model: "qwen3.6:27b" },
    { provider: "ornith", model: "qwen3.6:27b" },
  ],
  createdAtMs: 1_000,
  preparedAtMs: null,
  generationGoneAtMs: null,
  releasedAtMs: null,
} as const;

describe("new-work model target fence qualification", () => {
  it("skips the exact target and uses an unrelated fallback", () => {
    const result = qualifyModelCandidatesAgainstFences(
      [
        { provider: "kalliope", model: "qwen3.6:35b-a3b" },
        { provider: "openai", model: "gpt-5.4" },
      ],
      [activeFence],
    );

    expect(result.allowed).toEqual([{ provider: "openai", model: "gpt-5.4" }]);
    expect(result.denied).toEqual([
      expect.objectContaining({ reason: "target_diverted", fenceEpoch: 41 }),
    ]);
  });

  it("denies generic resource-domain conflicts without disturbing unrelated targets", () => {
    const result = qualifyModelCandidatesAgainstFences(
      [
        { provider: "kalliope", model: "qwen3.6:27b" },
        { provider: "ornith", model: "qwen3.6:27b" },
        { provider: "john", model: "deepseek-v4-flash-dspark" },
      ],
      [activeFence],
    );

    expect(result.allowed).toEqual([{ provider: "john", model: "deepseek-v4-flash-dspark" }]);
    expect(result.denied.map((entry) => entry.reason)).toEqual([
      "resource_domain_conflict",
      "resource_domain_conflict",
    ]);
  });

  it("returns visible degradation when every configured candidate is fenced", () => {
    const result = qualifyModelCandidatesAgainstFences(
      [
        { provider: "kalliope", model: "qwen3.6:35b-a3b" },
        { provider: "kalliope", model: "qwen3.6:27b" },
      ],
      [activeFence],
    );

    expect(() => requireQualifiedModelCandidates(result)).toThrow(
      new ModelTargetFenceUnavailableError(
        "No configured model is currently available: recovery diverted kalliope/qwen3.6:35b-a3b and blocked kalliope/qwen3.6:27b to protect resource domain mama-gpu-residency.",
      ),
    );
  });

  it("fails closed when the fence capability cannot provide a trustworthy snapshot", () => {
    expect(() =>
      requireQualifiedModelCandidates({
        status: "capability_unavailable",
        allowed: [],
        denied: [],
        error: "model recovery fence schema is unavailable",
      }),
    ).toThrow(
      new ModelTargetFenceUnavailableError(
        "Model routing is unavailable because recovery fence state could not be verified: model recovery fence schema is unavailable",
      ),
    );
  });
});
