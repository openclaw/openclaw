import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyProviderConfigWithDefaultModelPreset,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "../../src/plugin-sdk/provider-onboard.ts";

const DOCKER_OPENAI_MODEL_REF = "openai/gpt-5.4";
const DOCKER_OPENAI_MODEL: ModelDefinitionConfig = {
  id: "gpt-5.4",
  name: "gpt-5.4",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const sessionFile = path.join(sessionsDir, "sess-main.jsonl");
  const storePath = path.join(sessionsDir, "sessions.json");
  const now = Date.now();

  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const seededConfig = applyProviderConfigWithDefaultModelPreset(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
          enabled: false,
        },
      },
    } satisfies OpenClawConfig,
    {
      providerId: "openai",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:9/v1",
      defaultModel: DOCKER_OPENAI_MODEL,
      defaultModelId: DOCKER_OPENAI_MODEL.id,
      aliases: [{ modelRef: DOCKER_OPENAI_MODEL_REF, alias: "GPT" }],
      primaryModelRef: DOCKER_OPENAI_MODEL_REF,
    },
  );
  const openAiProvider = seededConfig.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("failed to seed OpenAI provider config");
  }
  openAiProvider.apiKey = "sk-docker-smoke-test";

  await fs.writeFile(configPath, JSON.stringify(seededConfig, null, 2), "utf-8");

  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          sessionFile,
          updatedAt: now,
          lastChannel: "imessage",
          lastTo: "+15551234567",
          lastAccountId: "imessage-default",
          lastThreadId: "thread-42",
          displayName: "Docker MCP Channel Smoke",
          derivedTitle: "Docker MCP Channel Smoke",
          lastMessagePreview: "seeded transcript",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
      JSON.stringify({
        id: "msg-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from seeded transcript" }],
          timestamp: now,
        },
      }),
      JSON.stringify({
        id: "msg-attachment",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "seeded image attachment" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc",
              },
            },
          ],
          timestamp: now + 1,
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      storePath,
      sessionFile,
    }) + "\n",
  );
}

await main();
