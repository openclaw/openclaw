import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, it } from "vitest";
import {
  applyEdenaiConfig,
  applyEdenaiProviderConfig,
  EDENAI_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("edenai onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyEdenaiProviderConfig,
      modelRef: EDENAI_DEFAULT_MODEL_REF,
      alias: "Eden AI",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyEdenaiConfig,
      modelRef: EDENAI_DEFAULT_MODEL_REF,
    });
  });
});
