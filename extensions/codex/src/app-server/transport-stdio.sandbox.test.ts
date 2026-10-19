import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
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

const tmpdirExclusion = "sandbox_workspace_write.exclude_tmpdir_env_var";
const slashTmpExclusion = "sandbox_workspace_write.exclude_slash_tmp";
const sseEvent = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const policy = {
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
} as const;

// This fixture replaces only model responses. Native turn processing, approvals,
// process execution, and the platform sandbox are not mocked.
it.skipIf(process.platform !== "darwin").for<[string, boolean, string[]]>([
  ["raw true", true, [`-c${tmpdirExclusion}=true`, `-c=${slashTmpExclusion}=true`, "app-server"]],
  [
    "commented true",
    true,
    [
      `-c${tmpdirExclusion}=true # exclusion retained`,
      "app-server",
      `--config=${slashTmpExclusion}=true # exclusion retained`,
    ],
  ],
  [
    "commented false wins last",
    false,
    [
      `-c${tmpdirExclusion}=true`,
      `--config=${slashTmpExclusion}=true`,
      "app-server",
      "-c",
      `${tmpdirExclusion}=false # explicit last value`,
      `-c=${slashTmpExclusion}=false # explicit last value`,
    ],
  ],
])(
  "honors native temporary-root exclusions: %s",
  { timeout: 75_000 },
  async ([, excluded, args], context) => {
    const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
    const root = tempDirs.make("codex-turn-sandbox-");
    const slashTmp = tempDirs.make("codex-turn-denied-", await fs.realpath("/tmp"));
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
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const id = `response-${requestCount}`;
        res.end(
          [
            sseEvent("response.created", { response: { id } }),
            sseEvent("response.output_item.done", { item }),
            sseEvent("response.completed", {
              response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
            }),
          ].join(""),
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
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      "allow_login_shell=false",
      "features={respect_system_proxy=false,shell_snapshot=false,code_mode=false,code_mode_only=false}",
      "analytics={enabled=false}",
      "feedback={enabled=false}",
      `model_providers.loopback-fixture={name="Loopback test fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
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
    await client.initialize();
    expect(client.getRuntimeIdentity()?.userAgent).toContain(`/${CODEX_APP_SERVER_VERSION} `);
    const thread = await client.request("thread/start", {
      cwd,
      model: "gpt-5.6-luna",
      modelProvider: "loopback-fixture",
      ...policy,
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
        appServer: { command, args, ...policy },
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
