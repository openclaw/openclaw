import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { withTempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexAppServerInitializeParams } from "./app-server/client-initialize.js";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import {
  listenForNativeResponses,
  sendNativeResponse,
} from "./app-server/thread-native.test-support.js";
import { buildCodexRuntimeThreadConfig } from "./app-server/thread-requests.js";
import { deriveCodexWorkerConfigurationVersion } from "./node-app-server-command.js";
import { createCodexNodeAppServerCommand } from "./node-app-server.js";
import * as nodeExecRuntime from "./node-exec-server.runtime.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setManagedCodexPluginRoot(undefined);
});

describe("Codex worker model process", () => {
  it("gates native resource readiness, resumes exact state, and retains failed-cleanup custody", async ({
    signal,
    onTestFinished,
  }) => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "codex-worker-model-" },
      async ({ dir }) => {
        const root = await fs.realpath(dir);
        const requests: Array<{
          authorization: string | undefined;
          model: unknown;
        }> = [];
        const port = await listenForNativeResponses({ onTestFinished }, (request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            const parsed = JSON.parse(body) as {
              model?: unknown;
            };
            requests.push({
              authorization: request.headers.authorization,
              model: parsed.model,
            });
            sendNativeResponse(response, "worker-response", {
              type: "message",
              role: "assistant",
              id: "worker-answer",
              content: [{ type: "output_text", text: "Worker inference completed." }],
            });
          });
        });
        const state = path.join(root, "state");
        const configDir = path.join(state, "codex-runtime");
        const workspaceDir = path.join(root, "repo");
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(workspaceDir);
        await fs.writeFile(
          path.join(configDir, "config.toml"),
          `model = "codex-test-model"\nmodel_provider = "autodev"\n[model_providers.autodev]\nname = "AutoDev"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[model_providers.autodev.auth]\ncommand = "node"\nargs = ["${path.join(configDir, "autodev-token.mjs")}"]\n`,
          { mode: 0o600 },
        );
        await fs.writeFile(
          path.join(configDir, "autodev-token.mjs"),
          "process.stdout.write('synthetic-worker-bearer\\n')\n",
          { mode: 0o600 },
        );
        const helperPath = path.join(configDir, "autodev-token.mjs");
        const version = deriveCodexWorkerConfigurationVersion(
          await fs.readFile(path.join(configDir, "config.toml"), "utf8"),
          helperPath,
          await fs.readFile(helperPath, "utf8"),
        );
        await fs.writeFile(path.join(configDir, "version"), version, { mode: 0o600 });
        vi.stubEnv("OPENCLAW_STATE_DIR", state);
        setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url)));
        const runExecServer = nodeExecRuntime.runCodexNodeExecServer;
        vi.spyOn(nodeExecRuntime, "runCodexNodeExecServer").mockImplementationOnce(
          async (params) => {
            let failCleanup = true;
            const stop = async () => {
              if (failCleanup) {
                failCleanup = false;
                throw new Error("Synthetic native process cleanup failure");
              }
              params.activeProcesses.delete(stop);
            };
            // Inject failure into the actual environment cleanup group, not around close().
            params.activeProcesses.add(stop);
            return await runExecServer(params);
          },
        );
        let connections = 0;
        const command = createCodexNodeAppServerCommand();
        expect(command.isAvailable?.({ config: {}, env: process.env })).toBe(true);
        const originalHelper = await fs.readFile(helperPath, "utf8");
        const changedHelper = originalHelper + "// replacement";
        await fs.writeFile(helperPath, changedHelper);
        await fs.writeFile(
          path.join(configDir, "version"),
          deriveCodexWorkerConfigurationVersion(
            await fs.readFile(path.join(configDir, "config.toml"), "utf8"),
            helperPath,
            changedHelper,
          ),
        );
        await expect(command.prepare?.({ config: {}, env: process.env })).rejects.toThrow(
          "configuration version",
        );
        expect(requests).toHaveLength(0);
        await fs.writeFile(helperPath, originalHelper);
        await fs.writeFile(path.join(configDir, "version"), version);
        await command.prepare?.({ config: {}, env: process.env });
        const placement = {
          cwd: workspaceDir,
          environmentId: "worker-environment",
          sessionId: "worker-session",
          ownerEpoch: 1,
          sessionKey: "agent:main:worker-session",
        };
        const runConnection = async <T>(
          use: (
            request: (id: number, method: string, params: unknown) => Promise<unknown>,
            notify: (method: string) => Promise<void>,
            waitNotification: (method: string) => Promise<unknown>,
          ) => Promise<T>,
        ): Promise<T> => {
          const exerciseCleanupFailure = connections++ === 0;
          const controller = new AbortController();
          const replies = new EventEmitter();
          let receiver: ((message: Uint8Array) => void | Promise<void>) | undefined;
          let ready!: () => void;
          const listening = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const release = vi.fn();
          const running = command.handle(
            JSON.stringify({
              placement,
              authorization: "session-full",
              resourcePreparationRequired: true,
            }),
            {
              emitChunk: async () => {},
              onInput: () => {},
              signal: AbortSignal.any([controller.signal, signal]),
              frames: {
                send: async (frame) => {
                  const response = JSON.parse(Buffer.from(frame).toString("utf8")) as {
                    id?: number;
                  };
                  replies.emit(String(response.id), response);
                  if ("method" in response && typeof response.method === "string") {
                    replies.emit(response.method, response);
                  }
                },
                onMessage: (listener) => {
                  receiver = listener;
                  ready();
                  return () => {
                    receiver = undefined;
                  };
                },
              },
            },
            {
              sessionKey: placement.sessionKey,
              sendNodeEvent: async () => undefined,
              prepareExecAuthorization: () => () => {},
              acquireManagedWorkspaceAsync: async () => ({
                workspaceDir,
                homeDir: root,
                release,
              }),
            },
          );
          await Promise.race([listening, running]);
          const notify = async (method: string) => {
            await receiver?.(Buffer.from(JSON.stringify({ method, params: {} })));
          };
          const request = async (id: number, method: string, params: unknown) => {
            const response = once(replies, String(id));
            await receiver?.(Buffer.from(JSON.stringify({ id, method, params })));
            return (await response)[0] as unknown;
          };
          const waitNotification = async (method: string) =>
            (await once(replies, method))[0] as unknown;
          try {
            return await use(request, notify, waitNotification);
          } finally {
            controller.abort(new Error("test complete"));
            await expect(running).rejects.toThrow();
            if (exerciseCleanupFailure) {
              try {
                expect(release).not.toHaveBeenCalled();
                expect(command.hasActiveWork?.()).toBe(true);
              } finally {
                await command.onDisconnect?.();
              }
            }
            expect(release).toHaveBeenCalledOnce();
          }
        };
        const threadId = await runConnection(async (request, notify, waitNotification) => {
          const initialized = await request(1, "initialize", buildCodexAppServerInitializeParams());
          expect(initialized).toMatchObject({ result: { userAgent: expect.any(String) } });
          await notify("initialized");
          const pendingRead = request(20, "fs/readFile", {
            path: path.join(workspaceDir, "readiness-proof.txt"),
          });
          let readSettled = false;
          void pendingRead.then(() => {
            readSettled = true;
          });
          const started = (await request(2, "thread/start", {
            cwd: workspaceDir,
            modelProvider: "autodev",
            model: "codex-test-model",
            config: buildCodexRuntimeThreadConfig(undefined),
          })) as { result: { thread: { id: string } } };
          expect(initialized).toMatchObject({
            result: {
              codexHome: expect.stringContaining(path.join(root, ".openclaw-worker", "codex")),
            },
          });
          const startedThreadId = started.result.thread.id;
          const completed = waitNotification("turn/completed");
          await expect(
            request(3, "turn/start", {
              threadId: startedThreadId,
              input: [{ type: "text", text: "Reply briefly.", text_elements: [] }],
            }),
          ).resolves.toHaveProperty("result");
          await expect(completed).resolves.toMatchObject({
            params: { threadId: startedThreadId, turn: { status: "completed" } },
          });
          expect(readSettled).toBe(false);
          await fs.writeFile(path.join(workspaceDir, "readiness-proof.txt"), "verified readiness");
          await expect(
            request(21, "openclaw/resources/settle", { status: "unknown" }),
          ).resolves.toMatchObject({ error: { code: -32001 } });
          expect(readSettled).toBe(false);
          await expect(
            request(22, "openclaw/resources/settle", { status: "ready" }),
          ).resolves.toMatchObject({ result: {} });
          await expect(
            request(23, "openclaw/resources/settle", { status: "ready" }),
          ).resolves.toMatchObject({ error: { code: -32001 } });
          await expect(pendingRead).resolves.toMatchObject({
            result: { dataBase64: Buffer.from("verified readiness").toString("base64") },
          });
          await expect(
            request(30, "command/exec", {
              command: [process.execPath, "-e", "process.stdout.write('worker-command-proof')"],
              cwd: workspaceDir,
            }),
          ).resolves.toMatchObject({ result: { stdout: "worker-command-proof", exitCode: 0 } });
          return startedThreadId;
        });
        expect(requests).toEqual([
          {
            authorization: "Bearer synthetic-worker-bearer",
            model: "codex-test-model",
          },
        ]);
        await runConnection(async (request, notify, waitNotification) => {
          await request(1, "initialize", buildCodexAppServerInitializeParams());
          await notify("initialized");
          await expect(request(2, "thread/resume", { threadId })).resolves.toMatchObject({
            result: { thread: { id: threadId } },
          });
          const read = request(20, "fs/readFile", {
            path: path.join(workspaceDir, "readiness-proof.txt"),
          });
          await expect(
            request(21, "openclaw/resources/settle", { status: "failed" }),
          ).resolves.toMatchObject({ result: {} });
          await expect(read).resolves.toMatchObject({ error: { code: -32001 } });
          await expect(
            request(22, "openclaw/resources/settle", { status: "ready" }),
          ).resolves.toMatchObject({ error: { code: -32001 } });
          const completed = waitNotification("turn/completed");
          await expect(
            request(23, "turn/start", {
              threadId,
              input: [{ type: "text", text: "Reply again.", text_elements: [] }],
            }),
          ).resolves.toHaveProperty("result");
          await expect(completed).resolves.toMatchObject({
            params: { threadId, turn: { status: "completed" } },
          });
        });
      },
    );
  }, 45_000);
});
