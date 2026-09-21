import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, vi } from "vitest";
import { createCodexNativeTestState } from "../app-server/native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "../app-server/protocol.js";

export const NATIVE_MODEL = "gpt-5.6-sol";
export const HOST_MODEL = "gpt-5.6-terra";
export const NATIVE_KEY = "synthetic-native-account";
export const HOST_KEY = "synthetic-host-account";
export const HOST_PROFILE = "openai:host-fixture";
export const OTHER_PROFILE = "openai:other-fixture";
export const SUMMARY = "The action completed once.";
export const LIVE = process.env.OPENCLAW_LIVE_CODEX_SETTLED_FINALIZATION === "1";
// The shared hooks scrub provider credentials before each test. Only the proxy
// retains this key; native processes and their tools receive synthetic auth.
const liveProvider = LIVE
  ? {
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      url: `${(process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`,
    }
  : undefined;

export type NativeFixture = Awaited<ReturnType<typeof createNativeFixture>>;
export type Cleanup = () => Promise<void>;
type NativePhase = "probe" | "action" | "side" | "hold" | "summary" | "health";

async function createNativeFixture(
  requestedRoot: string,
  cleanups: Cleanup[],
  failures: unknown[],
  live = false,
) {
  if (live && !liveProvider?.apiKey) {
    throw new Error("Live settled-turn proof requires OPENAI_API_KEY");
  }
  const root = await fs.realpath(requestedRoot);
  const native = await createCodexNativeTestState(root);
  for (const [name, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  const requests: Array<{ body: JsonObject; account: string | undefined }> = [];
  let requestReceived = createDeferred<void>();
  let phase: NativePhase = "probe";
  let actionRequests = 0;
  const livePhases: NativePhase[] = [];
  let emptyTerminalInjections = 0;
  const upstreamAbort = new AbortController();
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    const respond = async () => {
      try {
        if (request.url !== "/v1/responses" || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        const parsed: unknown = JSON.parse(body);
        if (!isJsonObject(parsed)) {
          response.writeHead(400).end();
          return;
        }
        const account = request.headers.authorization;
        requests.push({ body: parsed, account });
        requestReceived.resolve();
        if (account !== `Bearer ${NATIVE_KEY}` && account !== `Bearer ${HOST_KEY}`) {
          response.writeHead(401).end();
          return;
        }
        if (parsed.model !== NATIVE_MODEL && parsed.model !== HOST_MODEL) {
          response.writeHead(400).end();
          return;
        }
        if (phase === "hold") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `response-${requests.length}` } })}\n\n`,
          );
          return;
        }
        if (phase === "action" || phase === "side") {
          actionRequests += 1;
        }
        if (live && liveProvider) {
          const settledAction =
            phase === "action" &&
            Array.isArray(parsed.input) &&
            parsed.input.some(
              (item) =>
                isJsonObject(item) &&
                (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
                typeof item.call_id === "string" &&
                (typeof item.output === "string"
                  ? item.output.includes("completed-once")
                  : Array.isArray(item.output) &&
                    item.output.some(
                      (content) =>
                        isJsonObject(content) &&
                        content.type === "input_text" &&
                        typeof content.text === "string" &&
                        content.text.includes("completed-once"),
                    )),
            );
          if (settledAction && emptyTerminalInjections === 0) {
            expect(await fs.readFile(path.join(native.cwd, "completed-actions.txt"), "utf8")).toBe(
              "completed-once\n",
            );
            emptyTerminalInjections += 1;
          } else {
            const upstream = await fetch(liveProvider.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${liveProvider.apiKey}`,
              },
              body,
              signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(120_000)]),
            });
            if (!upstream.ok) {
              throw new Error(`Live OpenAI request failed with HTTP ${upstream.status}`);
            }
            livePhases.push(phase);
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(await upstream.text());
            return;
          }
        }
        const item = live
          ? undefined
          : phase === "action" || (phase === "side" && actionRequests === 1)
            ? actionRequests === 1
              ? {
                  type: "function_call",
                  call_id: "completed-action",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: "printf 'completed-once\\n' >> completed-actions.txt; cat completed-actions.txt",
                    shell: "/bin/sh",
                    login: false,
                    max_output_tokens: 1000,
                  }),
                }
              : undefined
            : {
                type: "message",
                role: "assistant",
                id: `answer-${requests.length}`,
                content: [
                  {
                    type: "output_text",
                    text: phase === "summary" || phase === "side" ? SUMMARY : "Ready.",
                  },
                ],
              };
        const events = [
          { type: "response.created", response: { id: `response-${requests.length}` } },
          ...(item ? [{ type: "response.output_item.done", item }] : []),
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
    };
    request.on("end", () => {
      void respond();
    });
  });
  cleanups.push(async () => {
    upstreamAbort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
    throw new Error("Loopback provider has no TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const agentDir = path.join(root, "agent");
  const authProfileStore: AuthProfileStore = {
    version: 1,
    profiles: {
      [HOST_PROFILE]: { type: "api_key", provider: "openai", key: HOST_KEY },
      [OTHER_PROFILE]: { type: "api_key", provider: "openai", key: NATIVE_KEY },
    },
  };
  const pluginConfig = {
    supervision: { enabled: true },
    appServer: {
      command: native.command,
      args: ["app-server", "-c", `openai_base_url=${JSON.stringify(baseUrl)}`],
      homeScope: "user" as const,
    },
  };
  return {
    native,
    root,
    agentDir,
    baseUrl,
    pluginConfig,
    authProfileStore,
    requests,
    livePhases,
    injectedEmptyTerminals: () => emptyTerminalInjections,
    marker: path.join(native.cwd, "completed-actions.txt"),
    waitForRequest: () => requestReceived.promise,
    setPhase(next: NativePhase) {
      phase = next;
      requests.length = 0;
      requestReceived = createDeferred<void>();
      actionRequests = 0;
    },
  };
}

export async function withNativeFixture(
  root: string,
  run: (fixture: NativeFixture, cleanups: Cleanup[]) => Promise<void>,
  live = false,
): Promise<void> {
  const cleanups: Cleanup[] = [];
  const failures: unknown[] = [];
  try {
    await run(await createNativeFixture(root, cleanups, failures, live), cleanups);
  } catch (error) {
    failures.push(error);
  } finally {
    // Join children before the shared harness afterEach removes their homes.
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Native finalization proof or cleanup failed");
  }
}
