import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi, type MockInstance } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createNativeRunParams,
  createRuntimeDynamicTool,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

async function writeCodexFixtureConfig(options: {
  root: string;
  codexHome: string;
  modelId: string;
  port: number;
  contextWindow: number;
}): Promise<void> {
  const catalogPath = path.join(options.root, "models.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      models: [
        {
          slug: options.modelId,
          display_name: "Synthetic yield carrier model",
          supported_reasoning_levels: [],
          shell_type: "local",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          support_verbosity: false,
          truncation_policy: { mode: "bytes", limit: 10000 },
          experimental_supported_tools: [],
          context_window: options.contextWindow,
          model_messages: {
            instructions_template: "You are a test assistant.",
            collaboration_modes: { default: "Synthetic model-owned Default policy." },
          },
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(options.codexHome, "config.toml"),
    [
      `model=${JSON.stringify(options.modelId)}`,
      'model_provider="yield-fixture"',
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      "[model_providers.yield-fixture]",
      'name="Synthetic yield provider"',
      `base_url="http://127.0.0.1:${options.port}/v1"`,
      'wire_api="responses"',
      "requires_openai_auth=false",
      "supports_websockets=false",
      "request_max_retries=0",
      "stream_max_retries=0",
    ].join("\n"),
  );
}

// Exercises real native dispatch/history and production terminal interruption.
// The host supplies an eligible yield; child-claim admission is a separate proof.
it("records native yield output before terminal interruption", async () => {
  const root = await fs.realpath(tempDir);
  const native = await createCodexNativeTestState(root);
  for (const [key, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    }
  }
  const modelId = "yield-receipt-fixture";
  const callId = "native-yield-call";
  let requests = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      // Hold subsequent inference open; only the production terminal-tool owner
      // may end the turn, not a synthetic provider final answer.
      if (++requests > 1) {
        return;
      }
      const item = {
        type: "function_call",
        id: "yield-item",
        call_id: callId,
        namespace: "openclaw_direct",
        name: "sessions_yield",
        arguments: "{}",
      };
      const events = [
        { type: "response.created", response: { id: "yield-response" } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "yield-response",
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          },
        },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    });
  });
  const claim = await acquireTestPortBlock({ offsets: [0] });
  let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing fixture address");
    }
    await writeCodexFixtureConfig({
      root,
      codexHome: native.codexHome,
      modelId,
      port: address.port,
      contextWindow: 200000,
    });
    const params = createNativeRunParams(path.join(root, "yield-session.jsonl"), native.cwd);
    await seedRunSessionOwnerForTest(params.sessionId, params.sessionKey!);
    params.modelId = modelId;
    params.model = { ...params.model, id: modelId };
    params.disableTools = false;
    params.trigger = "user";
    params.timeoutMs = 20000;
    setCodexTestModelSupportsTools(params, true);
    const execute = vi.fn();
    setCodexTestToolFactory(params, (options) => [
      {
        ...createRuntimeDynamicTool("sessions_yield"),
        catalogMode: "direct-only",
        execute: async () => {
          execute();
          await options?.onYield?.("Synthetic eligible yield");
          return {
            content: [{ type: "text", text: '{"status":"yielded"}' }],
            details: { status: "yielded" },
          };
        },
      },
    ]);
    const recordedOutput = vi.fn();
    let requestSpy: MockInstance<CodexAppServerClient["request"]> | undefined;
    const result = await runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          command: native.command,
          args: ["app-server"],
          homeScope: "user",
          sandbox: "read-only",
          approvalPolicy: "never",
        },
      },
      nativeHookRelay: { enabled: false },
      clientFactory: async (options) => {
        client = await createIsolatedCodexAppServerClient(options);
        requestSpy = vi.spyOn(client, "request");
        client.addNotificationHandler((notification) => {
          if (
            notification.method !== "rawResponseItem/completed" ||
            !isJsonObject(notification.params)
          ) {
            return;
          }
          const item = notification.params.item;
          if (
            isJsonObject(item) &&
            item.type === "function_call_output" &&
            item.call_id === callId
          ) {
            recordedOutput(item.output);
          }
        });
        return client;
      },
    });
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(execute).toHaveBeenCalledOnce();
    expect(recordedOutput).toHaveBeenCalledOnce();
    expect(JSON.stringify(recordedOutput.mock.calls[0])).toContain("yielded");
    expect(JSON.stringify(recordedOutput.mock.calls[0])).not.toContain("aborted by user");
    const interruptIndex =
      requestSpy?.mock.calls.findIndex(([method]) => method === "turn/interrupt") ?? -1;
    expect(interruptIndex).toBeGreaterThanOrEqual(0);
    expect(recordedOutput.mock.invocationCallOrder[0]).toBeLessThan(
      requestSpy!.mock.invocationCallOrder[interruptIndex]!,
    );
  } finally {
    try {
      if (client) {
        expect(await client.closeAndWait()).toMatchObject({ exited: true });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await claim.release();
    }
  }
}, 45000);
