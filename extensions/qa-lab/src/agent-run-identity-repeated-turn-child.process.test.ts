import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { createFixtureLifetime, runCliProcessChild } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { identityRepeatedTurnEntrypoint } from "./agent-run-identity-runtime.test-support.js";
import * as bundledPluginStaging from "./bundled-plugin-staging.js";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";
import type { MockOpenAiRequestSnapshot } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";

const lifetime = createFixtureLifetime();
const setup = createQaGatewaySetupHarness();
const turns = ["REPEATED-TURN-ONE", "REPEATED-TURN-TWO"];
function query(database: string, sql: string, ...params: SQLInputValue[]) {
  using db = new DatabaseSync(database, { readOnly: true });
  return db.prepare(sql).all(...params);
}
afterEach(async () => {
  await lifetime.cleanup();
  await setup.cleanup();
  vi.restoreAllMocks();
});

it(
  "runs both identity ingress turns in a cold process with distinct execution contexts",
  () =>
    lifetime.run(async () => {
      const repoRoot = path.resolve(import.meta.dirname, "../../..");
      const mock = await lifetime.acquire(async () => {
        const server = await startQaMockOpenAiServer();
        return { ...server, cleanup: () => server.stop() };
      });
      // The cold worker exercises compiled plugins, not repository staging.
      const staging = vi
        .spyOn(bundledPluginStaging, "createQaBundledPluginsDir")
        .mockImplementation(async ({ tempRoot }) => ({
          bundledPluginsDir: path.join(repoRoot, "dist", "extensions"),
          stagedRoot: bundledPluginStaging.resolveQaStagedBundledPluginsRoot({
            repoRoot,
            tempRoot,
          }),
          runtimeHostVersion: undefined,
        }));
      const { stateDir, env } = await setup.prepare({
        repoRoot,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        mutateConfig: (cfg) => ({
          ...cfg,
          logging: { ...cfg.logging, audit: { enabled: true, executionIdentity: true } },
        }),
      });
      staging.mockRestore();
      // Standalone compiled ingress must not inherit test-runner loaders or source selection.
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      delete env.NODE_V8_COVERAGE;
      delete env.OPENCLAW_DEV_SOURCE_ROOT;
      const sessionId = "identity-repeated-regression";
      const childUrl = resolveRuntimeWorkerUrl(identityRepeatedTurnEntrypoint);
      // Runtime transpilation must not consume the cold ingress execution deadline.
      expect(childUrl.pathname.endsWith(".js")).toBe(true);
      const exit = await runCliProcessChild({
        nodeArgs: [...resolveRuntimeWorkerArgv(childUrl), sessionId],
        nodeArgsPolicy: "caller",
        cwd: repoRoot,
        env,
        timeoutMs: 180_000,
      });
      const response = await fetch(`${mock.baseUrl}/debug/requests?after=0`);
      expect(response.ok).toBe(true);
      const requests: MockOpenAiRequestSnapshot[] = await response.json();
      expect(exit, exit.stderr).toMatchObject({ code: 0, signal: null });
      expect(requests).toMatchObject(
        turns.map((prompt) => ({
          outcome: "success",
          prompt: expect.stringContaining(prompt),
        })),
      );
      const contexts = query(
        path.join(stateDir, "state", "openclaw.sqlite"),
        "SELECT run_id, execution_id, context_id FROM execution_identity_contexts",
      );
      expect(contexts.map((row) => row.run_id)).toEqual([sessionId, sessionId]);
      for (const field of ["execution_id", "context_id"] as const) {
        expect(contexts.map((row) => row[field])).toEqual([expect.any(String), expect.any(String)]);
        expect(new Set(contexts.map((row) => row[field])).size).toBe(2);
      }
      const rows = query(
        path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite"),
        "SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
        sessionId,
      ) as Array<{ event_json: string | null; event_zstd: Uint8Array }>;
      const messages = rows
        .map((row) =>
          JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString("utf8")),
        )
        .filter((event) => event.type === "message" && event.message.role === "assistant")
        .map((event) => event.message);
      expect(messages).toMatchObject(
        turns.map((text) => ({ stopReason: "stop", content: [{ text }] })),
      );
    }),
  240_000,
);
