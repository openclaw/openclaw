import { once } from "node:events";
import http from "node:http";
import { promisify } from "node:util";
import type { TestContext } from "vitest";
import type { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { createAppServerOptions } from "./thread-lifecycle.test-fixtures.js";

export async function listenForNativeResponses(
  context: Pick<TestContext, "onTestFinished">,
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
  const options = createAppServerOptions();
  return {
    ...options,
    start: {
      ...options.start,
      command: native.command,
      commandSource: "config" as const,
      cwd: native.cwd,
      env,
      clearEnv: Object.keys(process.env).filter((key) => !(key in env)),
    },
  };
}
