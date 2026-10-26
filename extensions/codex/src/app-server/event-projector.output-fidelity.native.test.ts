import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { requireArray, requireRecord } from "./event-projector.test-harness.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  runNativeTurn,
  sendNativeResponse,
} from "./thread-native.test-support.js";

vi.unmock("node:child_process");
afterEach(() => vi.unstubAllEnvs());

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
    const source = " \n" + "source transcript line\n".repeat(2_000).slice(0, 34_762) + "\n ";
    await fs.writeFile(path.join(native.cwd, "source.txt"), source);

    const callId = "read-source";
    const requests: JsonObject[] = [];
    const failures: unknown[] = [];
    const port = await listenForNativeResponses(context, (request, response) => {
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
          sendNativeResponse(response, `response-${requests.length}`, item);
        } catch (error) {
          failures.push(error);
          response.writeHead(500).end();
        }
      })();
    });
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      nativeProviderConfig(
        "output-fidelity-fixture",
        port,
        // Output fidelity, not sandboxing; preserve the explicit history budget.
        [
          'sandbox_mode="danger-full-access"',
          "allow_login_shell=false",
          "tool_output_token_limit=24000",
        ],
        ["shell_snapshot=false", "code_mode=false"],
      ),
    );
    const client = await createIsolatedCodexAppServerClient({
      startOptions: nativeAppServerOptions(native).start,
      agentDir: path.join(root, "agent"),
      authProfileId: null,
      config: {},
      timeoutMs: 20_000,
    });
    context.onTestFinished(async () =>
      expect(await client.closeAndWait()).toMatchObject({ exited: true }),
    );
    const started = await client.request(
      "thread/start",
      { cwd: native.cwd, dynamicTools: [], experimentalRawEvents: true },
      { timeoutMs: 20_000 },
    );
    const threadId = started.thread.id;
    const notifications: CodexServerNotification[] = [];
    const removeHandler = client.addNotificationHandler((notification) => {
      if (!isJsonObject(notification.params) || notification.params.threadId !== threadId) {
        return;
      }
      notifications.push(notification);
    });
    context.onTestFinished(removeHandler);
    await expect(
      runNativeTurn(client, threadId, "Read source.txt.", {
        completionTimeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({ status: "completed" });
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
  },
);
