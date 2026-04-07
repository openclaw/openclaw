import { describe, expect, it } from "vitest";
import {
  buildLiteRtLmShimRequest,
  resolveLiteRtLmRuntimeConfig,
} from "./runtime-config.js";

describe("litertlm runtime config", () => {
  it("prefers explicit provider config over env", () => {
    const result = resolveLiteRtLmRuntimeConfig({
      model: { modelId: "litertlm/gemma4-e2b-edge-gallery" },
      env: {
        OPENCLAW_LITERTLM_PYTHON: "python-from-env",
        OPENCLAW_LITERTLM_SHIM: "/shim-from-env.py",
        OPENCLAW_LITERTLM_MODEL_FILE: "/model-from-env.litertlm",
        OPENCLAW_LITERTLM_TIMEOUT_MS: "999",
        OPENCLAW_LITERTLM_BACKEND: "GPU",
      },
      providerConfig: {
        pythonPath: "python-from-config",
        shimPath: "/shim-from-config.py",
        modelFile: "/model-from-config.litertlm",
        timeoutMs: 1234,
        backend: "CPU",
      },
    });

    expect(result).toEqual({
      pythonPath: "python-from-config",
      shimPath: "/shim-from-config.py",
      modelFile: "/model-from-config.litertlm",
      timeoutMs: 1234,
      backend: "CPU",
    });
  });

  it("falls back to env and defaults when provider config is absent", () => {
    const result = resolveLiteRtLmRuntimeConfig({
      model: { modelId: "litertlm/gemma4-e2b-edge-gallery" },
      env: {
        OPENCLAW_LITERTLM_PYTHON: "python3.12",
        OPENCLAW_LITERTLM_SHIM: "/tmp/litertlm_provider_shim.py",
        OPENCLAW_LITERTLM_MODEL_FILE: "/tmp/model.litertlm",
      },
    });

    expect(result.pythonPath).toBe("python3.12");
    expect(result.shimPath).toBe("/tmp/litertlm_provider_shim.py");
    expect(result.modelFile).toBe("/tmp/model.litertlm");
    expect(result.timeoutMs).toBe(120000);
    expect(result.backend).toBe("CPU");
  });

  it("builds a versioned shim request", () => {
    const runtimeConfig = resolveLiteRtLmRuntimeConfig({
      model: { modelId: "litertlm/gemma4-e2b-edge-gallery" },
      providerConfig: {
        modelFile: "/tmp/model.litertlm",
      },
    });

    const request = buildLiteRtLmShimRequest({
      modelId: "litertlm/gemma4-e2b-edge-gallery",
      runtimeConfig,
      prompt: "hello",
      system: "be concise",
      requestId: "req_1",
      maxOutputTokens: 128,
      temperature: 0.2,
    });

    expect(request).toEqual({
      version: 1,
      requestId: "req_1",
      model: {
        id: "litertlm/gemma4-e2b-edge-gallery",
        file: "/tmp/model.litertlm",
      },
      runtime: {
        backend: "CPU",
        timeoutMs: 120000,
      },
      input: {
        system: "be concise",
        prompt: "hello",
      },
      options: {
        maxOutputTokens: 128,
        temperature: 0.2,
      },
    });
  });
});
