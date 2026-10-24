import { once } from "node:events";
import http from "node:http";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { TestContext } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { createAppServerOptions } from "./thread-lifecycle.test-fixtures.js";

export async function runNativeTurn(
  client: CodexAppServerClient,
  threadId: string,
  text: string,
  options: { timeoutMs?: number; completionTimeoutMs?: number } = {},
) {
  const completed = createDeferred<unknown>();
  void completed.promise.catch(() => undefined);
  const timer =
    options.completionTimeoutMs === undefined
      ? undefined
      : setTimeout(
          () => completed.reject(new Error("Native PATH command timed out")),
          options.completionTimeoutMs,
        );
  timer?.unref();
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
        input: [{ type: "text", text, text_elements: [] }],
      },
      { timeoutMs: options.timeoutMs },
    );
    return await completed.promise;
  } finally {
    clearTimeout(timer);
    remove();
  }
}

export async function listenForNativeResponses(
  context: TestContext,
  listener: http.RequestListener,
) {
  const server = http.createServer(listener);
  context.onTestFinished(async () => {
    server.closeAllConnections();
    if (server.listening) {
      await promisify(server.close.bind(server))();
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback provider address");
  }
  return address.port;
}

export function sendNativeResponse(response: http.ServerResponse, id: string, item: unknown) {
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

export function nativeProviderConfig(
  provider: string,
  port: number,
  settings: string[],
  features: string[],
) {
  return [
    'model="gpt-5.6-luna"',
    `model_provider="${provider}"`,
    'cli_auth_credentials_store="ephemeral"',
    'web_search="disabled"',
    'approval_policy="never"',
    ...settings,
    "[features]",
    ...features,
    ["[analytics]", "enabled=false", "[feedback]", "enabled=false"].join("\n"),
    `[model_providers.${provider}]`,
    `name="Synthetic ${provider} provider"`,
    `base_url="http://127.0.0.1:${port}/v1"`,
    'wire_api="responses"',
    "requires_openai_auth=false",
    "supports_websockets=false",
    "request_max_retries=0",
    "stream_max_retries=0",
  ].join("\n");
}

export function nativeAppServerOptions(
  native: Awaited<ReturnType<typeof createCodexNativeTestState>>,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    ...Object.fromEntries(
      Object.entries(native.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...extraEnv,
  };
  return {
    ...createAppServerOptions(),
    start: {
      transport: "stdio" as const,
      command: native.command,
      commandSource: "config" as const,
      args: ["app-server"],
      cwd: native.cwd,
      headers: {},
      env,
      clearEnv: Object.keys(process.env).filter((key) => !(key in env)),
    },
  };
}
