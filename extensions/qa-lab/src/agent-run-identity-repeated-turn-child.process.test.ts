import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { createFixtureLifetime, stopChildProcess } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { identityRepeatedTurnEntrypoint } from "./agent-run-identity-runtime.test-support.js";
import {
  appendQaChildOutputTail,
  createQaChildOutputTail,
  readQaChildOutputTail,
} from "./child-output.js";
import { buildQaRuntimeEnv } from "./gateway-child-env.js";
import type { MockOpenAiRequestSnapshot } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

it(
  "runs both identity ingress turns in a cold process with distinct execution contexts",
  () =>
    lifetime.run(async () => {
      const repoRoot = path.resolve(import.meta.dirname, "../../..");
      const root = lifetime.createTempDir("identity-repeated-child-");
      const stateDir = path.join(root, "state");
      const workspaceDir = path.join(root, "workspace");
      const configPath = path.join(root, "openclaw.json");
      const mock = await lifetime.acquire(async () => {
        const server = await startQaMockOpenAiServer();
        return { ...server, cleanup: () => server.stop() };
      });
      await fs.mkdir(workspaceDir, { recursive: true });
      const config = buildQaGatewayConfig({
        bind: "loopback",
        gatewayPort: 1, // Direct ingress never starts or connects to a Gateway.
        gatewayToken: "identity-child-test",
        workspaceDir,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
      });
      config.logging = { ...config.logging, audit: { enabled: true, executionIdentity: true } };
      await fs.writeFile(configPath, JSON.stringify(config));
      const env = buildQaRuntimeEnv({
        configPath,
        gatewayToken: "identity-child-test",
        homeDir: path.join(root, "home"),
        stateDir,
        tempRoot: root,
        xdgConfigHome: path.join(root, "xdg-config"),
        xdgDataHome: path.join(root, "xdg-data"),
        xdgCacheHome: path.join(root, "xdg-cache"),
        bundledPluginsDir: path.join(repoRoot, "dist", "extensions"),
        developmentSourceRoot: null,
        providerMode: "mock-openai",
        baseEnv: Object.fromEntries(
          ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "PATHEXT"].flatMap((key) =>
            process.env[key] === undefined ? [] : [[key, process.env[key]]],
          ),
        ),
      });
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
      const exit = await withTimeout(once(child, "close"), 60_000).catch((error: unknown) => {
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
  90_000,
);
