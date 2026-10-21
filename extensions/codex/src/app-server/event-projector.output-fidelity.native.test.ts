import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  buildEmptyToolTelemetry,
  CodexAppServerEventProjector,
  createParams,
  registerCodexEventProjectorTestLifecycle,
  requireArray,
  requireRecord,
} from "./event-projector.test-harness.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
registerCodexEventProjectorTestLifecycle();

// Codex truncates history separately from raw events; compare the next HTTP request.
it(
  "preserves the complete native exec response through the next provider request",
  { timeout: 75_000 },
  async (context) => {
    const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
    const root = await fs.realpath(tempDirs.make("codex-output-fidelity-"));
    const native = await createCodexNativeTestState(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("HOME", native.env.HOME);
    vi.stubEnv("CODEX_HOME", native.codexHome);
    const prefix = " \nBEGIN SOURCE TRANSCRIPT\n";
    const suffix = "\nEND SOURCE TRANSCRIPT\n ";
    const source =
      prefix +
      "0123456789abcdef source transcript line\n"
        .repeat(1_000)
        .slice(0, 34_766 - prefix.length - suffix.length) +
      suffix;
    expect(source).toHaveLength(34_766);
    await fs.writeFile(path.join(native.cwd, "source.txt"), source);

    const callId = "read-source";
    const requests: JsonObject[] = [];
    const failures: unknown[] = [];
    const server = http.createServer((request, response) => {
      void (async () => {
        try {
          let body = "";
          request.setEncoding("utf8");
          for await (const chunk of request) {
            body += chunk;
          }
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
            requests.length === 1
              ? {
                  type: "function_call",
                  call_id: callId,
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: "cat source.txt",
                    shell: "/bin/sh",
                    login: false,
                    max_output_tokens: 24_000,
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: "answer",
                  content: [{ type: "output_text", text: "Source received." }],
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
      })();
    });
    context.onTestFinished(async () => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback provider address");
    }
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      [
        'model="output-fidelity-fixture"',
        'model_provider="output-fidelity-fixture"',
        'cli_auth_credentials_store="ephemeral"',
        'web_search="disabled"',
        'approval_policy="never"',
        // Namespace-restricted CI cannot run bubblewrap; this proves output, not sandboxing.
        'sandbox_mode="danger-full-access"',
        "allow_login_shell=false",
        // Synthetic models need an explicit history budget.
        "tool_output_token_limit=24000",
        "features={shell_snapshot=false,code_mode=false}",
        "analytics={enabled=false}",
        "feedback={enabled=false}",
        "[model_providers.output-fidelity-fixture]",
        'name="Synthetic output fidelity provider"',
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
    const client = await createIsolatedCodexAppServerClient({
      startOptions: {
        transport: "stdio",
        command: native.command,
        commandSource: "config",
        args: ["app-server"],
        cwd: native.cwd,
        headers: {},
        env: childEnv,
        clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
      },
      agentDir: path.join(root, "agent"),
      authProfileId: null,
      config: {},
      timeoutMs: 20_000,
    });
    context.onTestFinished(async () =>
      expect(await client.closeAndWait()).toMatchObject({ exited: true }),
    );
    expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
    const started = await client.request(
      "thread/start",
      { cwd: native.cwd, dynamicTools: [], experimentalRawEvents: true },
      { timeoutMs: 20_000 },
    );
    const threadId = started.thread.id;
    const notifications: CodexServerNotification[] = [];
    const completed = createDeferred<unknown>();
    void completed.promise.catch(() => undefined);
    const removeHandler = client.addNotificationHandler((notification) => {
      if (!isJsonObject(notification.params) || notification.params.threadId !== threadId) {
        return;
      }
      notifications.push(notification);
      if (notification.method === "turn/completed") {
        completed.resolve(notification.params.turn);
      }
    });
    context.onTestFinished(removeHandler);
    const timer = setTimeout(
      () => completed.reject(new Error("Native output fidelity turn timed out")),
      30_000,
    );
    timer.unref();
    context.onTestFinished(() => clearTimeout(timer));
    const turn = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Read source.txt.", text_elements: [] }],
    });
    await expect(completed.promise).resolves.toMatchObject({ status: "completed" });
    clearTimeout(timer);
    expect(failures).toEqual([]);
    expect(requests).toHaveLength(2);

    const items = (method: string) =>
      notifications
        .filter((notification) => notification.method === method)
        .map(({ params }) => requireRecord(requireRecord(params, method).item, method));
    const rawResult = requireRecord(
      items("rawResponseItem/completed").find(
        (item) => item.type === "function_call_output" && item.call_id === callId,
      ),
      "native function result",
    );
    const output = rawResult.output;
    if (typeof output !== "string") {
      throw new Error("Expected native exec response text");
    }
    const command = requireRecord(
      items("item/completed").find(
        (item) => item.type === "commandExecution" && item.id === callId,
      ),
      "native command execution",
    );
    // Late-subscriber completion aggregates can be null; compare buffered output below.
    expect(command).toMatchObject({ status: "completed", exitCode: 0 });
    expect(output).not.toBe(source);
    expect(output).toContain("Process exited with code 0\n");
    expect(output).toContain("Output:\n");
    expect(output).toContain(source);
    expect(output).not.toContain("truncated");

    const nextInput = requireArray(requests[1]?.input, "next provider request input");
    const nextResult = requireRecord(
      nextInput.find(
        (item) =>
          isJsonObject(item) && item.type === "function_call_output" && item.call_id === callId,
      ),
      "result in actual next provider request",
    );
    // Equality applies to exec_command at this budget, not all history truncation.
    expect(nextResult.output).toBe(output);

    // Preserve native IDs and wire order instead of createProjector's synthetic IDs.
    const projector = new CodexAppServerEventProjector(
      { ...(await createParams()), workspaceDir: native.cwd },
      threadId,
      turn.turn.id,
    );
    for (const notification of notifications) {
      await projector.handleNotification(prepareCodexServerNotification(notification));
    }
    const results = projector
      .buildResult(buildEmptyToolTelemetry())
      .messagesSnapshot.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    const result = requireRecord(results[0], "projected result");
    expect(result).toMatchObject({
      toolCallId: callId,
      __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
    });
    expect(
      requireRecord(requireArray(result.content, "result content")[0], "text block").text,
    ).toBe(output);
  },
);
