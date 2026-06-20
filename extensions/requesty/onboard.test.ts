// Requesty tests cover onboard plugin behavior.
import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, it } from "vitest";
import {
  applyRequestyConfig,
  applyRequestyProviderConfig,
  REQUESTY_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("requesty onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyRequestyProviderConfig,
      modelRef: REQUESTY_DEFAULT_MODEL_REF,
      alias: "Router",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyRequestyConfig,
      modelRef: REQUESTY_DEFAULT_MODEL_REF,
    });
  });
});
