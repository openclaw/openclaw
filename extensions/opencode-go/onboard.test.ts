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

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpencodeGoConfig,
      modelRef: MODEL_REF,
    });
  });

  it("maps the unversioned GLM alias to the latest GLM 5.1 model", () => {
    const next = applyOpencodeGoProviderConfig({} as never);
    expect(next.agents?.defaults?.models?.["opencode-go/glm-5.1"]).toMatchObject({
      alias: "GLM",
    });
  });

  it("keeps the older GLM 5 alias versioned", () => {
    const next = applyOpencodeGoProviderConfig({} as never);
    expect(next.agents?.defaults?.models?.["opencode-go/glm-5"]).toMatchObject({
      alias: "GLM 5",
    });
  });

  it("migrates an existing unversioned GLM alias from GLM 5 to GLM 5.1", () => {
    const next = applyOpencodeGoProviderConfig({
      agents: {
        defaults: {
          models: {
            "opencode-go/glm-5": { alias: "GLM" },
          },
        },
      },
    } as never);

    expect(next.agents?.defaults?.models?.["opencode-go/glm-5"]).toMatchObject({
      alias: "GLM 5",
    });
    expect(next.agents?.defaults?.models?.["opencode-go/glm-5.1"]).toMatchObject({
      alias: "GLM",
    });
  });
});
