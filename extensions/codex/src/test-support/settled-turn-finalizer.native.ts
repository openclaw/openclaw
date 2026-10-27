import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
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
type NativePhase =
  | "probe"
  | "action"
  | "side"
  | "hold"
  | "overload"
  | "summary"
  | "health"
  | "patch";

function event(type: string, fields: JsonObject) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

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
  const marker = path.join(native.cwd, "completed-actions.txt");
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
  const respond = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      const body = (await buffer(request)).toString("utf8");
      // A 426 selects HTTP immediately instead of retrying this SSE-only fixture.
      if (request.url === "/v1/responses" && request.method === "GET") {
        response.writeHead(426).end();
        return;
      }
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
      const actionPhase = phase === "action" || phase === "side";
      if (actionPhase) {
        actionRequests += 1;
      }
      const send = (output: string) =>
        response.writeHead(200, { "Content-Type": "text/event-stream" }).end(output);
      if (live && liveProvider && phase !== "hold" && phase !== "overload") {
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
          expect(await fs.readFile(marker, "utf8")).toBe("completed-once\n");
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
          send(await upstream.text());
          return;
        }
      }
      let item: JsonObject | undefined;
      if (!live && phase !== "hold" && phase !== "overload") {
        if (phase === "patch" && requests.length === 1) {
          item = {
            type: "custom_tool_call",
            call_id: "denied-patch",
            name: "apply_patch",
            input: `*** Begin Patch\n*** Update File: ${marker}\n@@\n-completed-once\n+repeated-action\n*** End Patch`,
          };
        } else if (actionRequests === 1 && actionPhase) {
          item = {
            type: "function_call",
            call_id: "completed-action",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "printf 'completed-once\\n' >> completed-actions.txt; cat completed-actions.txt",
              shell: "/bin/sh",
              login: false,
              max_output_tokens: 1000,
            }),
          };
        } else if (phase !== "action") {
          const output = phase === "summary" || phase === "side" ? SUMMARY : "Ready.";
          item = {
            type: "message",
            role: "assistant",
            id: `answer-${requests.length}`,
            content: [{ type: "output_text", text: output }],
          };
        }
      }
      const id = `response-${requests.length}`;
      const created = event("response.created", { response: { id } });
      if (phase === "hold") {
        response.writeHead(200, { "Content-Type": "text/event-stream" }).write(created);
        return;
      }
      const terminal: JsonObject =
        phase === "overload"
          ? {
              id,
              status: "failed",
              error: { code: "server_is_overloaded", message: "Synthetic provider overload." },
            }
          : { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
      send(
        created +
          (item ? event("response.output_item.done", { item }) : "") +
          event(phase === "overload" ? "response.failed" : "response.completed", {
            response: terminal,
          }),
      );
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  };
  const server = http.createServer((request, response) => {
    void respond(request, response);
  });
  cleanups.push(async () => {
    upstreamAbort.abort();
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}/v1`;
  const authProfileStore: AuthProfileStore = {
    version: 1,
    profiles: {
      [HOST_PROFILE]: { type: "api_key", provider: "openai", key: HOST_KEY },
      [OTHER_PROFILE]: { type: "api_key", provider: "openai", key: NATIVE_KEY },
    },
  };
  return {
    native,
    root,
    agentDir: path.join(root, "agent"),
    baseUrl,
    pluginConfig: {
      supervision: { enabled: true },
      appServer: {
        command: native.command,
        args: ["app-server", "-c", `openai_base_url=${JSON.stringify(baseUrl)}`],
        homeScope: "user" as const,
      },
    },
    authProfileStore,
    requests,
    livePhases,
    injectedEmptyTerminals: () => emptyTerminalInjections,
    marker,
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
  const failures: unknown[] = [];
  const cleanups: Cleanup[] = [
    async () => run(await createNativeFixture(root, cleanups, failures, live), cleanups),
  ];
  // Run the fixture first, then join its children in LIFO order before their homes are removed.
  for (let action = cleanups.pop(); action; action = cleanups.pop()) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Native finalization proof or cleanup failed");
  }
}
