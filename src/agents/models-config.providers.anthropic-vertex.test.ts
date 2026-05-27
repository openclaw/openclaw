import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("anthropic-vertex implicit provider", () => {
  it("offers Claude models when GOOGLE_CLOUD_PROJECT_ID is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_CLOUD_PROJECT_ID"]);
    process.env.GOOGLE_CLOUD_PROJECT_ID = "vertex-project";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("accepts ADC credentials when the file includes a project_id", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"]);
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_CLOUD_LOCATION = "us-east1";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://us-east1-aiplatform.googleapis.com",
      );
      expect(providers?.["anthropic-vertex"]?.models).toMatchObject([
        { id: "claude-opus-4-6", maxTokens: 128000, contextWindow: 1_000_000 },
        { id: "claude-sonnet-4-6", maxTokens: 128000, contextWindow: 1_000_000 },
      ]);
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });

  it("accepts ADC credentials when the file only includes a quota_project_id", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"]);
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ quota_project_id: "vertex-quota" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_CLOUD_LOCATION = "us-east5";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://us-east5-aiplatform.googleapis.com",
      );
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });

  it("accepts ADC credentials when project_id is resolved at runtime", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"]);
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, "{}", "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_CLOUD_LOCATION = "europe-west4";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://europe-west4-aiplatform.googleapis.com",
      );
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });

  it("falls back to the default region when GOOGLE_CLOUD_LOCATION is invalid", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"]);
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_CLOUD_LOCATION = "us-central1.attacker.example";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe("https://aiplatform.googleapis.com");
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });

  it("uses the Vertex global endpoint when GOOGLE_CLOUD_LOCATION=global", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"]);
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_CLOUD_LOCATION = "global";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe("https://aiplatform.googleapis.com");
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });

  it("accepts explicit metadata auth opt-in without local credential files", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["ANTHROPIC_VERTEX_USE_GCP_METADATA", "GOOGLE_CLOUD_LOCATION"]);
    process.env.ANTHROPIC_VERTEX_USE_GCP_METADATA = "true";
    process.env.GOOGLE_CLOUD_LOCATION = "us-east5";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://us-east5-aiplatform.googleapis.com",
      );
    } finally {
      envSnapshot.restore();
    }
  });

  it("merges the bundled catalog into explicit anthropic-vertex provider overrides", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"]);
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_CLOUD_LOCATION = "us-east5";

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        config: {
          models: {
            providers: {
              "anthropic-vertex": {
                baseUrl: "https://europe-west4-aiplatform.googleapis.com",
                headers: { "x-test-header": "1" },
              },
            },
          },
        } as unknown as OpenClawConfig,
      });

      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://europe-west4-aiplatform.googleapis.com",
      );
      expect(providers?.["anthropic-vertex"]?.headers).toEqual({ "x-test-header": "1" });
      expect(providers?.["anthropic-vertex"]?.models?.map((model) => model.id)).toEqual([
        "claude-opus-4-6",
        "claude-sonnet-4-6",
      ]);
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });

  it("does not accept generic Kubernetes env without a GCP ADC signal", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KUBERNETES_SERVICE_HOST", "GOOGLE_CLOUD_LOCATION"]);
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.GOOGLE_CLOUD_LOCATION = "us-east5";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.["anthropic-vertex"]).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
