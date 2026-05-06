import { expectProviderOnboardPrimaryAndFallbacks } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyOciConfig, OCI_DEFAULT_MODEL_REF } from "./onboard.js";

describe("oci-genai onboard", () => {
  it("registers oci as an OpenAI-compat provider with the chicago default", () => {
    const cfg = applyOciConfig({});
    expect(cfg.models?.providers?.oci).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1",
    });
  });

  it("sets the primary default model and falls back to the catalog", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOciConfig,
      modelRef: OCI_DEFAULT_MODEL_REF,
    });
  });

  it("aliases the default model under a friendly name", () => {
    const cfg = applyOciConfig({});
    expect(cfg.agents?.defaults?.models?.[OCI_DEFAULT_MODEL_REF]?.alias).toBe("OCI Llama 3.3 70B");
  });
});
