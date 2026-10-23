import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetGoogleVertexAdcState } from "./google-oauth.test-support.js";
import { resolveGoogleVertexAuthorizedUserHeaders } from "./vertex-adc.js";

// Fails fast if the refresh settles before reaching its HTTP barrier.
function reachRefreshBarrier(entered: Promise<void>, refresh: Promise<unknown>): Promise<void> {
  return Promise.race([
    entered,
    refresh.then((): never => {
      throw new Error("refresh settled before HTTP barrier");
    }),
  ]);
}

let root: string;
let adcPath: string;
const initial = {
  type: "authorized_user",
  client_id: "synthetic-client",
  client_secret: "synthetic-secret",
  refresh_token: "synthetic-refresh",
};
const success = () =>
  Response.json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 });
function writeAdc(value = initial) {
  writeFileSync(adcPath, JSON.stringify(value));
}
beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetGoogleVertexAdcState();
  root = mkdtempSync(path.join(os.tmpdir(), "vertex-refresh-owner-"));
  adcPath = path.join(root, "adc.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", adcPath);
  vi.stubEnv("GOOGLE_CLOUD_QUOTA_PROJECT", "");
  writeAdc();
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetGoogleVertexAdcState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it("coalesces the real form/parser and distinguishes clients even with the same ADC path and refresh string", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const network = vi.fn<typeof fetch>(async (url, init) => {
    expect(resolveRequestUrl(url)).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const form = new URLSearchParams(await new Response(init?.body).text());
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(initial.refresh_token);
    if (network.mock.calls.length === 1) {
      expect(form.get("client_id")).toBe(initial.client_id);
      entered.resolve();
      await release.promise;
    } else {
      expect(form.get("client_id")).toBe("synthetic-other-client");
      expect(form.get("client_secret")).toBe("synthetic-other-secret");
    }
    return success();
  });
  const first = resolveGoogleVertexAuthorizedUserHeaders(network);
  try {
    await reachRefreshBarrier(entered.promise, first);
    const second = resolveGoogleVertexAuthorizedUserHeaders(network);
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([
      { Authorization: "Bearer synthetic-access" },
      { Authorization: "Bearer synthetic-access" },
    ]);
    expect(network).toHaveBeenCalledOnce();
    writeAdc({
      ...initial,
      client_id: "synthetic-other-client",
      client_secret: "synthetic-other-secret",
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(network)).resolves.toEqual({
      Authorization: "Bearer synthetic-access",
    });
    expect(network).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await Promise.allSettled([first]);
  }
});
it.each(["nested-rejection", "unexpected-rotation"])(
  "rejects %s without caching success or rewriting externally owned ADC",
  async (mode) => {
    const original = readFileSync(adcPath, "utf8");
    const network = vi.fn<typeof fetch>(async () => {
      if (mode === "nested-rejection") {
        return Response.json({
          access_token: "synthetic-access",
          error: { code: "invalid_grant" },
        });
      }
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-rotated",
        expires_in: 3600,
      });
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(network)).rejects.toThrow();
    resetGoogleVertexAdcState();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await expect(resolveGoogleVertexAuthorizedUserHeaders(network)).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
    expect(readFileSync(adcPath, "utf8")).toBe(original);
  },
);
it.each(["lost-response", "503"])(
  "reuses the documented reusable ADC grant after %s and a process cache reset",
  async (mode) => {
    const original = readFileSync(adcPath, "utf8");
    const network = vi.fn<typeof fetch>(async (_url, init) => {
      const form = new URLSearchParams(await new Response(init?.body).text());
      expect(form.get("refresh_token")).toBe(initial.refresh_token);
      if (network.mock.calls.length === 1) {
        if (mode === "lost-response") {
          throw new TypeError("synthetic response lost");
        }
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      }
      return success();
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(network)).rejects.toThrow();
    resetGoogleVertexAdcState();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await expect(resolveGoogleVertexAuthorizedUserHeaders(network)).resolves.toEqual({
      Authorization: "Bearer synthetic-access",
    });
    expect(network).toHaveBeenCalledTimes(2);
    expect(readFileSync(adcPath, "utf8")).toBe(original);
  },
);
it("never publishes or caches an exchange after its external ADC owner is replaced", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const network = vi.fn<typeof fetch>(async () => {
    entered.resolve();
    await release.promise;
    return success();
  });
  const first = resolveGoogleVertexAuthorizedUserHeaders(network);
  const outcome = first.catch((error: unknown) => error);
  try {
    await reachRefreshBarrier(entered.promise, first);
    writeAdc({ ...initial, refresh_token: "synthetic-new-login" });
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    await expect(resolveGoogleVertexAuthorizedUserHeaders(network)).resolves.toEqual({
      Authorization: "Bearer synthetic-access",
    });
    expect(network).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await outcome;
  }
});
