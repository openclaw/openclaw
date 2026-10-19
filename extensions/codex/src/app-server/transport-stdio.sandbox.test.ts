import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { createStdioTransport } from "./transport-stdio.js";
import { buildTurnStartParams } from "./turn-params.js";
import { createCodexUserInputTestParams } from "./user-input-bridge.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

// This fixture replaces only model responses. Native turn processing, approvals,
// process execution, and the platform sandbox are not mocked.
describe.skipIf(process.platform !== "darwin")("native Codex turn sandbox", () => {
  it.for([
    {
      name: "raw true",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c=sandbox_workspace_write.exclude_slash_tmp=true",
        "app-server",
      ],
      excluded: true,
    },
    {
      name: "commented true",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true # exclusion retained",
        "app-server",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true # exclusion retained",
      ],
      excluded: true,
    },
    {
      name: "commented false wins last",
      args: [
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
        "app-server",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=false # explicit last value",
        "-c=sandbox_workspace_write.exclude_slash_tmp=false # explicit last value",
      ],
      excluded: false,
    },
  ])(
    "keeps temporary-root exclusions at the native execution boundary: $name",
    { timeout: 75_000 },
    async ({ args, excluded }, context) => {
      const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
      const root = tempDirs.make("codex-turn-sandbox-");
      const slashTmpRoot = await fs.realpath("/tmp");
      const slashTmp = tempDirs.make("codex-turn-denied-", slashTmpRoot);
      const { cwd, codexHome, tmp, command, env } = await createCodexNativeTestState(root);
      const targets = [
        path.join(cwd, "workspace.txt"),
        path.join(slashTmp, "slash-tmp.txt"),
        path.join(tmp, "tmpdir.txt"),
      ] as const;
      // All targets are writable by this account before native containment.
      for (const target of targets) {
        await fs.writeFile(target, "control");
        await fs.unlink(target);
      }
      let requestCount = 0;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          if (req.url !== "/v1/responses" || req.method !== "POST") {
            res.writeHead(404).end();
            return;
          }
          requestCount += 1;
          const script = targets
            .map(
              (target, index) =>
                `if printf proof > '${target}'; then printf 'write-${index}:ok\\n'; else printf 'write-${index}:denied\\n'; fi`,
            )
            .join("; ");
          const item =
            requestCount === 1
              ? {
                  type: "function_call",
                  call_id: "write-probe",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: script,
                    shell: "/bin/sh",
                    login: false,
                    max_output_tokens: 1000,
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: "done",
                  content: [{ type: "output_text", text: "Probe complete." }],
                };
          const events = [
            { type: "response.created", response: { id: `response-${requestCount}` } },
            { type: "response.output_item.done", item },
            {
              type: "response.completed",
              response: {
                id: `response-${requestCount}`,
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              },
            },
          ];
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        });
      });
      // Vitest deadlines do not unwind a stalled callback. Finish hooks own teardown
      // in reverse order: native child, provider server, then temporary directories.
      context.onTestFinished(async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Loopback fixture has no TCP address");
      }
      const config = [
        'model="gpt-5.6-luna"',
        'model_provider="loopback-fixture"',
        'sandbox_mode="workspace-write"',
        'approval_policy="on-request"',
        'approvals_reviewer="user"',
        'cli_auth_credentials_store="ephemeral"',
        'web_search="disabled"',
        "allow_login_shell=false",
        "[features]",
        "respect_system_proxy=false",
        "shell_snapshot=false",
        "code_mode=false",
        "code_mode_only=false",
        "[analytics]",
        "enabled=false",
        "[feedback]",
        "enabled=false",
        "[model_providers.loopback-fixture]",
        'name="Loopback test fixture"',
        `base_url="http://127.0.0.1:${address.port}/v1"`,
        'wire_api="responses"',
        "requires_openai_auth=false",
        "supports_websockets=false",
      ].join("\n");
      await fs.writeFile(path.join(codexHome, "config.toml"), config);
      const child = await createStdioTransport(
        { transport: "stdio", command, commandSource: "config", args, cwd, headers: {} },
        { ...env, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
      );
      const client = CodexAppServerClient.fromTransportForTests(child);
      context.onTestFinished(async () => {
        expect(await client.closeAndWait()).toMatchObject({ exited: true });
      });
      let approvals = 0;
      let commandOutput = "";
      const { promise: completed, resolve: finishTurn } = createDeferred<unknown>();
      client.addRequestHandler(({ method }) => {
        approvals += 1;
        return method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : { decision: "decline" };
      });
      client.addNotificationHandler((message) => {
        const params = message.params;
        if (!isJsonObject(params)) {
          return;
        }
        if (
          message.method === "item/completed" &&
          isJsonObject(params.item) &&
          params.item.type === "commandExecution"
        ) {
          commandOutput += params.item.aggregatedOutput ?? "";
        } else if (message.method === "turn/completed") {
          finishTurn(params.turn);
        }
      });
      const initialized = await client.request("initialize", {
        clientInfo: { name: "openclaw_sandbox_test", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      expect(initialized).toMatchObject({
        userAgent: expect.stringContaining(`/${CODEX_APP_SERVER_VERSION} `),
      });
      client.notify("initialized", {});
      const thread = await client.request("thread/start", {
        cwd,
        model: "gpt-5.6-luna",
        modelProvider: "loopback-fixture",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        ephemeral: true,
      });
      expect(thread.sandbox).toMatchObject({
        type: "workspaceWrite",
        excludeTmpdirEnvVar: excluded,
        excludeSlashTmp: excluded,
      });
      const appServer = resolveCodexAppServerRuntimeOptions({
        env: {},
        codexConfigToml: null,
        requirementsToml: null,
        pluginConfig: {
          appServer: {
            command,
            args,
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
          },
        },
      });
      const params = createCodexUserInputTestParams();
      params.prompt = "Run the deterministic sandbox write probe.";
      params.hostCapabilities = createCodexTestHostCapabilities();
      const turn = await buildTurnStartParams(params, {
        threadId: thread.thread.id,
        cwd,
        appServer,
        preserveNativeTurnSettings: true,
      });
      await client.request("turn/start", turn);
      expect(await completed).toMatchObject({ status: "completed" });
      expect(approvals).toBe(0);
      expect(requestCount).toBe(2);
      if (excluded) {
        expect(commandOutput).toMatch(/Operation not permitted|Permission denied/);
      }
      for (const [index, target] of targets.entries()) {
        const writable = index === 0 || !excluded;
        expect(commandOutput).toContain(`write-${index}:${writable ? "ok" : "denied"}`);
        if (writable) {
          expect(await fs.readFile(target, "utf8")).toBe("proof");
        } else {
          await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      await expect(fs.access(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
