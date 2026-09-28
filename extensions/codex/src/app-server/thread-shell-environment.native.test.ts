import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexEffectiveConfig } from "./config-layer-policy.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-lifecycle.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { mergeCodexNativeShellEnvironment } from "./thread-shell-environment.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.unstubAllEnvs();
});

// A loopback model selects commands; the pinned native binary owns shell execution.
// Explicit login remains valid with configured prefixes, including after resume.
// Snapshots can run login commands via -c, so assert lookup instead of argv shape.
describe.skipIf(process.platform === "win32")("native Codex tool PATH", () => {
  it.for([
    { configured: true, loginAllowed: true, snapshots: true, filters: false },
    { configured: false, loginAllowed: true, snapshots: true, filters: false },
    { configured: true, loginAllowed: false, snapshots: true, filters: false },
    { configured: true, loginAllowed: true, snapshots: false, filters: false },
    { configured: true, loginAllowed: true, snapshots: true, filters: true },
  ])(
    "executes fresh and cold-resumed commands with %j",
    { timeout: 90_000 },
    async ({ configured, loginAllowed, snapshots, filters }, context) => {
      const expectPrefix = configured && (snapshots || !loginAllowed);
      const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
      const root = await fs.realpath(tempDirs.make("codex-tool-path-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      vi.stubEnv("PATH", native.env.PATH);
      const requests: JsonObject[] = [];
      const failures: unknown[] = [];
      const server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          try {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            expect(request.headers.authorization).toBeUndefined();
            const parsed: unknown = JSON.parse(body);
            if (!isJsonObject(parsed)) {
              throw new Error("Expected a provider request object");
            }
            requests.push(parsed);
            const item =
              requests.length % 2 === 1
                ? {
                    type: "function_call",
                    call_id: `path-probe-${requests.length}`,
                    name: "exec_command",
                    arguments: JSON.stringify({
                      cmd: `${expectPrefix ? "tool-path-probe && native-path-probe && " : ""}if shopt -q login_shell; then echo LOGIN=yes; else echo LOGIN=no; fi`,
                      shell: "/bin/bash",
                      ...(loginAllowed ? { login: true } : {}),
                      max_output_tokens: 1000,
                    }),
                  }
                : {
                    type: "message",
                    role: "assistant",
                    id: `answer-${requests.length}`,
                    content: [{ type: "output_text", text: "Command checked." }],
                  };
            const events = [
              { type: "response.created", response: { id: `response-${requests.length}` } },
              { type: "response.output_item.done", item },
              {
                type: "response.completed",
                response: {
                  id: `response-${requests.length}`,
                  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                },
              },
            ];
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
              events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            );
          } catch (error) {
            failures.push(error);
            response.writeHead(500).end();
          }
        });
      });
      context.onTestFinished(async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback provider address");
      }
      const nativeBin = path.join(root, "native-bin");
      await fs.mkdir(nativeBin);
      await fs.writeFile(
        path.join(nativeBin, "native-path-probe"),
        "#!/bin/sh\necho NATIVE=preserved\n",
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.6-luna"',
          'model_provider="path-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          // This fixture tests lookup, not Linux namespace availability.
          'sandbox_mode="danger-full-access"',
          ...(!loginAllowed ? ["allow_login_shell=false"] : []),
          ...(configured
            ? [
                "[shell_environment_policy.set]",
                `PATH=${JSON.stringify([nativeBin, "/usr/bin", "/bin"].join(path.delimiter))}`,
                'KEEP="preserved"',
              ]
            : []),
          ...(filters
            ? [
                "[shell_environment_policy.filters]",
                'path="exclude"',
                'KEEP="include"',
                '"UNRELATED_*"="exclude"',
              ]
            : []),
          "[features]",
          "code_mode=false",
          ...(!snapshots ? ["shell_snapshot=false"] : []),
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.path-fixture]",
          'name="Synthetic PATH provider"',
          `base_url="http://127.0.0.1:${address.port}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const appServer = {
        ...createAppServerOptions(),
        sandbox: "danger-full-access" as const,
        start: {
          transport: "stdio" as const,
          command: native.command,
          commandSource: "config" as const,
          args: ["app-server"],
          cwd: native.cwd,
          headers: {},
          env: childEnv,
          clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
        },
      };
      let threadId: string | undefined;
      for (const phase of ["fresh", "resumed"]) {
        const bin = path.join(root, phase);
        await fs.mkdir(bin);
        await fs.writeFile(
          path.join(bin, "tool-path-probe"),
          `#!/bin/sh\necho SELECTED=${phase}\n`,
          { mode: 0o755 },
        );
        const host = await createAdmittedHostCapabilityTestFixture({
          runId: `native-path-${phase}`,
          agentId: "main",
          sessionKey: "agent:main:native-path",
          config: configured ? { tools: { exec: { pathPrepend: [bin] } } } : {},
        });
        context.onTestFinished(() => {
          host.closeHost();
          host.closeAdmission();
        });
        const client = await createIsolatedCodexAppServerClient({
          startOptions: appServer.start,
          agentDir: path.join(root, "agent"),
          authProfileId: null,
          config: {},
          timeoutMs: 20_000,
        });
        try {
          expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
          const params = createParams(path.join(root, "session.jsonl"), native.cwd);
          const prepared = host.hostCapabilities.preparedEnvironment?.();
          const shellEnvironment = prepared?.localToolEnv;
          const effective = await readCodexEffectiveConfig(client, native.cwd, {
            timeoutMs: 20_000,
          });
          const options = {
            appServer,
            shellEnvironment,
            shellPathPrepend: prepared?.localToolPathPrepend,
            config: shellEnvironment
              ? mergeCodexNativeShellEnvironment(
                  undefined,
                  effective.config.shell_environment_policy,
                )
              : undefined,
            disableLoginShell: false,
            modelProvider: "path-fixture",
            model: "gpt-5.6-luna",
            nativeCodeModeEnabled: true,
          };
          if (threadId) {
            const resumed = await client.request(
              "thread/resume",
              buildThreadResumeParams(params, { ...options, threadId }),
              { timeoutMs: 20_000 },
            );
            expect(resumed.thread.id).toBe(threadId);
          } else {
            const started = await client.request(
              "thread/start",
              buildThreadStartParams(params, { ...options, cwd: native.cwd, dynamicTools: [] }),
              { timeoutMs: 20_000 },
            );
            threadId = started.thread.id;
          }
          const completed = createDeferred<unknown>();
          void completed.promise.catch(() => undefined);
          const timer = setTimeout(
            () => completed.reject(new Error("Native PATH command timed out")),
            30_000,
          );
          timer.unref();
          const remove = client.addNotificationHandler((notification) => {
            if (
              notification.method === "turn/completed" &&
              isJsonObject(notification.params) &&
              notification.params.threadId === threadId
            ) {
              completed.resolve(notification.params.turn);
            }
          });
          try {
            await client.request(
              "turn/start",
              {
                threadId,
                input: [
                  { type: "text", text: "Check command lookup and login mode.", text_elements: [] },
                ],
              },
              { timeoutMs: 20_000 },
            );
            await expect(completed.promise).resolves.toMatchObject({ status: "completed" });
          } finally {
            clearTimeout(timer);
            remove();
          }
          expect(failures).toEqual([]);
          const input = requests.at(-1)?.input;
          expect(Array.isArray(input)).toBe(true);
          const outputs = (Array.isArray(input) ? input : []).filter(
            (item) => isJsonObject(item) && item.type === "function_call_output",
          );
          const output = outputs.at(-1);
          expect(output).toMatchObject({
            output: expect.stringContaining("Process exited with code 0"),
          });
          if (expectPrefix) {
            expect(output).toMatchObject({ output: expect.stringContaining(`SELECTED=${phase}`) });
            expect(output).toMatchObject({ output: expect.stringContaining("NATIVE=preserved") });
          }
          if (!loginAllowed || !snapshots) {
            expect(output).toMatchObject({
              output: expect.stringContaining(`LOGIN=${loginAllowed ? "yes" : "no"}`),
            });
          }
        } finally {
          host.closeHost();
          host.closeAdmission();
          expect(await client.closeAndWait()).toMatchObject({ exited: true });
        }
      }
      expect(requests).toHaveLength(4);
    },
  );
});
