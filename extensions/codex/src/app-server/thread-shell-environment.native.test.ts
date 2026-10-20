import fs from "node:fs/promises";
import path from "node:path";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexEffectiveConfig } from "./config-layer-policy.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  runNativeTurn,
  sendNativeResponse,
} from "./thread-native.test-support.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";
import { mergeCodexNativeShellEnvironment } from "./thread-shell-environment.js";
import { withCodexAppServerGitConfig } from "./transport-stdio.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.unstubAllEnvs();
});

// The loopback model selects commands; the pinned binary owns shell execution.
// Snapshots can run login commands via -c, so assert lookup instead of argv shape.
describe.skipIf(process.platform === "win32")("native Codex tool PATH", () => {
  it.for([
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
      const port = await listenForNativeResponses(context, (request, response) => {
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
                      cmd: `${expectPrefix ? "tool-path-probe && native-path-probe && " : ""}if shopt -q login_shell; then echo LOGIN=yes; else echo LOGIN=no; fi; printf 'GIT_NAME='; git config --get user.name || printf '\\n'; git config --get maintenance.auto; git config --get gc.auto`,
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
            sendNativeResponse(response, `response-${requests.length}`, item);
          } catch (error) {
            failures.push(error);
            response.writeHead(500).end();
          }
        });
      });
      const nativeBin = path.join(root, "native-bin");
      await fs.mkdir(nativeBin);
      await fs.writeFile(
        path.join(nativeBin, "native-path-probe"),
        "#!/bin/sh\necho NATIVE=preserved\n",
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        nativeProviderConfig(
          "path-fixture",
          port,
          [
            // This fixture tests lookup, not Linux namespace availability.
            'sandbox_mode="danger-full-access"',
            ...(!loginAllowed ? ["allow_login_shell=false"] : []),
            ...(configured
              ? [
                  "[shell_environment_policy.set]",
                  `PATH=${JSON.stringify([nativeBin, "/usr/bin", "/bin"].join(path.delimiter))}`,
                  'KEEP="preserved"',
                  `GIT_CONFIG_PARAMETERS=${JSON.stringify("'user.name=Native Git'")}`,
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
          ],
          ["code_mode=false", ...(!snapshots ? ["shell_snapshot=false"] : [])],
        ),
      );
      const appServer = {
        ...nativeAppServerOptions(native, { GIT_CONFIG_PARAMETERS: "'user.name=Inherited Git'" }),
        sandbox: "danger-full-access" as const,
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
        const prepared = host.hostCapabilities.preparedEnvironment?.();
        const shellGitConfigParameters = prepared?.localGitConfigParameters;
        if (!shellGitConfigParameters) {
          throw new Error("Expected host Git configuration policy");
        }
        const phaseAppServer = {
          ...appServer,
          start: withCodexAppServerGitConfig(appServer.start, shellGitConfigParameters),
        };
        const client = await createIsolatedCodexAppServerClient({
          startOptions: phaseAppServer.start,
          agentDir: path.join(root, "agent"),
          authProfileId: null,
          config: {},
          timeoutMs: 20_000,
        });
        try {
          expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
          const params = createParams(path.join(root, "session.jsonl"), native.cwd);
          const shellEnvironment = prepared?.localToolEnv;
          const effective = await readCodexEffectiveConfig(client, native.cwd, {
            timeoutMs: 20_000,
          });
          const options = {
            appServer: phaseAppServer,
            shellEnvironment,
            shellGitConfigParameters,
            shellPathPrepend: prepared?.localToolPathPrepend,
            config:
              shellEnvironment || shellGitConfigParameters
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
              await buildThreadResumeParams(params, { ...options, threadId }),
              { timeoutMs: 20_000 },
            );
            expect(resumed.thread.id).toBe(threadId);
          } else {
            const started = await client.request(
              "thread/start",
              await buildThreadStartParams(params, {
                ...options,
                cwd: native.cwd,
                dynamicTools: [],
              }),
              { timeoutMs: 20_000 },
            );
            threadId = started.thread.id;
          }
          await expect(
            runNativeTurn(client, threadId, "Check command lookup and login mode.", {
              timeoutMs: 20_000,
              completionTimeoutMs: 30_000,
            }),
          ).resolves.toMatchObject({ status: "completed" });
          expect(failures).toEqual([]);
          const input = requests.at(-1)?.input;
          expect(Array.isArray(input)).toBe(true);
          const outputs = (Array.isArray(input) ? input : []).filter(
            (item) => isJsonObject(item) && item.type === "function_call_output",
          );
          const output = outputs.at(-1);
          for (const text of [
            "Process exited with code 0",
            `GIT_NAME=${filters ? "" : configured ? "Native Git" : "Inherited Git"}\nfalse\n0`,
            ...(expectPrefix ? [`SELECTED=${phase}`, "NATIVE=preserved"] : []),
            ...(!loginAllowed || !snapshots ? [`LOGIN=${loginAllowed ? "yes" : "no"}`] : []),
          ]) {
            expect(output).toMatchObject({ output: expect.stringContaining(text) });
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
