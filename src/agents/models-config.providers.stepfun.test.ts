import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("stepfun implicit provider", () => {
  it("includes stepfun with step-3.5-flash when STEPFUN_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["STEPFUN_API_KEY"]);
    process.env.STEPFUN_API_KEY = "sk-stepfun-test";

    try {
      const providers = (await resolveImplicitProviders({ agentDir })) ?? {};
      expect(providers.stepfun).toBeDefined();
      expect(providers.stepfun?.api).toBe("openai-completions");
      expect(providers.stepfun?.baseUrl).toBe("https://api.stepfun.ai/v1");
      expect(providers.stepfun?.models?.[0]?.id).toBe("step-3.5-flash");
      expect(providers.stepfun?.models?.[0]?.name).toBe("Step 3.5 Flash");
    } finally {
      envSnapshot.restore();
    }
  });

  it("does not include stepfun when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["STEPFUN_API_KEY"]);
    delete process.env.STEPFUN_API_KEY;

    try {
      const providers = (await resolveImplicitProviders({ agentDir })) ?? {};
      expect(providers.stepfun).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
