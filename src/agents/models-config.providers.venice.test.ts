import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";
import { VENICE_MODEL_CATALOG } from "./venice-models.js";

describe("Venice implicit provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses static Venice catalog without runtime discovery fetches", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await withEnvAsync(
      {
        NODE_ENV: "development",
        VITEST: undefined,
        VENICE_API_KEY: "venice-test-key",
        OLLAMA_API_KEY: undefined,
        HUGGINGFACE_API_KEY: undefined,
        AWS_REGION: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_SESSION_TOKEN: undefined,
      },
      async () => {
        const providers = await resolveImplicitProviders({ agentDir });
        expect(providers?.venice).toBeDefined();
        expect(providers?.venice?.models).toHaveLength(VENICE_MODEL_CATALOG.length);
      },
    );

    const veniceCalls = fetchSpy.mock.calls.filter(([url]) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : "";
      return requestUrl.includes("api.venice.ai/api/v1/models");
    });
    expect(veniceCalls).toHaveLength(0);
  });
});
