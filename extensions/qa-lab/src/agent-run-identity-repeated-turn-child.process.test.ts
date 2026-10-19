import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { createFixtureLifetime, stopChildProcess } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { identityRepeatedTurnEntrypoint } from "./agent-run-identity-runtime.test-support.js";
import * as bundledPluginStaging from "./bundled-plugin-staging.js";
import {
  appendQaChildOutputTail,
  createQaChildOutputTail,
  readQaChildOutputTail,
} from "./child-output.js";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";
import type { MockOpenAiRequestSnapshot } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";

const lifetime = createFixtureLifetime();
const setup = createQaGatewaySetupHarness();
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
      // In-process test setup already binds MCP; only the maintained child exposes this omission.
      const { child } = await lifetime.acquire(async () => {
        const processChild = spawn(
          process.execPath,
          [...resolveRuntimeWorkerArgv(childUrl), sessionId],
          {
            cwd: repoRoot,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        return { child: processChild, cleanup: () => stopChildProcess(processChild, 5_000) };
      });
      const output = createQaChildOutputTail(128 * 1024);
      child.stdout?.on("data", (chunk) => appendQaChildOutputTail(output, chunk));
      child.stderr?.on("data", (chunk) => appendQaChildOutputTail(output, chunk));
      // A cold child boots, runs two turns, and closes its databases; loaded CI shards need
      // close to a minute for that (59s observed), so the bound leaves real headroom.
      const exit = await withTimeout(once(child, "close"), 180_000).catch((error: unknown) => {
        throw new Error(`Repeated ingress child did not close: ${readQaChildOutputTail(output)}`, {
          cause: error,
        });
      });
      const response = await fetch(`${mock.baseUrl}/debug/requests?after=0`);
      expect(response.ok).toBe(true);
      const requests: MockOpenAiRequestSnapshot[] = await response.json();
      expect(
        exit,
        JSON.stringify({
          output: readQaChildOutputTail(output),
          providerRequests: requests.length,
        }),
      ).toEqual([0, null]);
      expect(requests.map((request) => request.outcome)).toEqual(["success", "success"]);
      expect(requests[0]?.prompt).toContain("REPEATED-TURN-ONE");
      expect(requests[1]?.prompt).toContain("REPEATED-TURN-TWO");

      const state = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const contexts = state
          .prepare("SELECT run_id, execution_id, context_id FROM execution_identity_contexts")
          .all();
        expect(contexts.map((row) => row.run_id)).toEqual([sessionId, sessionId]);
        for (const field of ["execution_id", "context_id"] as const) {
          expect(contexts.map((row) => row[field])).toEqual([
            expect.any(String),
            expect.any(String),
          ]);
          expect(new Set(contexts.map((row) => row[field])).size).toBe(2);
        }
      } finally {
        state.close();
      }
      const agent = new DatabaseSync(
        path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite"),
        { readOnly: true },
      );
      try {
        const rows = agent
          .prepare(
            "SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(sessionId) as Array<{ event_json: string | null; event_zstd: Uint8Array }>;
        const messages = rows
          .map((row) =>
            JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString("utf8")),
          )
          .filter((event) => event.type === "message" && event.message.role === "assistant")
          .map((event) => event.message);
        expect(
          messages.map((message) => ({
            stopReason: message.stopReason,
            content: message.content.map((part: { text?: string }) => part.text),
          })),
        ).toEqual([
          { stopReason: "stop", content: ["REPEATED-TURN-ONE"] },
          { stopReason: "stop", content: ["REPEATED-TURN-TWO"] },
        ]);
      } finally {
        agent.close();
      }
    }),
  240_000,
);
