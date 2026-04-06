import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { resolveOpenClawAgentDir } from "../src/agents/agent-paths.ts";
import { upsertAuthProfile } from "../src/agents/auth-profiles/profiles.ts";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  writeConfigFile,
} from "../src/config/config.ts";
import { buildOauthProviderAuthResult } from "../src/plugin-sdk/provider-auth-result.ts";
import { applyAuthProfileConfig } from "../src/plugins/provider-auth-helpers.ts";

const rl = readline.createInterface({ input, output });

function log(...args) {
  process.stdout.write(`${args.join(" ")}\n`);
}

try {
  log("Starting OpenAI Codex OAuth...");
  const creds = await loginOpenAICodex({
    onAuth: async ({ url, instructions }) => {
      log("");
      log("Open this URL in your browser:");
      log(url);
      if (instructions) {
        log(instructions);
      }
      log("");
      log("The helper is listening on http://localhost:1455/auth/callback");
      log("If the browser callback does not auto-complete, paste the full redirect URL here.");
      log("");
    },
    onPrompt: async ({ message }) => {
      const answer = await rl.question(`${message} `);
      return answer.trim();
    },
    onManualCodeInput: async () => {
      const answer = await rl.question("Paste the authorization code (or full redirect URL): ");
      return answer.trim();
    },
    onProgress: (message) => {
      if (typeof message === "string" && message.trim().length > 0) {
        log(message.trim());
      }
    },
    originator: "pi",
  });

  if (!creds) {
    throw new Error("No credentials returned from OpenAI Codex OAuth");
  }

  const result = buildOauthProviderAuthResult({
    providerId: "openai-codex",
    defaultModel: "openai-codex/gpt-5.4",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: creds.email ?? null,
    displayName: creds.displayName ?? null,
    profileName: creds.email ?? null,
  });

  const agentDir = resolveOpenClawAgentDir();
  for (const profile of result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir,
    });
  }

  clearConfigCache();
  clearRuntimeConfigSnapshot();
  let config = loadConfig();
  for (const profile of result.profiles) {
    config = applyAuthProfileConfig(config, {
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: "oauth",
      email: "email" in profile.credential ? profile.credential.email : undefined,
      displayName: "displayName" in profile.credential ? profile.credential.displayName : undefined,
    });
  }

  config = {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: {
          ...config.agents?.defaults?.model,
          primary: result.defaultModel,
        },
        models: {
          ...config.agents?.defaults?.models,
          [result.defaultModel]: {
            ...config.agents?.defaults?.models?.[result.defaultModel],
          },
        },
      },
    },
  };

  await writeConfigFile(config);
  clearConfigCache();
  clearRuntimeConfigSnapshot();

  log("");
  log("OAuth complete.");
  for (const profile of result.profiles) {
    log(`Auth profile saved: ${profile.profileId}`);
  }
  log(`Default model set: ${result.defaultModel}`);
  log(`Agent dir: ${agentDir}`);
} finally {
  rl.close();
}
