import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ProcessRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMuseNativeAuth } from "./native-auth.js";

const processMocks = vi.hoisted(() => ({ run: vi.fn() }));
// Mock only the native credential metadata command; file discovery stays real and isolated.
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessRuntime>()),
  runUtf8CommandWithTimeout: processMocks.run,
}));

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-muse-native-auth-"));
  await fs.mkdir(path.join(root, "muse"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("TBH_CREDENTIAL_BACKEND", undefined);
  processMocks.run.mockReset();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Muse native credentials", () => {
  it.each([
    { credential: { api_key: "synthetic-native-key" }, mode: "api-key" },
    {
      credential: { mechanism: "oauth", access_token: "synthetic-device-token" },
      mode: "oauth",
    },
  ])("reports $mode presence without exposing the credential", async ({ credential, mode }) => {
    await fs.writeFile(
      path.join(root, "muse", "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: credential } }),
    );
    const result = await probeMuseNativeAuth({
      env: { XDG_CONFIG_HOME: root, TBH_CREDENTIAL_BACKEND: "file" },
    });
    expect(result).toEqual({
      apiKey: "muse-native",
      source: "Muse native login",
      mode,
      nativeAuth: { runtime: "muse", mode },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-");
    expect(processMocks.run).not.toHaveBeenCalled();
  });

  it.each([
    "not-json",
    JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "oauth" } } }),
    JSON.stringify({ schema_version: 1, providers: { other: { api_key: "synthetic-other" } } }),
    JSON.stringify({ schema_version: 1, providers: { meta: { api_key: " " } } }),
  ])(
    "does not grant native auth for incomplete or unrelated file credentials",
    async (document) => {
      await fs.writeFile(path.join(root, "muse", "auth.json"), document);
      expect(
        await probeMuseNativeAuth({
          env: { XDG_CONFIG_HOME: root, TBH_CREDENTIAL_BACKEND: "file" },
        }),
      ).toBeUndefined();
      expect(processMocks.run).not.toHaveBeenCalled();
    },
  );

  it("prefers managed credentials and returns to the native home only when the managed file is absent", async () => {
    const stateRoot = path.join(root, "state");
    const managedAuth = path.join(stateRoot, "muse", "muse", "auth.json");
    await fs.mkdir(path.dirname(managedAuth), { recursive: true });
    await fs.writeFile(
      managedAuth,
      JSON.stringify({
        schema_version: 1,
        providers: { meta: { access_token: "synthetic-managed" } },
      }),
    );
    await fs.writeFile(
      path.join(root, "muse", "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "synthetic-native" } } }),
    );
    const env = { OPENCLAW_STATE_DIR: stateRoot, XDG_CONFIG_HOME: root };
    expect(await probeMuseNativeAuth({ env })).toMatchObject({
      nativeAuth: { runtime: "muse", mode: "oauth" },
    });
    await fs.rm(managedAuth);
    expect(await probeMuseNativeAuth({ env })).toMatchObject({
      nativeAuth: { runtime: "muse", mode: "api-key" },
    });
    expect(processMocks.run).not.toHaveBeenCalled();
  });

  it.each([
    "not-json",
    JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "oauth" } } }),
  ])("does not fall back from unusable managed credentials", async (document) => {
    const managedAuth = path.join(root, "state", "muse", "muse", "auth.json");
    await fs.mkdir(path.dirname(managedAuth), { recursive: true });
    await fs.writeFile(managedAuth, document);
    await fs.writeFile(
      path.join(root, "muse", "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "synthetic-native" } } }),
    );
    processMocks.run.mockResolvedValue({ termination: "exit", code: 0 });
    expect(await probeMuseNativeAuth({ env: { XDG_CONFIG_HOME: root } })).toBeUndefined();
    expect(processMocks.run).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin")(
    "checks keychain metadata without requesting a password",
    async () => {
      processMocks.run.mockResolvedValue({ termination: "exit", code: 0 });
      expect(await probeMuseNativeAuth({ env: { XDG_CONFIG_HOME: root } })).toMatchObject({
        nativeAuth: { runtime: "muse", mode: "oauth" },
      });
      expect(processMocks.run).toHaveBeenCalledWith(
        [
          "/usr/bin/security",
          "find-generic-password",
          "-s",
          "ai.meta.dev.credentials",
          "-a",
          "meta",
        ],
        expect.objectContaining({ timeoutMs: 3_000 }),
      );
      processMocks.run.mockResolvedValue({ termination: "exit", code: 44 });
      expect(await probeMuseNativeAuth({ env: { XDG_CONFIG_HOME: root } })).toBeUndefined();
    },
  );

  it("preserves cancellation rather than treating an obsolete probe as logged out", async () => {
    const owner = new AbortController();
    owner.abort(new Error("discovery retired"));
    await expect(probeMuseNativeAuth({ signal: owner.signal })).rejects.toThrow(
      "discovery retired",
    );
  });
});
