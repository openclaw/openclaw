import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "../../src/config/sessions/store.ts";
import { replaceSqliteSessionTranscriptEvents } from "../../src/config/sessions/transcript-store.sqlite.ts";
import { resolveOpenClawAgentSqlitePath } from "../../src/state/openclaw-agent-db.ts";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "sess-main.jsonl");
  const now = Date.now();

  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const seededConfig = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
          enabled: false,
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
        },
      },
      plugins: {
        enabled: false,
      },
    } satisfies OpenClawConfig,
    "sk-docker-smoke-test",
  );

  await fs.writeFile(configPath, JSON.stringify(seededConfig, null, 2), "utf-8");

  upsertSessionEntry({
    agentId: "main",
    sessionKey: "agent:main:main",
    entry: {
      sessionId: "sess-main",
      sessionFile: transcriptPath,
      updatedAt: now,
      deliveryContext: {
        channel: "imessage",
        to: "+15551234567",
        accountId: "imessage-default",
        threadId: "thread-42",
      },
      displayName: "Docker MCP Channel Smoke",
      derivedTitle: "Docker MCP Channel Smoke",
      lastMessagePreview: "seeded transcript",
    },
  });

  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-main",
    transcriptPath,
    now: () => now,
    events: [
      { type: "session", version: 1, id: "sess-main" },
      {
        id: "msg-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from seeded transcript" }],
          timestamp: now,
        },
      },
      {
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
      },
    ],
  });

  process.stdout.write(
    JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      agentDatabasePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      transcriptPath,
    }) + "\n",
  );
}

await main();
