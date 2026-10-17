import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyStepFunStandardConfigCn } from "./onboard.js";

const priorRef = "stepfun/step-3.5-flash";

/** Resolve the user-facing "StepFun" alias the way runtime model selection does. */
function resolveAliasTarget(cfg: OpenClawConfig): string | undefined {
  const match = resolveModelRefFromString({
    cfg,
    raw: "StepFun",
    defaultProvider: "stepfun",
    aliasIndex: buildModelAliasIndex({ cfg, defaultProvider: "stepfun" }),
  });
  return match ? `${match.ref.provider}/${match.ref.model}` : undefined;
}

describe("StepFun alias resolution after re-onboarding", () => {
  it("keeps a padded legacy alias pointed at the model that already owned it", () => {
    // " StepFun " and "StepFun" are the same alias to the runtime, which trims.
    const upgraded = applyStepFunStandardConfigCn({
      agents: { defaults: { model: priorRef, models: { [priorRef]: { alias: " StepFun " } } } },
    });

    expect(resolveAliasTarget(upgraded)).toBe(priorRef);
  });

  it("resolves the alias to the new default on a fresh install", () => {
    expect(resolveAliasTarget(applyStepFunStandardConfigCn({}))).toBe("stepfun/step-5-preview");
  });
});
