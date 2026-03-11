import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVertexBaseUrl,
  hasGcpAdcCredentials,
  readAdcCredentials,
  resetVertexAuthCacheForTest,
  resolveAdcPath,
  resolveVertexProjectId,
  resolveVertexRegion,
} from "./anthropic-vertex-auth.js";

describe("resolveAdcPath", () => {
  it("returns GOOGLE_APPLICATION_CREDENTIALS when set", () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: "/custom/creds.json" };
    expect(resolveAdcPath(env)).toBe("/custom/creds.json");
  });

  it("returns default gcloud path when env var not set", () => {
    const expected = path.join(
      os.homedir(),
      ".config",
      "gcloud",
      "application_default_credentials.json",
    );
    expect(resolveAdcPath({})).toBe(expected);
  });

  it("trims whitespace from GOOGLE_APPLICATION_CREDENTIALS", () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS: "  /trimmed/path.json  " };
    expect(resolveAdcPath(env)).toBe("/trimmed/path.json");
  });
});

describe("readAdcCredentials", () => {
  it("parses valid credentials", () => {
    const creds = {
      client_id: "test-id",
      client_secret: "test-secret",
      refresh_token: "test-refresh",
      type: "authorized_user",
    };
    const tmpFile = path.join(os.tmpdir(), `test-adc-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(creds));
    try {
      const result = readAdcCredentials(tmpFile);
      expect(result.client_id).toBe("test-id");
      expect(result.client_secret).toBe("test-secret");
      expect(result.refresh_token).toBe("test-refresh");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws when refresh_token is missing", () => {
    const creds = { client_id: "id", client_secret: "secret", type: "authorized_user" };
    const tmpFile = path.join(os.tmpdir(), `test-adc-no-rt-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(creds));
    try {
      expect(() => readAdcCredentials(tmpFile)).toThrow("refresh_token");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws when client_id is missing", () => {
    const creds = { client_secret: "secret", refresh_token: "rt", type: "authorized_user" };
    const tmpFile = path.join(os.tmpdir(), `test-adc-no-cid-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(creds));
    try {
      expect(() => readAdcCredentials(tmpFile)).toThrow("client_id");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws on non-existent file", () => {
    expect(() => readAdcCredentials("/nonexistent/file.json")).toThrow();
  });
});

describe("hasGcpAdcCredentials", () => {
  it("returns true when ADC file exists", () => {
    const tmpFile = path.join(os.tmpdir(), `test-adc-exists-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "{}");
    try {
      expect(hasGcpAdcCredentials({ GOOGLE_APPLICATION_CREDENTIALS: tmpFile })).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("returns false when ADC file does not exist", () => {
    expect(hasGcpAdcCredentials({ GOOGLE_APPLICATION_CREDENTIALS: "/no/such/file.json" })).toBe(
      false,
    );
  });
});

describe("resolveVertexProjectId", () => {
  it("prefers ANTHROPIC_VERTEX_PROJECT_ID", () => {
    const env = {
      ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
      GOOGLE_CLOUD_PROJECT: "gcp-project",
    };
    expect(resolveVertexProjectId(env)).toBe("vertex-project");
  });

  it("falls back to GOOGLE_CLOUD_PROJECT", () => {
    const env = { GOOGLE_CLOUD_PROJECT: "gcp-project" };
    expect(resolveVertexProjectId(env)).toBe("gcp-project");
  });

  it("falls back to GCLOUD_PROJECT", () => {
    const env = { GCLOUD_PROJECT: "gcloud-project" };
    expect(resolveVertexProjectId(env)).toBe("gcloud-project");
  });

  it("returns undefined when no project env is set", () => {
    expect(resolveVertexProjectId({})).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(resolveVertexProjectId({ GOOGLE_CLOUD_PROJECT: "  proj  " })).toBe("proj");
  });

  it("returns undefined for whitespace-only values", () => {
    expect(resolveVertexProjectId({ GOOGLE_CLOUD_PROJECT: "   " })).toBeUndefined();
  });
});

describe("resolveVertexRegion", () => {
  it("prefers CLOUD_ML_REGION", () => {
    const env = { CLOUD_ML_REGION: "europe-west1", GOOGLE_CLOUD_LOCATION: "us-central1" };
    expect(resolveVertexRegion(env)).toBe("europe-west1");
  });

  it("falls back to GOOGLE_CLOUD_LOCATION", () => {
    const env = { GOOGLE_CLOUD_LOCATION: "us-central1" };
    expect(resolveVertexRegion(env)).toBe("us-central1");
  });

  it("defaults to us-east5", () => {
    expect(resolveVertexRegion({})).toBe("us-east5");
  });
});

describe("buildVertexBaseUrl", () => {
  it("constructs correct Vertex AI endpoint URL with trailing #", () => {
    const url = buildVertexBaseUrl({
      project: "my-project",
      region: "us-east5",
      model: "claude-sonnet-4-6@20250514",
    });
    expect(url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6@20250514:streamRawPredict#",
    );
  });

  it("trailing # absorbs appended /v1/messages in URL fragment", () => {
    const baseUrl = buildVertexBaseUrl({
      project: "proj",
      region: "us-east5",
      model: "claude-opus-4-6@20250514",
    });
    // Simulate what the Anthropic SDK does: baseUrl + "/v1/messages"
    const sdkUrl = new URL(baseUrl + "/v1/messages");
    // Fragment should contain /v1/messages, actual request URL should not
    expect(sdkUrl.hash).toBe("#/v1/messages");
    expect(sdkUrl.pathname).toBe(
      "/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-opus-4-6@20250514:streamRawPredict",
    );
  });

  it("works with different regions", () => {
    const url = buildVertexBaseUrl({
      project: "test",
      region: "europe-west4",
      model: "claude-haiku-4-5@20251001",
    });
    expect(url).toContain("europe-west4-aiplatform.googleapis.com");
    expect(url).toContain("locations/europe-west4");
  });
});

describe("resetVertexAuthCacheForTest", () => {
  afterEach(() => {
    resetVertexAuthCacheForTest();
  });

  it("resets without error", () => {
    expect(() => resetVertexAuthCacheForTest()).not.toThrow();
  });
});
