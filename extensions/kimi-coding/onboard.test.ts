import { describe, expect, it } from "vitest";
import {
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  KIMI_CODING_MODEL_REF,
  KIMI_MODEL_REF,
} from "./onboard.js";
import { KIMI_CODING_BASE_URL, KIMI_CODING_DEFAULT_MODEL_ID } from "./provider-catalog.js";

describe("Kimi onboard config", () => {
  it("exposes consistent model refs", () => {
    expect(KIMI_MODEL_REF).toBe(`kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`);
    expect(KIMI_CODING_MODEL_REF).toBe(KIMI_MODEL_REF);
  });

  it("applies kimi provider config with correct baseUrl and api", () => {
    const cfg = applyKimiCodeProviderConfig({} as never);
    const kimiProvider = cfg.models?.providers?.kimi as Record<string, unknown>;

    expect(kimiProvider).toBeDefined();
    expect(kimiProvider.baseUrl).toBe(KIMI_CODING_BASE_URL);
    expect(kimiProvider.api).toBe("anthropic-messages");
  });

  it("applies kimi config with default model as primary", () => {
    const cfg = applyKimiCodeConfig({} as never);

    expect(
      (cfg.agents?.defaults?.model as { primary?: string })?.primary,
    ).toBe(KIMI_MODEL_REF);
  });

  it("registers the Kimi alias for the default model", () => {
    const cfg = applyKimiCodeConfig({} as never);

    const alias = cfg.agents?.defaults?.models?.[KIMI_MODEL_REF]?.alias;
    expect(alias).toBe("Kimi");
  });

  it("includes the default model in provider models list", () => {
    const cfg = applyKimiCodeProviderConfig({} as never);
    const kimiProvider = cfg.models?.providers?.kimi as Record<string, unknown>;
    const models = kimiProvider.models as Array<{ id: string }>;

    expect(models).toBeDefined();
    expect(models.some((model) => model.id === KIMI_CODING_DEFAULT_MODEL_ID)).toBe(true);
  });
});
