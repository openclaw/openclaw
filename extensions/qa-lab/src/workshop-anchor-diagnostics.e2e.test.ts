import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { closeQaHttpServer, dispatchQaHttpRequest } from "./bus-server.js";
import { createQaGatewayChild } from "./gateway-child.js";
import {
  extractLastUserText,
  normalizeResponsesInput,
} from "./providers/mock-openai/mock-openai-input.js";
import { writeMockOpenAiResponsesHttp } from "./providers/mock-openai/mock-openai-responses-http.js";
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
    let backgroundRequested = false;
    let phase = "ordinary";
    let compacted = false;
    let backgroundReleased = false;
    let accepted = false;
    let captureFailure: (() => Promise<void>) | undefined;
    const releaseBackground = Promise.withResolvers<void>();
    const dispatch = async ({ body }: { body: Record<string, unknown> }) => {
      const ordinal = ++responses;
      const stream = new MockResponseStream(`resp_anchor_${ordinal}`);
      const prompt = extractLastUserText(normalizeResponsesInput(body.input)).replace(
        /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [^\]\r\n]+)?\]\s*/u,
        "",
      );
      // Daily maintenance shares this provider; hold only the actual experience review.
      if (!backgroundRequested && prompt.startsWith("Background skill review.")) {
        // The normal review has now admitted its source anchor and reached the model.
        backgroundRequested = true;
        await releaseBackground.promise;
        stream.tool({
          type: "function_call",
          id: "fc_anchor_review",
          call_id: "call_anchor_review",
          name: "skill_workshop",
          arguments: JSON.stringify({ action: "list" }),
        });
      } else {
        stream.message({ id: `msg_anchor_${ordinal}`, text: MARKER, phase: "final_answer" });
      }
      return {
        events: stream.complete(8),
        model: typeof body.model === "string" ? body.model : "",
      };
    };
    const server = createServer((request, response) => {
      dispatchQaHttpRequest(response, async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        await writeMockOpenAiResponsesHttp(
          response,
          true,
          await dispatch({ body: (await json(request)) as Record<string, unknown> }),
        );
      });
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
          enabledPluginIds: ["skill-workshop"],
          runtimeEnvPatch: {
            HTTP_PROXY: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            ALL_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "127.0.0.1,localhost,::1",
          },
          mutateConfig: (config) => ({
            ...config,
            meta: { ...config.meta, migrations: { skillWorkshopPlugin: true } },
            logging: { ...config.logging, level: "debug", consoleLevel: "debug" },
            plugins: {
              ...config.plugins,
              entries: {
                ...config.plugins?.entries,
                "skill-workshop": {
                  enabled: true,
                  config: { autonomous: { mode: "auto", channelNotices: false } },
                },
              },
            },
            tools: { profile: "full", allow: ["skill_workshop"] },
            agents: {
              ...config.agents,
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
        const logDir = path.join(gateway.workspaceDir, "logs");
        const readRecords = async () =>
          (
            await Promise.all(
              (await fs.readdir(logDir)).map((file) =>
                fs.readFile(path.join(logDir, file), "utf8"),
              ),
            )
          ).flatMap((text) =>
            text
              .split("\n")
              .slice(0, -1)
              .map(
                (line) =>
                  JSON.parse(line) as {
                    _meta?: { logLevelName?: string };
                    [key: string]: unknown;
                  },
              ),
          );
        const findCancellation = (records: Awaited<ReturnType<typeof readRecords>>) =>
          records.find((record) =>
            Object.values(record).some(
              (value) =>
                typeof value === "string" &&
                value.includes("skill experience review cancelled:") &&
                value.includes(`source=${fingerprint}`),
            ),
          );
        captureFailure = async () => {
          const records = await readRecords();
          const messages = records
            .flatMap(Object.values)
            .filter((value) => typeof value === "string");
          const cancellations = messages.filter((value) =>
            value.includes("skill experience review cancelled:"),
          );
          console.log(
            "WORKSHOP_ANCHOR_DIAGNOSTIC " +
              JSON.stringify({
                phase,
                modelResponses: responses,
                compacted,
                backgroundReleased,
                parsedLogCount: records.length,
                logLevels: Object.fromEntries(
                  ["DEBUG", "INFO", "WARN", "ERROR"].map((level) => [
                    level,
                    records.filter((record) => record._meta?.logLevelName === level).length,
                  ]),
                ),
                cancellationCount: cancellations.length,
                matchingCancellationCount: cancellations.filter((value) =>
                  value.includes(`source=${fingerprint}`),
                ).length,
                fingerprintInAnyRecord: messages.some((value) =>
                  value.includes(`source=${fingerprint}`),
                ),
                failureWarningCount: messages.filter((value) =>
                  value.includes("skill experience review failed:"),
                ).length,
                failureDiagnostics: [
                  ...new Set(
                    messages
                      .filter((value) => value.includes("skill experience review failed:"))
                      .map((value) =>
                        value
                          .slice(
                            value.indexOf("skill experience review failed:") +
                              "skill experience review failed:".length,
                          )
                          .replace(/\s+source=[a-f0-9]{64}\s*$/i, "")
                          .replaceAll(sessionKey, "<session>")
                          .replaceAll(history.sessionId, "<session>")
                          .replaceAll(history.sessionInfo.activeLeafEntryId, "<entry>")
                          .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<id>")
                          .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
                          .replace(/(?:[A-Z]:\\|\/)[^\s"'<>]*/gi, "<path>")
                          .replace(/\s+/g, " ")
                          .trim()
                          .slice(0, 400),
                      ),
                  ),
                ].slice(0, 4),
                fenceReasons: [
                  "unavailable",
                  "agentId",
                  "sessionId",
                  "sessionKey",
                  "generation",
                  "entryId",
                  "rawSeq",
                  "effectiveParentId",
                  "activeMessagePosition",
                  "storePath",
                ].filter((field) =>
                  messages.some((value) =>
                    value.includes(`Completed-turn transcript anchor changed (${field})`),
                  ),
                ),
                genericUserAbort: messages.some((value) =>
                  value.includes("Skill experience review was stopped by the user."),
                ),
                missingInput: messages.some((value) => value.includes("no longer holds the input")),
                runtimeAbort: messages.some((value) =>
                  value.includes("Session fork model run aborted."),
                ),
                changedDuringContextRead: messages.some((value) =>
                  value.includes("Session transcript changed during context read"),
                ),
                forkAuthorityChanged: messages.some((value) =>
                  value.includes("Session fork authority changed"),
                ),
              }),
          );
        };
        await expect.poll(() => backgroundRequested, { timeout: 65_000, interval: 200 }).toBe(true);
        phase = "background-admitted";
        const compact = (await gateway.call("sessions.compact", {
          key: sessionKey,
          maxLines: 1,
        })) as { compacted: boolean };
        expect(compact.compacted).toBe(true);
        compacted = compact.compacted;
        phase = "compacted";
        releaseBackground.resolve();
        backgroundReleased = true;
        phase = "poll";
        // The plugin runtime logger owns the structured file sink, not Gateway console output.
        await expect
          .poll(async () => Boolean(findCancellation(await readRecords())), {
            timeout: 65_000,
            interval: 200,
          })
          .toBe(true);
        const records = await readRecords();
        const cancellation = findCancellation(records);
        const diagnostic = Object.values(cancellation ?? {}).find(
          (value): value is string =>
            typeof value === "string" && value.includes("skill experience review cancelled:"),
        );
        expect(diagnostic).toContain("Completed-turn transcript anchor changed (");
        expect(diagnostic).toContain(`source=${fingerprint}`);
        expect(diagnostic).not.toContain(sessionKey);
        expect(diagnostic).not.toContain(history.sessionId);
        expect(JSON.stringify(records)).not.toContain("skill experience review failed:");
        expect(cancellation?._meta?.logLevelName).toBe("DEBUG");
        const mismatch = /Completed-turn transcript anchor changed \((\w+)\)/.exec(
          diagnostic ?? "",
        )?.[1];
        phase = "continuation";
        await turn();
        console.log(
          "WORKSHOP_ANCHOR_PROOF " +
            JSON.stringify({
              foregroundTurnsCompleted: 11,
              rewriteCompacted: compact.compacted,
              backgroundReviewReachedProvider: backgroundRequested,
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
        accepted = true;
      },
      async () => {
        if (!accepted) {
          await captureFailure?.().catch(() => {
            console.log(
              "WORKSHOP_ANCHOR_DIAGNOSTIC " + JSON.stringify({ phase, captureUnavailable: true }),
            );
          });
        }
      },
      () => releaseBackground.resolve(),
      () => stopQaGatewayFixture(owner),
      () => sockets.close(),
      () => closeQaHttpServer(server),
    );
  },
);
