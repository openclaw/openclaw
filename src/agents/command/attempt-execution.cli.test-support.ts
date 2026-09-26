import path from "node:path";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { persistCliTurnTranscript } from "./transcript-persistence.js";

/** Canonical successful CLI result fixture shared by the attempt-execution tests. */
export function makeCliResult(text: string, sessionId = "session-cli"): EmbeddedAgentRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId,
        ...(sessionId ? { cliSessionBinding: { sessionId } } : {}),
        provider: "claude-cli",
        model: "opus",
        usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 0, total: 19 },
        lastCallUsage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 0, total: 19 },
      },
      executionTrace: {
        winnerProvider: "claude-cli",
        winnerModel: "opus",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

/** Persists one CLI transcript fixture and requires the current session to survive. */
export async function persistCliTranscriptEntry(
  params: Parameters<typeof persistCliTurnTranscript>[0],
): Promise<SessionEntry | undefined> {
  const result = await persistCliTurnTranscript(params);
  if (result.kind !== "persisted") {
    throw new Error("expected CLI transcript persistence to keep the current session");
  }
  return result.sessionEntry;
}

export function resetCliAttemptFixtureDatabases(suiteRoot: string): void {
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (!database.path.startsWith(`${suiteRoot}${path.sep}`)) {
      continue;
    }
    runOpenClawAgentWriteTransaction(
      (fixture) => {
        fixture.db.exec(`
          DELETE FROM session_transcript_fts;
          DELETE FROM session_transcript_fts_rows;
          DELETE FROM session_nodes;
          DELETE FROM conversations;
          DELETE FROM auth_profile_store;
          DELETE FROM auth_profile_state;
          DELETE FROM cache_entries;
        `);
      },
      database,
      { operationLabel: "test.attempt-execution.reset" },
    );
  }
}

/** Model capability and channel discovery fixtures for CLI fallback tests. */
export function createCliImageCapabilityPlugins(model: string) {
  // MCP still builds message schemas before applying the read-only grant.
  // Keep this capability test independent of bundled Discord action discovery.
  const pluginRegistry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: { describeMessageTool: () => null },
      } satisfies ChannelPlugin,
    },
  ]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "anthropic",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
        modelCatalog: {
          providers: {
            anthropic: {
              models: [{ id: model, name: model, reasoning: true, input: ["text", "image"] }],
            },
          },
        },
      },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}
