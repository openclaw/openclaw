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
    type: "api_key" | "oauth";
    provider: string;
    access?: string;
    refresh?: string;
    expires?: number;
    idToken?: string;
    key?: string;
    email?: string;
  };
};

function buildGeminiOAuthPrepareContext(workspaceDir: string): GeminiPrepareContext {
  const agentDir = path.join(workspaceDir, "agent");
  return {
    workspaceDir,
    agentDir,
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

function buildGeminiApiKeyPrepareContext(workspaceDir: string): GeminiPrepareContext {
  const agentDir = path.join(workspaceDir, "agent");
  return {
    workspaceDir,
    agentDir,
    provider: "google-gemini-cli",
    modelId: "gemini-3.1-flash-lite",
    authProfileId: "google-gemini-cli:api-key",
    // Private bundled-runtime bridge, not public Plugin SDK surface.
    authCredential: {
      type: "api_key",
      provider: "google-gemini-cli",
      key: "gemini-api-key",
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
  it("materializes selected OpenClaw OAuth credentials into a persistent profile-scoped Gemini CLI home", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    let home: string | undefined;

    try {
      const context = buildGeminiOAuthPrepareContext(workspaceDir);
      const prepared = await backend.prepareExecution?.(context);

      home = prepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();
      expect(prepared?.env?.GEMINI_FORCE_FILE_STORAGE).toBe("true");
      expect(home).toContain(path.join(context.agentDir, "cli-runtimes", "google-gemini-cli"));
      expect(home).not.toContain("user@example.test");

      const raw = await fs.readFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        expiry_date: 1_800_000_000_000,
        token_type: "Bearer",
      });
      const nestedSettingsRaw = await fs.readFile(
        path.join(home ?? "", ".gemini", "settings.json"),
        "utf8",
      );
      const rootSettingsRaw = await fs.readFile(path.join(home ?? "", "settings.json"), "utf8");
      expect(JSON.parse(nestedSettingsRaw)).toEqual({
        security: { auth: { selectedType: "oauth-personal" } },
      });
      expect(JSON.parse(rootSettingsRaw)).toEqual(JSON.parse(nestedSettingsRaw));

      const sessionMarker = path.join(home ?? "", ".gemini", "session-state.json");
      await fs.writeFile(sessionMarker, '{"keep":true}\n', "utf8");
      const cachedCredentialsPath = path.join(home ?? "", ".gemini", "gemini-credentials.json");
      await fs.writeFile(cachedCredentialsPath, "stale-cache", "utf8");

      const preparedAgain = await backend.prepareExecution?.(context);
      expect(preparedAgain?.env?.GEMINI_CLI_HOME).toBe(home);
      await expect(fs.access(sessionMarker)).resolves.toBeUndefined();
      await expect(fs.access(cachedCredentialsPath)).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prepares selected Gemini API-key credentials and removes stale OAuth state for that profile home", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    let home: string | undefined;

    try {
      const context = buildGeminiApiKeyPrepareContext(workspaceDir);
      const firstPrepared = await backend.prepareExecution?.(context);
      home = firstPrepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();
      await fs.writeFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "{}\n", "utf8");
      await fs.writeFile(
        path.join(home ?? "", ".gemini", "gemini-credentials.json"),
        "stale-cache",
        "utf8",
      );

      const prepared = await backend.prepareExecution?.(context);

      home = prepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();
      expect(prepared?.env?.GEMINI_API_KEY).toBe("gemini-api-key");
      expect(prepared?.env?.GEMINI_FORCE_FILE_STORAGE).toBe("true");
      expect(prepared?.clearEnv).toContain("GEMINI_API_KEY");
      expect(prepared?.clearEnv).toContain("GOOGLE_GENAI_USE_GCA");
      expect(prepared?.clearEnv).toContain("GOOGLE_GENAI_USE_VERTEXAI");
      expect(prepared?.clearEnv).toContain("GOOGLE_GEMINI_BASE_URL");

      const settingsRaw = await fs.readFile(
        path.join(home ?? "", ".gemini", "settings.json"),
        "utf8",
      );
      expect(JSON.parse(settingsRaw)).toEqual({
        security: { auth: { selectedType: "gemini-api-key" } },
      });
      await expect(
        fs.access(path.join(home ?? "", ".gemini", "oauth_creds.json")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(home ?? "", ".gemini", "gemini-credentials.json")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects Vercel AI Gateway profiles for the Gemini CLI backend", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      await expect(
        backend.prepareExecution?.({
          workspaceDir,
          agentDir: path.join(workspaceDir, "agent"),
          provider: "google-gemini-cli",
          modelId: "gemini-3.1-flash-lite",
          authProfileId: "vercel-ai-gateway:default",
          authCredential: {
            type: "api_key",
            provider: "vercel-ai-gateway",
            key: "vercel-key",
          },
        } as never),
      ).rejects.toThrow(/vercel-ai-gateway auth profile/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("clears inherited Gemini auth credentials when staging selected OAuth credentials", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    const originalUseGca = process.env.GOOGLE_GENAI_USE_GCA;
    const originalCloudAccessToken = process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
    const originalForceEncryptedFileStorage = process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
    let prepared:
      | Awaited<ReturnType<NonNullable<typeof backend.prepareExecution>>>
      | null
      | undefined;

    process.env.GOOGLE_GENAI_USE_GCA = "true";
    process.env.GOOGLE_CLOUD_ACCESS_TOKEN = "ambient-cloud-token";
    process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = "true";
    process.env.GEMINI_API_KEY = "ambient-gemini-key";
    process.env.GOOGLE_API_KEY = "ambient-google-key";

    try {
      prepared = await backend.prepareExecution?.(buildGeminiOAuthPrepareContext(workspaceDir));

      expect(prepared?.env?.GEMINI_CLI_HOME).toBeTruthy();
      expect(prepared?.clearEnv).toEqual([
        "GOOGLE_GENAI_USE_GCA",
        "GOOGLE_CLOUD_ACCESS_TOKEN",
        "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
        "GEMINI_FORCE_FILE_STORAGE",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_GEMINI_BASE_URL",
        "GEMINI_CLI_CUSTOM_HEADERS",
        "GEMINI_API_KEY_AUTH_MECHANISM",
        "GEMINI_API_KEY",
      ]);
    } finally {
      restoreEnv("GOOGLE_GENAI_USE_GCA", originalUseGca);
      restoreEnv("GOOGLE_CLOUD_ACCESS_TOKEN", originalCloudAccessToken);
      restoreEnv("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", originalForceEncryptedFileStorage);
      restoreEnv("GEMINI_API_KEY", originalGeminiApiKey);
      restoreEnv("GOOGLE_API_KEY", originalGoogleApiKey);
      await prepared?.cleanup?.();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("requires an agent directory for profile-owned Gemini CLI state", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));

    try {
      const { agentDir: _agentDir, ...context } = buildGeminiOAuthPrepareContext(workspaceDir);
      await expect(backend.prepareExecution?.(context)).rejects.toThrow(/agent directory/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses profile-only auth epochs for the private Gemini CLI bridge", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.authEpochMode).toBe("profile-only");
    expect(backend.prepareExecution).toBeTypeOf("function");
  });
});
