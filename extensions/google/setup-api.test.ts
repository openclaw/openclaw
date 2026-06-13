import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import setupEntry from "./setup-api.js";

type GeminiPrepareContext = Parameters<
  NonNullable<ReturnType<typeof buildGoogleGeminiCliBackend>["prepareExecution"]>
>[0] & {
  authCredential: {
    type: "oauth";
    provider: "google-gemini-cli";
    access: string;
    refresh: string;
    expires: number;
    idToken?: string;
    email: string;
  };
};

function buildGeminiPrepareContext(workspaceDir: string): GeminiPrepareContext {
  return {
    workspaceDir,
    provider: "google-gemini-cli",
    modelId: "gemini-3.1-pro-preview",
    authProfileId: "google-gemini-cli:user@example.test",
    // Private bundled-runtime bridge, not public Plugin SDK surface.
    authCredential: {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_800_000_000_000,
      idToken: "id-token",
      email: "user@example.test",
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider: ProviderPlugin) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend: CliBackendPlugin) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    expect(providerIds).toEqual(["google-vertex"]);
    expect(cliBackendIds).toEqual(["google-gemini-cli"]);
  });
});

describe("google gemini cli backend auth bridge", () => {
  it("materializes selected OpenClaw OAuth credentials into an isolated Gemini CLI home", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    let prepared:
      | Awaited<ReturnType<NonNullable<typeof backend.prepareExecution>>>
      | null
      | undefined;
    let home: string | undefined;

    try {
      prepared = await backend.prepareExecution?.(buildGeminiPrepareContext(workspaceDir));

      home = prepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();

      const raw = await fs.readFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        expiry_date: 1_800_000_000_000,
        token_type: "Bearer",
      });
    } finally {
      await prepared?.cleanup?.();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }

    await expect(fs.access(home ?? "")).rejects.toThrow();
  });

  it("clears inherited Gemini GCA credentials when staging selected OAuth credentials", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    const originalUseGca = process.env.GOOGLE_GENAI_USE_GCA;
    const originalCloudAccessToken = process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
    const originalForceEncryptedFileStorage = process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
    let prepared:
      | Awaited<ReturnType<NonNullable<typeof backend.prepareExecution>>>
      | null
      | undefined;

    process.env.GOOGLE_GENAI_USE_GCA = "true";
    process.env.GOOGLE_CLOUD_ACCESS_TOKEN = "ambient-cloud-token";
    process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = "true";

    try {
      prepared = await backend.prepareExecution?.(buildGeminiPrepareContext(workspaceDir));

      expect(prepared?.env?.GEMINI_CLI_HOME).toBeTruthy();
      expect(prepared?.clearEnv).toEqual([
        "GOOGLE_GENAI_USE_GCA",
        "GOOGLE_CLOUD_ACCESS_TOKEN",
        "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
      ]);
    } finally {
      restoreEnv("GOOGLE_GENAI_USE_GCA", originalUseGca);
      restoreEnv("GOOGLE_CLOUD_ACCESS_TOKEN", originalCloudAccessToken);
      restoreEnv("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", originalForceEncryptedFileStorage);
      await prepared?.cleanup?.();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses profile-only auth epochs for the private Gemini CLI bridge", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.authEpochMode).toBe("profile-only");
    expect(backend.prepareExecution).toBeTypeOf("function");
  });
});
