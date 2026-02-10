import { describe, it, expect } from "vitest";
import {
  discoverShengSuanYunModels,
  discoverShengSuanYunModalityModels,
  discoverAllShengSuanYunModels,
  SHENGSUANYUN_BASE_URL,
  SHENGSUANYUN_MODALITIES_BASE_URL,
} from "./shengsuanyun-models.js";

describe("ShengSuanYun provider", () => {
  it("should have the correct base URLs", () => {
    expect(SHENGSUANYUN_BASE_URL).toBe("https://router.shengsuanyun.com/api/v1");
    expect(SHENGSUANYUN_MODALITIES_BASE_URL).toBe("https://api.shengsuanyun.com/modelrouter");
  });

  it("should skip LLM discovery in test environment", async () => {
    const models = await discoverShengSuanYunModels();
    expect(models).toEqual([]);
  });

  it("should skip multimodal discovery in test environment", async () => {
    const models = await discoverShengSuanYunModalityModels();
    expect(models).toEqual([]);
  });

  it("should skip all model discovery in test environment", async () => {
    const models = await discoverAllShengSuanYunModels();
    expect(models).toEqual([]);
  });
});
