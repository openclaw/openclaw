import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAdcTokenCache } from "./adc-credentials.js";
import { resolveGoogleVertexAuthHeaders } from "./vertex-adc-auth.js";

async function writeTempJson(content: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-vertex-auth-"));
  const file = path.join(dir, "adc.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return file;
}

describe("resolveGoogleVertexAuthHeaders", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAdcTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns fallback for non-marker apiKey", async () => {
    const result = await resolveGoogleVertexAuthHeaders("AIza-real-key", {});
    expect(result.kind).toBe("fallback");
  });

  it("returns fallback when GOOGLE_APPLICATION_CREDENTIALS is unset", async () => {
    const result = await resolveGoogleVertexAuthHeaders("gcp-vertex-credentials", {});
    expect(result.kind).toBe("fallback");
  });

  it("returns fallback for service_account ADC (preserves existing behavior)", async () => {
    const file = await writeTempJson({
      type: "service_account",
      project_id: "p",
      private_key: "k",
      client_email: "e",
    });
    const result = await resolveGoogleVertexAuthHeaders("gcp-vertex-credentials", {
      GOOGLE_APPLICATION_CREDENTIALS: file,
    });
    expect(result.kind).toBe("fallback");
  });

  it("mints a Bearer token for authorized_user ADC", async () => {
    const file = await writeTempJson({
      type: "authorized_user",
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt",
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), {
          status: 200,
        }),
    ) as typeof fetch;
    const result = await resolveGoogleVertexAuthHeaders("gcp-vertex-credentials", {
      GOOGLE_APPLICATION_CREDENTIALS: file,
    });
    expect(result.kind).toBe("bearer");
    if (result.kind === "bearer") {
      expect(result.headers.Authorization).toBe("Bearer AT");
    }
  });

  it("returns fallback when ADC parsing throws", async () => {
    const file = await writeTempJson({ type: "authorized_user", client_id: "cid" });
    const result = await resolveGoogleVertexAuthHeaders("gcp-vertex-credentials", {
      GOOGLE_APPLICATION_CREDENTIALS: file,
    });
    expect(result.kind).toBe("fallback");
  });
});
