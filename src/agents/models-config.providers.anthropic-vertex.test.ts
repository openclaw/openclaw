import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAnthropicVertexProvider,
  mergeImplicitAnthropicVertexProvider,
  resolveImplicitAnthropicVertexProvider,
} from "../../extensions/anthropic-vertex/api.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("anthropic-vertex implicit provider", () => {
  it("offers Claude models when GOOGLE_CLOUD_PROJECT_ID is set", () => {
    const provider = resolveImplicitAnthropicVertexProvider({
      env: { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" },
    });
    expect(provider).toBeNull();
  });

  it("accepts ADC credentials when the file includes a project_id", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_LOCATION: "us-east1",
        },
      });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://us-east1-aiplatform.googleapis.com",
      );
      expect(providers?.["anthropic-vertex"]?.models).toMatchObject([
        { id: "claude-opus-4-6", maxTokens: 128000, contextWindow: 1_000_000 },
        { id: "claude-sonnet-4-6", maxTokens: 128000, contextWindow: 1_000_000 },
      ]);
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
    }
  });

  it("accepts ADC credentials when the file only includes a quota_project_id", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ quota_project_id: "vertex-quota" }), "utf8");

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_LOCATION: "us-east5",
        },
      });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://us-east5-aiplatform.googleapis.com",
      );
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
    }
  });

  it("accepts ADC credentials when project_id is resolved at runtime", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, "{}", "utf8");

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_LOCATION: "europe-west4",
        },
      });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe(
        "https://europe-west4-aiplatform.googleapis.com",
      );
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
    }
  });

  it("falls back to the default region when GOOGLE_CLOUD_LOCATION is invalid", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_LOCATION: "us-central1.attacker.example",
        },
      });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe("https://aiplatform.googleapis.com");
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
    }
  });

  it("uses the Vertex global endpoint when GOOGLE_CLOUD_LOCATION=global", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const adcDir = mkdtempSync(join(tmpdir(), "openclaw-adc-"));
    const credentialsPath = join(adcDir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_LOCATION: "global",
        },
      });
      expect(providers?.["anthropic-vertex"]?.baseUrl).toBe("https://aiplatform.googleapis.com");
    } finally {
      rmSync(adcDir, { recursive: true, force: true });
    }
  });

  it("accepts explicit metadata auth opt-in without local credential files", () => {
    const provider = resolveImplicitAnthropicVertexProvider({
      env: {
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        GOOGLE_CLOUD_LOCATION: "us-east5",
      },
    });
    expect(provider?.baseUrl).toBe("https://us-east5-aiplatform.googleapis.com");
  });

  it("merges the bundled catalog into explicit anthropic-vertex provider overrides", async () => {
    const provider = mergeImplicitAnthropicVertexProvider({
      existing: {
        baseUrl: "https://europe-west4-aiplatform.googleapis.com",
        headers: { "x-test-header": "1" },
      },
      implicit: buildAnthropicVertexProvider({
        env: {
          GOOGLE_CLOUD_LOCATION: "us-east5",
        },
      }),
    });

    expect(provider.baseUrl).toBe("https://europe-west4-aiplatform.googleapis.com");
    expect(provider.headers).toEqual({ "x-test-header": "1" });
    expect(provider.models?.map((model) => model.id)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("does not accept generic Kubernetes env without a GCP ADC signal", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: {
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
        GOOGLE_CLOUD_LOCATION: "us-east5",
      },
    });
    expect(providers?.["anthropic-vertex"]).toBeUndefined();
  });
});
