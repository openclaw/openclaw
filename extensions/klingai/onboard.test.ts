import { describe, expect, it } from "vitest";
import {
  applyKlingaiCnConfig,
  applyKlingaiGlobalConfig,
  KLINGAI_CN_BASE_URL,
  KLINGAI_DEFAULT_IMAGE_MODEL_REF,
  KLINGAI_DEFAULT_VIDEO_MODEL_REF,
  KLINGAI_GLOBAL_BASE_URL,
} from "./onboard.js";

describe("klingai onboard", () => {
  it("applies global baseUrl and initializes provider models array", () => {
    const cfg = applyKlingaiGlobalConfig({});
    expect(cfg.models?.providers?.klingai).toMatchObject({
      baseUrl: KLINGAI_GLOBAL_BASE_URL,
      models: [],
    });
  });

  it("applies cn baseUrl and initializes provider models array", () => {
    const cfg = applyKlingaiCnConfig({});
    expect(cfg.models?.providers?.klingai).toMatchObject({
      baseUrl: KLINGAI_CN_BASE_URL,
      models: [],
    });
  });

  it("preserves existing provider models array", () => {
    const cfg = applyKlingaiGlobalConfig({
      models: {
        providers: {
          klingai: {
            baseUrl: KLINGAI_GLOBAL_BASE_URL,
            models: [
              {
                id: "kling-v3",
                name: "Kling V3",
                input: ["text"],
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    });
    expect(cfg.models?.providers?.klingai?.models).toHaveLength(1);
    expect(cfg.models?.providers?.klingai?.baseUrl).toBe(KLINGAI_GLOBAL_BASE_URL);
  });

  it("sets default image/video model refs when missing", () => {
    const cfg = applyKlingaiGlobalConfig({});
    expect(cfg.agents?.defaults?.imageGenerationModel).toEqual({
      primary: KLINGAI_DEFAULT_IMAGE_MODEL_REF,
    });
    expect(cfg.agents?.defaults?.videoGenerationModel).toEqual({
      primary: KLINGAI_DEFAULT_VIDEO_MODEL_REF,
    });
  });
});
