import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "./gateway-child.js";
import { attachQaMockResponsesWebSocketServer } from "./providers/mock-openai/mock-openai-responses-websocket.js";
import { MockResponseStream } from "./providers/mock-openai/mock-openai-stream.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const MARKER = "SYNTHETIC_WORKSHOP_DIAGNOSTICS_FINAL";

// Opt-in E2E proof retains the real idle interval; unit tests own the cheaper predicate matrix.
it(
  "reports a queued review's rewritten anchor through a running Gateway",
  { timeout: 240_000 },
  async () => {
    let responses = 0;
    const dispatch = async ({ body }: { body: Record<string, unknown> }) => {
      const ordinal = ++responses;
      const stream = new MockResponseStream(`resp_anchor_${ordinal}`);
      stream.message({ id: `msg_anchor_${ordinal}`, text: MARKER, phase: "final_answer" });
      return {
        events: stream.complete(8),
        model: typeof body.model === "string" ? body.model : "",
      };
    };
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const { events } = await dispatch({
          body: (await json(request)) as Record<string, unknown>,
        });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        );
      })().catch(() => response.writeHead(500).end("synthetic provider failure"));
    });
    const sockets = attachQaMockResponsesWebSocketServer({ server, dispatch });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Synthetic provider did not bind");
    }
    const owner = createQaGatewayChild();
    await runQaGatewayFixture(
      async () => {
        const gateway = await owner.start({
          repoRoot: REPO_ROOT,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(REPO_ROOT, "dist/index.js")],
            cwd: REPO_ROOT,
            // This is compiled Gateway diagnostic proof, not package-upgrade proof.
            usePackagedPlugins: false,
            tempParentDir: process.env.TMPDIR,
          },
          providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          transportBaseUrl: "",
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna",
          forcedRuntime: "openclaw",
          runtimeSelection: "configured",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            HTTP_PROXY: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            ALL_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "127.0.0.1,localhost,::1",
          },
          mutateConfig: (config) => ({
            ...config,
            logging: { ...config.logging, level: "debug", consoleLevel: "debug" },
            skills: { workshop: { autonomous: { mode: "auto", channelNotices: false } } },
            tools: { profile: "full", allow: ["skill_workshop"] },
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, heartbeat: { every: "0m" } },
              entries: {
                ...config.agents?.entries,
                qa: {
                  ...config.agents?.entries?.qa,
                  tools: { profile: "full", allow: ["skill_workshop"] },
                },
              },
            },
          }),
        });
        console.log("WORKSHOP_ANCHOR_OWNER " + JSON.stringify({ pid: gateway.pid }));
        const sessionKey = `agent:qa:anchor-proof-${randomUUID()}`;
        const turn = async () => {
          const started = (await gateway.call("chat.send", {
            sessionKey,
            message: "Finish this synthetic diagnostics turn.",
            deliver: false,
            idempotencyKey: randomUUID(),
          })) as { runId: string; status: string };
          expect(started.status).toBe("started");
          const terminal = (await gateway.call(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 70_000 },
          )) as { status: string };
          expect(terminal.status).toBe("ok");
        };
        for (let ordinal = 0; ordinal < 10; ordinal++) {
          await turn();
        }
        const history = (await gateway.call("chat.history", { sessionKey })) as {
          sessionId: string;
          sessionInfo: { activeLeafEntryId: string };
          messages: unknown[];
        };
        console.log(
          "WORKSHOP_ANCHOR_STAGE " +
            JSON.stringify({
              turnsCompleted: 10,
              modelResponses: responses,
              hasSessionId: Boolean(history.sessionId),
              hasLeaf: Boolean(history.sessionInfo?.activeLeafEntryId),
            }),
        );
        expect(history.sessionId).toBeTypeOf("string");
        expect(history.sessionInfo.activeLeafEntryId).toBeTypeOf("string");
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(["qa", history.sessionId, history.sessionInfo.activeLeafEntryId]))
          .digest("hex");
        const mark = gateway.markLogs();
        const compact = (await gateway.call("sessions.compact", {
          key: sessionKey,
          maxLines: 1,
        })) as { compacted: boolean };
        expect(compact.compacted).toBe(true);
        await expect
          .poll(() => gateway.readLogsSince(mark).includes("skill experience review cancelled:"), {
            timeout: 65_000,
            interval: 200,
          })
          .toBe(true);
        const logs = gateway.readLogsSince(mark);
        const diagnostic = logs
          .split("\n")
          .find((line) => line.includes("skill experience review cancelled:"));
        expect(diagnostic).toContain("Completed-turn transcript anchor changed (");
        expect(diagnostic).toContain(`source=${fingerprint}`);
        expect(diagnostic).not.toContain(sessionKey);
        expect(diagnostic).not.toContain(history.sessionId);
        expect(logs).not.toContain("skill experience review failed:");
        const logDir = path.join(gateway.workspaceDir, "logs");
        const records = (
          await Promise.all(
            (await fs.readdir(logDir)).map((file) => fs.readFile(path.join(logDir, file), "utf8")),
          )
        ).flatMap((text) =>
          text
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  _meta?: { logLevelName?: string };
                  [key: string]: unknown;
                },
            ),
        );
        const cancellation = records.find((record) =>
          Object.values(record).some(
            (value) =>
              typeof value === "string" &&
              value.includes("skill experience review cancelled:") &&
              value.includes(`source=${fingerprint}`),
          ),
        );
        expect(cancellation?._meta?.logLevelName).toBe("DEBUG");
        const mismatch = /Completed-turn transcript anchor changed \((\w+)\)/.exec(
          diagnostic ?? "",
        )?.[1];
        await turn();
        console.log(
          "WORKSHOP_ANCHOR_PROOF " +
            JSON.stringify({
              foregroundTurnsCompleted: 11,
              rewriteCompacted: compact.compacted,
              mismatch,
              sourceFingerprint: fingerprint,
              sourceCorrelationMatches: true,
              cancellationObserved: true,
              severity: cancellation?._meta?.logLevelName,
              failureWarningAbsent: true,
              ordinaryTurnAfterCancellation: "ok",
              realGateway: true,
              model: "loopback-synthetic",
              delivery: false,
            }),
        );
      },
      () => stopQaGatewayFixture(owner),
      async () => {
        await sockets.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      },
    );
  },
);
