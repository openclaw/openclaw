import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasAnthropicVertexCredentials,
  resolveAnthropicVertexProjectId,
} from "./anthropic-vertex-provider.js";

describe("resolveAnthropicVertexProjectId", () => {
  it("returns project id from ANTHROPIC_VERTEX_PROJECT_ID env var", () => {
    const env = { ANTHROPIC_VERTEX_PROJECT_ID: "my-project" } as NodeJS.ProcessEnv;
    expect(resolveAnthropicVertexProjectId(env)).toBe("my-project");
  });

  it("returns project id from GOOGLE_CLOUD_PROJECT env var", () => {
    const env = { GOOGLE_CLOUD_PROJECT: "gcp-project" } as NodeJS.ProcessEnv;
    expect(resolveAnthropicVertexProjectId(env)).toBe("gcp-project");
  });

  it("returns project id from GOOGLE_CLOUD_PROJECT_ID env var", () => {
    const env = { GOOGLE_CLOUD_PROJECT_ID: "gcp-project-id" } as NodeJS.ProcessEnv;
    expect(resolveAnthropicVertexProjectId(env)).toBe("gcp-project-id");
  });

  it("returns undefined when no env vars or credentials file", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveAnthropicVertexProjectId(env)).toBeUndefined();
  });

  describe("ADC credentials file", () => {
    it("returns project_id from a valid ADC file", () => {
      const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
      const credPath = join(dir, "application_default_credentials.json");
      writeFileSync(credPath, JSON.stringify({ project_id: "adc-project" }), "utf8");
      const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
      try {
        expect(resolveAnthropicVertexProjectId(env)).toBe("adc-project");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns quota_project_id when project_id is absent", () => {
      const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
      const credPath = join(dir, "application_default_credentials.json");
      writeFileSync(credPath, JSON.stringify({ quota_project_id: "quota-project" }), "utf8");
      const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
      try {
        expect(resolveAnthropicVertexProjectId(env)).toBe("quota-project");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression test for issue #32245: ADC files with null or non-object content
    // caused "Cannot convert undefined or null to object" in the google-auth chain.
    it("returns undefined and does not crash when ADC file contains literal null (issue #32245)", () => {
      const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
      const credPath = join(dir, "application_default_credentials.json");
      writeFileSync(credPath, "null", "utf8");
      const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
      try {
        expect(() => resolveAnthropicVertexProjectId(env)).not.toThrow();
        expect(resolveAnthropicVertexProjectId(env)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns undefined and does not crash when ADC file contains a JSON array", () => {
      const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
      const credPath = join(dir, "application_default_credentials.json");
      writeFileSync(credPath, "[]", "utf8");
      const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
      try {
        expect(() => resolveAnthropicVertexProjectId(env)).not.toThrow();
        expect(resolveAnthropicVertexProjectId(env)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns undefined and does not crash when ADC file contains a JSON string", () => {
      const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
      const credPath = join(dir, "application_default_credentials.json");
      writeFileSync(credPath, '"just-a-string"', "utf8");
      const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
      try {
        expect(() => resolveAnthropicVertexProjectId(env)).not.toThrow();
        expect(resolveAnthropicVertexProjectId(env)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns undefined when the ADC file contains malformed JSON", () => {
      const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
      const credPath = join(dir, "application_default_credentials.json");
      writeFileSync(credPath, "{not valid json}", "utf8");
      const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
      try {
        expect(() => resolveAnthropicVertexProjectId(env)).not.toThrow();
        expect(resolveAnthropicVertexProjectId(env)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("hasAnthropicVertexCredentials", () => {
  it("returns false when no credentials are available", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(hasAnthropicVertexCredentials(env)).toBe(false);
  });

  it("returns true when ANTHROPIC_VERTEX_USE_GCP_METADATA is set to 1", () => {
    const env = { ANTHROPIC_VERTEX_USE_GCP_METADATA: "1" } as NodeJS.ProcessEnv;
    expect(hasAnthropicVertexCredentials(env)).toBe(true);
  });

  it("returns true when an ADC credentials file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "adc-test-"));
    const credPath = join(dir, "application_default_credentials.json");
    writeFileSync(credPath, JSON.stringify({ project_id: "p" }), "utf8");
    const env = { GOOGLE_APPLICATION_CREDENTIALS: credPath } as NodeJS.ProcessEnv;
    try {
      expect(hasAnthropicVertexCredentials(env)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
