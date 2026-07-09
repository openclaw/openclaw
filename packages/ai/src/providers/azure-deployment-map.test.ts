// Azure deployment map tests cover model-to-deployment resolution.
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseAzureDeploymentNameMap,
  resolveAzureDeploymentNameFromMap,
  testing,
} from "./azure-deployment-map.js";

describe("Azure deployment name map", () => {
  beforeEach(() => {
    testing.resetDeploymentNameMapCache();
  });

  it("preserves equals signs inside deployment names", () => {
    const map = parseAzureDeploymentNameMap("gpt-5=deployment=blue, ignored, gpt-4 = prod = east ");

    expect(map.get("gpt-5")).toBe("deployment=blue");
    expect(map.get("gpt-4")).toBe("prod = east");
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "gpt-5",
        deploymentMap: "gpt-5=deployment=blue",
      }),
    ).toBe("deployment=blue");
  });

  it("falls back to the model id when the map has no usable entry", () => {
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "gpt-5",
        deploymentMap: "other=deployment,missing-value=",
      }),
    ).toBe("gpt-5");
  });

  it("matches model ids case-insensitively when the request casing differs", () => {
    // Map key lower-case, request upper-case.
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "GPT-4o",
        deploymentMap: "gpt-4o=deployment-gpt-4o",
      }),
    ).toBe("deployment-gpt-4o");

    // Map key upper-case, request lower-case.
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "gpt-4o",
        deploymentMap: "GPT-4O=deployment-gpt-4o",
      }),
    ).toBe("deployment-gpt-4o");

    // Both sides mixed case.
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "Gpt-4O",
        deploymentMap: "gPt-4o=deployment-gpt-4o",
      }),
    ).toBe("deployment-gpt-4o");
  });

  it("preserves the deployment name casing verbatim", () => {
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "gpt-4o",
        deploymentMap: "gpt-4o=Deployment-GPT-4o",
      }),
    ).toBe("Deployment-GPT-4o");
  });

  it("preserves the original model id casing on fallback", () => {
    expect(
      resolveAzureDeploymentNameFromMap({
        modelId: "GPT-4o",
        deploymentMap: "other=deployment",
      }),
    ).toBe("GPT-4o");
  });

  it("prefers an exact-case match over the case-insensitive fallback", () => {
    // Keys differing only by case must keep their exact mappings (backward compatible).
    const deploymentMap = "GPT-4o=prod-a,gpt-4o=prod-b";
    expect(resolveAzureDeploymentNameFromMap({ modelId: "GPT-4o", deploymentMap })).toBe("prod-a");
    expect(resolveAzureDeploymentNameFromMap({ modelId: "gpt-4o", deploymentMap })).toBe("prod-b");
    // A request matching neither exact key falls back case-insensitively.
    expect(resolveAzureDeploymentNameFromMap({ modelId: "Gpt-4O", deploymentMap })).toBe("prod-b");
  });

  it("caches the parsed lookup per deployment-map string", () => {
    const first = testing.getCachedDeploymentLookup("gpt-4o=deployment-gpt-4o");
    const second = testing.getCachedDeploymentLookup("gpt-4o=deployment-gpt-4o");
    // Same input string must reuse the same parsed lookup instead of re-parsing.
    expect(second).toBe(first);

    const other = testing.getCachedDeploymentLookup("gpt-5=deployment-gpt-5");
    expect(other).not.toBe(first);
  });
});
