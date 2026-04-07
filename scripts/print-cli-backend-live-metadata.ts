import { resolveCliBackendConfig, resolveCliBackendLiveTest } from "../src/agents/cli-backends.js";

const provider = process.argv[2]?.trim().toLowerCase();

if (!provider) {
  console.error("usage: node scripts/print-cli-backend-live-metadata.ts <provider>");
  process.exit(1);
}

async function loadFallbackBackend(id: string) {
  switch (id) {
    case "claude-cli": {
      const mod = await import("../extensions/anthropic/cli-backend.ts");
      return mod.buildAnthropicCliBackend();
    }
    case "codex-cli": {
      const mod = await import("../extensions/openai/cli-backend.ts");
      return mod.buildOpenAICodexCliBackend();
    }
    case "google-gemini-cli": {
      const mod = await import("../extensions/google/cli-backend.ts");
      return mod.buildGoogleGeminiCliBackend();
    }
    default:
      return null;
  }
}

const resolved = resolveCliBackendConfig(provider);
const liveTest = resolveCliBackendLiveTest(provider);
const fallbackBackend =
  !resolved || !liveTest?.defaultModelRef ? await loadFallbackBackend(provider) : null;
const backendConfig = resolved?.config ?? fallbackBackend?.config;
const backendLiveTest =
  liveTest ??
  (fallbackBackend
    ? {
        defaultModelRef: fallbackBackend.liveTest?.defaultModelRef,
        defaultImageProbe: fallbackBackend.liveTest?.defaultImageProbe === true,
        dockerNpmPackage: fallbackBackend.liveTest?.docker?.npmPackage,
        dockerBinaryName: fallbackBackend.liveTest?.docker?.binaryName,
      }
    : null);

process.stdout.write(
  JSON.stringify(
    {
      provider,
      command: backendConfig?.command,
      args: backendConfig?.args,
      clearEnv: backendConfig?.clearEnv ?? [],
      imageArg: backendConfig?.imageArg,
      imageMode: backendConfig?.imageMode,
      systemPromptWhen: backendConfig?.systemPromptWhen ?? "never",
      bundleMcp: resolved?.bundleMcp === true || fallbackBackend?.bundleMcp === true,
      defaultModelRef: backendLiveTest?.defaultModelRef,
      defaultImageProbe: backendLiveTest?.defaultImageProbe === true,
      dockerNpmPackage: backendLiveTest?.dockerNpmPackage,
      dockerBinaryName: backendLiveTest?.dockerBinaryName,
    },
    null,
    2,
  ),
);
