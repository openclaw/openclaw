import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: readFileSyncMock,
    default: { ...actual, readFileSync: readFileSyncMock },
  };
});

import { clearGoogleVertexAdcTokenCache, resolveGoogleVertexAdcToken } from "./vertex-adc.js";

const ADC_PATH = "/tmp/openclaw-vertex-adc.json";

const baseEnv = {
  GOOGLE_APPLICATION_CREDENTIALS: ADC_PATH,
} as NodeJS.ProcessEnv;

const fetchSpy = vi.fn();

beforeEach(() => {
  clearGoogleVertexAdcTokenCache();
  readFileSyncMock.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveGoogleVertexAdcToken", () => {
  it("returns null when ADC file is missing", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    await expect(resolveGoogleVertexAdcToken(baseEnv)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes authorized_user credentials and resolves project_id", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        type: "authorized_user",
        client_id: "id",
        client_secret: "secret",
        refresh_token: "refresh",
        project_id: "user-project",
        quota_project_id: "billing-project",
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "user-token", expires_in: 3600 }), {
        status: 200,
      }),
    );

    const token = await resolveGoogleVertexAdcToken(baseEnv);
    expect(token).not.toBeNull();
    expect(token?.accessToken).toBe("user-token");
    // project_id wins over quota_project_id (codex P2)
    expect(token?.projectId).toBe("user-project");
    expect(token?.expiresAt).toBeGreaterThan(Date.now());

    const init = fetchSpy.mock.calls[0]?.[1] as { body: URLSearchParams } | undefined;
    expect(init?.body.get("grant_type")).toBe("refresh_token");
    expect(init?.body.get("refresh_token")).toBe("refresh");
  });

  it("mints a service_account JWT bearer token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        type: "service_account",
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: pem,
        project_id: "svc-project",
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "svc-token", expires_in: 3600 }), {
        status: 200,
      }),
    );

    const token = await resolveGoogleVertexAdcToken(baseEnv);
    expect(token?.accessToken).toBe("svc-token");
    expect(token?.projectId).toBe("svc-project");

    const init = fetchSpy.mock.calls[0]?.[1] as { body: URLSearchParams } | undefined;
    expect(init?.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = init?.body.get("assertion");
    expect(assertion).toBeTruthy();
    expect(assertion?.split(".")).toHaveLength(3);
  });

  it("throws a clear error for unsupported ADC types", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        type: "external_account",
        audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/x",
      }),
    );

    await expect(resolveGoogleVertexAdcToken(baseEnv)).rejects.toThrow(
      /unsupported ADC type "external_account"/,
    );
    await expect(resolveGoogleVertexAdcToken(baseEnv)).rejects.toThrow(
      /gcloud auth application-default login/,
    );
  });

  it("surfaces token endpoint errors instead of returning null", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        type: "authorized_user",
        client_id: "id",
        client_secret: "secret",
        refresh_token: "refresh",
      }),
    );
    fetchSpy.mockResolvedValue(new Response("invalid_grant", { status: 400 }));

    await expect(resolveGoogleVertexAdcToken(baseEnv)).rejects.toThrow(
      /Google ADC token refresh failed \(400\)/,
    );
  });

  it("reuses the cached token within its TTL", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        type: "authorized_user",
        client_id: "id",
        client_secret: "secret",
        refresh_token: "refresh",
        project_id: "user-project",
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "user-token", expires_in: 3600 }), {
        status: 200,
      }),
    );

    await resolveGoogleVertexAdcToken(baseEnv);
    await resolveGoogleVertexAdcToken(baseEnv);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("prefers env GOOGLE_CLOUD_PROJECT over the ADC project_id", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        type: "authorized_user",
        client_id: "id",
        client_secret: "secret",
        refresh_token: "refresh",
        project_id: "adc-project",
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }),
    );

    const token = await resolveGoogleVertexAdcToken({
      ...baseEnv,
      GOOGLE_CLOUD_PROJECT: "env-project",
    });
    expect(token?.projectId).toBe("env-project");
  });
});
