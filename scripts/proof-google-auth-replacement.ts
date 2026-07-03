import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { buildGoogleGeminiCliBackend } from "../extensions/google/cli-backend.js";
import { resolveGeminiCliProfileHome } from "../extensions/google/gemini-cli-auth-home.js";
import { buildGoogleGeminiCliProvider } from "../extensions/google/gemini-cli-provider.js";
import { importOfficialGeminiCliOAuthCredentials } from "../extensions/google/oauth.official-cache.js";
import { buildGoogleProvider } from "../extensions/google/provider-registration.js";
import { saveAuthProfileStore } from "../src/agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";
import { prepareCliRunContext } from "../src/agents/cli-runner/prepare.js";
import {
  hasProviderCliBackendAuthCredentialResolver,
  resolveProviderCliBackendAuthCredential,
} from "../src/plugins/provider-runtime.runtime.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../src/plugins/runtime.js";

const secretSentinels = {
  apiKey: "AIza-REAL-BEHAVIOR-PROOF-API-KEY-DO-NOT-LEAK",
  accessToken: "ya29.REAL-BEHAVIOR-PROOF-ACCESS-DO-NOT-LEAK",
  refreshToken: "1//REAL-BEHAVIOR-PROOF-REFRESH-DO-NOT-LEAK",
};

function redact(value: string): string {
  return Object.values(secretSentinels).reduce(
    (text, secret) => text.split(secret).join("[REDACTED]"),
    value,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function createSessionFile(stateDir: string): Promise<string> {
  const sessionFile = path.join(stateDir, "agents", "main", "sessions", "session-test.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "session-test",
      timestamp: new Date(0).toISOString(),
      cwd: stateDir,
    })}\n`,
    "utf-8",
  );
  return sessionFile;
}

function installGoogleProofRegistry(stateDir: string) {
  const registry = createEmptyPluginRegistry();
  const geminiCliBackend = buildGoogleGeminiCliBackend();
  registry.providers.push(
    {
      pluginId: "google",
      provider: buildGoogleProvider(),
      source: "proof-google-auth-replacement",
    },
    {
      pluginId: "google",
      provider: buildGoogleGeminiCliProvider(),
      source: "proof-google-auth-replacement",
    },
  );
  registry.cliBackends.push({
    pluginId: "google",
    backend: {
      ...geminiCliBackend,
      bundleMcp: false,
    },
    source: "proof-google-auth-replacement",
  });
  setActivePluginRegistry(registry, "proof-google-auth-replacement", "default", stateDir);
}

async function main() {
  const previousRegistry = getActivePluginRegistry();
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousGeminiCliHome = process.env.GEMINI_CLI_HOME;
  const previousGoogleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;
  const previousGoogleCloudProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-auth-proof-"));
  const officialGeminiHome = path.join(stateDir, "official-gemini-home");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const sessionFile = await createSessionFile(stateDir);
  const googleProfileId = "google:proof-api-key";
  const oauthProfileId = "google-gemini-cli:proof-oauth@example.test";
  const store: AuthProfileStore = {
    version: 1,
    order: {
      google: [googleProfileId],
      "google-gemini-cli": [oauthProfileId],
    },
    profiles: {
      [googleProfileId]: {
        type: "api_key",
        provider: "google",
        key: secretSentinels.apiKey,
      },
      [oauthProfileId]: {
        type: "oauth",
        provider: "google-gemini-cli",
        access: secretSentinels.accessToken,
        refresh: secretSentinels.refreshToken,
        expires: Date.now() + 3_600_000,
        projectId: "proof-project",
      },
    },
  };

  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.GEMINI_CLI_HOME = officialGeminiHome;
    process.env.GOOGLE_CLOUD_PROJECT = "proof-project";
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    await fs.mkdir(path.join(officialGeminiHome, ".gemini"), { recursive: true });
    await fs.writeFile(
      path.join(officialGeminiHome, ".gemini", "oauth_creds.json"),
      JSON.stringify(
        {
          access_token: secretSentinels.accessToken,
          refresh_token: secretSentinels.refreshToken,
          expiry_date: Date.now() + 3_600_000,
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(officialGeminiHome, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: "proof-oauth@example.test", old: [] }, null, 2),
      "utf8",
    );

    const importedOfficialGeminiCliCache = importOfficialGeminiCliOAuthCredentials();
    if (
      importedOfficialGeminiCliCache?.access !== secretSentinels.accessToken ||
      importedOfficialGeminiCliCache.refresh !== secretSentinels.refreshToken
    ) {
      throw new Error("official Gemini CLI OAuth cache import did not resolve expected tokens");
    }

    const providerForSetupProof = buildGoogleGeminiCliProvider();
    const authMethodForSetupProof = providerForSetupProof.auth?.find((auth) => auth.id === "oauth");
    if (!authMethodForSetupProof) {
      throw new Error("google-gemini-cli provider did not expose OAuth setup method");
    }
    const providerSetupAuthResult = await authMethodForSetupProof.run({
      config: {},
      env: process.env,
      agentDir,
      workspaceDir: stateDir,
      isRemote: false,
      openUrl: async () => {
        throw new Error("provider setup unexpectedly opened an OpenClaw-owned OAuth URL");
      },
      runtime: {
        log: () => {
          throw new Error("provider setup unexpectedly logged an OpenClaw-owned OAuth URL");
        },
      },
      prompter: {
        note: async () => {},
        confirm: async () => true,
        progress: () => ({
          update: () => {},
          stop: () => {},
        }),
        text: async () => {
          throw new Error(
            "provider setup unexpectedly prompted for an OpenClaw OAuth callback URL",
          );
        },
      },
    } as Parameters<typeof authMethodForSetupProof.run>[0]);
    const providerSetupCredential = providerSetupAuthResult.profiles[0]?.credential;
    if (
      providerSetupCredential?.type !== "oauth" ||
      providerSetupCredential.provider !== "google-gemini-cli" ||
      providerSetupCredential.access !== secretSentinels.accessToken ||
      providerSetupCredential.refresh !== secretSentinels.refreshToken
    ) {
      throw new Error("google-gemini-cli provider setup did not import official OAuth cache");
    }

    installGoogleProofRegistry(stateDir);
    await fs.mkdir(agentDir, { recursive: true });
    saveAuthProfileStore(store, agentDir);

    const registeredGeminiCliProviderHook = await hasProviderCliBackendAuthCredentialResolver({
      provider: "google-gemini-cli",
      workspaceDir: stateDir,
      config: {},
    });
    const registeredGoogleApiProviderHook = await hasProviderCliBackendAuthCredentialResolver({
      provider: "google",
      workspaceDir: stateDir,
      config: {},
    });
    const hookCredential = await resolveProviderCliBackendAuthCredential({
      provider: "google-gemini-cli",
      workspaceDir: stateDir,
      config: {},
      context: {
        config: {},
        agentDir,
        workspaceDir: stateDir,
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        profileId: oauthProfileId,
        credential: store.profiles[oauthProfileId]!,
        store,
      },
    });
    if (!registeredGeminiCliProviderHook || hookCredential?.kind !== "oauth") {
      throw new Error("registered google-gemini-cli provider hook did not resolve OAuth material");
    }
    if (registeredGoogleApiProviderHook) {
      throw new Error("google API-key provider unexpectedly registered a CLI backend auth hook");
    }

    const oauthContext = await prepareCliRunContext({
      sessionId: "session-test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir: stateDir,
      prompt: "proof prompt",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 1_000,
      runId: "proof-google-gemini-cli-oauth",
      authProfileId: oauthProfileId,
      config: {},
    });
    const oauthPrepared = oauthContext.preparedBackend;
    const oauthGeminiHome = oauthPrepared.env?.GEMINI_CLI_HOME;
    if (!oauthGeminiHome) {
      throw new Error("Gemini CLI OAuth preparation did not produce an isolated auth home");
    }
    await oauthPrepared.beforeExecution?.();
    const oauthCredsPath = path.join(oauthGeminiHome, ".gemini", "oauth_creds.json");
    const oauthCredsRaw = await fs.readFile(oauthCredsPath, "utf8");

    const apiKeyContext = await prepareCliRunContext({
      sessionId: "session-test",
      sessionKey: "agent:main:main",
      sessionFile,
      workspaceDir: stateDir,
      prompt: "proof prompt",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 1_000,
      runId: "proof-google-gemini-cli-api-key",
      authProfileId: googleProfileId,
      config: {},
    });
    const apiKeyPrepared = apiKeyContext.preparedBackend;
    const apiKeyGeminiHome = apiKeyPrepared.env?.GEMINI_CLI_HOME;
    if (!apiKeyGeminiHome || apiKeyPrepared.env?.GEMINI_API_KEY !== secretSentinels.apiKey) {
      throw new Error("Gemini CLI API-key preparation did not stage GEMINI_API_KEY");
    }
    await apiKeyPrepared.beforeExecution?.();
    const apiKeyOauthCredsPath = path.join(apiKeyGeminiHome, ".gemini", "oauth_creds.json");
    const apiKeyCachedCredentialsPath = path.join(
      apiKeyGeminiHome,
      ".gemini",
      "gemini-credentials.json",
    );
    const expectedProfileHash = crypto
      .createHash("sha256")
      .update(oauthProfileId)
      .digest("hex")
      .slice(0, 24);
    const expectedHome = resolveGeminiCliProfileHome(agentDir, oauthProfileId);

    const proof = {
      registeredGeminiCliProviderHook,
      googleApiKeyProviderUsesGenericFallback: !registeredGoogleApiProviderHook,
      cliRunnerForwardedOauthViaRegisteredProviderHook:
        oauthContext.effectiveAuthProfileId === oauthProfileId &&
        oauthContext.preparedBackend.env?.GEMINI_CLI_HOME === expectedHome,
      cliRunnerForwardedApiKeyViaGenericFallback:
        apiKeyContext.effectiveAuthProfileId === googleProfileId &&
        apiKeyPrepared.env?.GEMINI_API_KEY === secretSentinels.apiKey,
      apiKeyProfileSelectedForGoogle: apiKeyContext.effectiveAuthProfileId === googleProfileId,
      oauthProfileSelectedForGeminiCli: oauthContext.effectiveAuthProfileId === oauthProfileId,
      geminiCliOfficialOAuthCacheImported:
        importedOfficialGeminiCliCache.access === secretSentinels.accessToken &&
        importedOfficialGeminiCliCache.refresh === secretSentinels.refreshToken,
      geminiCliOfficialOAuthAccountImported:
        importedOfficialGeminiCliCache.email === "proof-oauth@example.test",
      geminiCliOfficialOAuthProjectImported:
        importedOfficialGeminiCliCache.projectId === "proof-project",
      geminiCliProviderSetupImportsOfficialCache:
        providerSetupCredential.access === secretSentinels.accessToken &&
        providerSetupCredential.refresh === secretSentinels.refreshToken,
      geminiCliProviderSetupDoesNotUseOpenClawOAuth: true,
      geminiCliUsesIsolatedAuthHome: oauthGeminiHome === expectedHome,
      inheritedGoogleAuthEnvCleared: [
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_ACCESS_TOKEN",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
      ].every((name) => oauthPrepared.backend.clearEnv?.includes(name)),
      apiKeyNotWrittenIntoGeminiCliOAuthFiles: !oauthCredsRaw.includes(secretSentinels.apiKey),
      apiKeyProfileStagesGeminiApiKey: apiKeyPrepared.env.GEMINI_API_KEY === secretSentinels.apiKey,
      apiKeyProfileDoesNotLeaveOauthFiles:
        !(await pathExists(apiKeyOauthCredsPath)) &&
        !(await pathExists(apiKeyCachedCredentialsPath)),
      oauthTokenValuesRedactedFromProofOutput: true,
      profileIdHashUsedInHome: oauthGeminiHome.includes(expectedProfileHash),
      rawProfileIdAbsentFromHome: !oauthGeminiHome.includes(oauthProfileId),
      selectedCredentialKinds: {
        "google-gemini-cli": hookCredential.kind,
        google: "api_key",
      },
      redactedCredentialFilePreview: redact(oauthCredsRaw),
    };

    const rendered = JSON.stringify(proof, null, 2);
    const leaked = Object.values(secretSentinels).filter((secret) => rendered.includes(secret));
    if (leaked.length > 0) {
      throw new Error("proof output leaked raw credential material");
    }
    console.log(rendered);
    await oauthPrepared.cleanup?.();
    await apiKeyPrepared.cleanup?.();
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousGeminiCliHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousGeminiCliHome;
    }
    if (previousGoogleCloudProject === undefined) {
      delete process.env.GOOGLE_CLOUD_PROJECT;
    } else {
      process.env.GOOGLE_CLOUD_PROJECT = previousGoogleCloudProject;
    }
    if (previousGoogleCloudProjectId === undefined) {
      delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    } else {
      process.env.GOOGLE_CLOUD_PROJECT_ID = previousGoogleCloudProjectId;
    }
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
