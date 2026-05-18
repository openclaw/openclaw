import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, it } from "vitest";
import {
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  applyTrustedRouterConfig,
  applyTrustedRouterProviderConfig,
  OPENROUTER_DEFAULT_MODEL_REF,
  TRUSTEDROUTER_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("openrouter onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpenrouterProviderConfig,
      modelRef: OPENROUTER_DEFAULT_MODEL_REF,
      alias: "Router",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpenrouterConfig,
      modelRef: OPENROUTER_DEFAULT_MODEL_REF,
    });
  });

  it("adds TrustedRouter allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyTrustedRouterProviderConfig,
      modelRef: TRUSTEDROUTER_DEFAULT_MODEL_REF,
      alias: "E2EE Router",
    });
  });

  it("sets TrustedRouter primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyTrustedRouterConfig,
      modelRef: TRUSTEDROUTER_DEFAULT_MODEL_REF,
    });
  });
});
