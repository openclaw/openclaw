import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, it } from "vitest";
import {
  applyInworldConfig,
  applyInworldProviderConfig,
  INWORLD_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("inworld onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyInworldProviderConfig,
      modelRef: INWORLD_DEFAULT_MODEL_REF,
      alias: "Inworld",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyInworldConfig,
      modelRef: INWORLD_DEFAULT_MODEL_REF,
    });
  });
});
