import { describe, expect, it } from "vitest";
import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "../../test/helpers/plugins/provider-onboard.js";
import { applyOpencodeGoConfig, applyOpencodeGoProviderConfig } from "./onboard.js";

const MODEL_REF = "opencode-go/kimi-k2.5";

describe("opencode-go onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpencodeGoProviderConfig,
      modelRef: MODEL_REF,
      alias: "Kimi",
    });
  });

  it("maps the unversioned MiniMax alias to the latest MiniMax M2.7 model", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpencodeGoProviderConfig,
      modelRef: "opencode-go/minimax-m2.7",
      alias: "MiniMax",
    });
  });

  it("keeps the older MiniMax M2.5 alias versioned", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpencodeGoProviderConfig,
      modelRef: "opencode-go/minimax-m2.5",
      alias: "MiniMax M2.5",
    });
  });

  it("migrates an existing unversioned MiniMax alias from M2.5 to M2.7", () => {
    const next = applyOpencodeGoProviderConfig({
      agents: {
        defaults: {
          models: {
            "opencode-go/minimax-m2.5": { alias: "MiniMax" },
          },
        },
      },
    } as never);

    expect(next.agents?.defaults?.models?.["opencode-go/minimax-m2.5"]).toMatchObject({
      alias: "MiniMax M2.5",
    });
    expect(next.agents?.defaults?.models?.["opencode-go/minimax-m2.7"]).toMatchObject({
      alias: "MiniMax",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpencodeGoConfig,
      modelRef: MODEL_REF,
    });
  });
});
