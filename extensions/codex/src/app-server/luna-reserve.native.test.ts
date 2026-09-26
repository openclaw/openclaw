import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

describe("supported native atomic turn settings (local backend, not Reserve account proof)", () => {
  it(
    "normalizes nulls, suppresses no-op settings events, and admits consecutive full turns",
    { timeout: 75_000 },
    async (context) => {
      const root = await fs.realpath(
        useAutoCleanupTempDirTracker(context.onTestFinished).make("codex-reserve-contract-"),
      );
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      context.onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const requests: JsonObject[] = [];
      const server = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests.push(JSON.parse(body));
          const events = [
            { type: "response.created", response: { id: "fixture-response" } },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "fixture-answer",
                content: [{ type: "output_text", text: "Synthetic answer." }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "fixture-response",
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ];
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            events
              .map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")
              .join(""),
          );
        });
      });
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
        throw new Error("No fixture address");
      }
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.4"',
          'model_provider="contract-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.contract-fixture]",
          'name="Local protocol fixture"',
          'base_url="http://127.0.0.1:' + address.port + '/v1"',
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      const env = Object.fromEntries(
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
          env,
          clearEnv: Object.keys(process.env).filter((key) => !(key in env)),
        },
        agentDir: path.join(root, "agent"),
        authProfileId: null,
        config: {},
        timeoutMs: 20_000,
      });
      context.onTestFinished(async () => {
        expect(await client.closeAndWait()).toMatchObject({ exited: true });
      });
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      const updates: JsonObject[] = [];
      let applied = 0;
      const completed = new Set<string>();
      client.addNotificationHandler((notification) => {
        if (notification.method === "codex/event/thread_settings_applied") {
          applied++;
        }
        if (
          notification.method === "thread/settings/updated" &&
          isJsonObject(notification.params)
        ) {
          updates.push(notification.params);
        }
        if (
          notification.method === "turn/completed" &&
          isJsonObject(notification.params) &&
          isJsonObject(notification.params.turn) &&
          typeof notification.params.turn.id === "string"
        ) {
          completed.add(notification.params.turn.id);
        }
      });
      const requestOptions = { timeoutMs: 20_000 };
      const started = await client.request<{ thread: { id: string } }>(
        "thread/start",
        {
          model: "gpt-5.4",
          modelProvider: "contract-fixture",
          cwd: native.cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
        },
        requestOptions,
      );
      const settings = {
        model: "gpt-5.4",
        effort: "medium",
        serviceTier: null,
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-5.4", reasoning_effort: "medium", developer_instructions: null },
        },
      };
      await client.request(
        "thread/settings/update",
        { threadId: started.thread.id, ...settings },
        requestOptions,
      );
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      const accepted = updates[0]?.threadSettings;
      expect(accepted).toMatchObject({
        model: "gpt-5.4",
        effort: "medium",
        serviceTier: "default",
      });
      if (
        !isJsonObject(accepted) ||
        !isJsonObject(accepted.collaborationMode) ||
        !isJsonObject(accepted.collaborationMode.settings)
      ) {
        throw new Error("No native accepted settings");
      }
      expect(accepted.collaborationMode.settings.developer_instructions).toEqual(
        expect.any(String),
      );
      expect(accepted).not.toMatchObject(settings);
      await client.request(
        "thread/settings/update",
        { threadId: started.thread.id, ...settings },
        requestOptions,
      );
      // Completing a full turn is a native serialization barrier after the queued no-op.
      for (const text of ["first pending input", "same-settings continuation"]) {
        const turn = await client.request<{ turn: { id: string } }>(
          "turn/start",
          {
            threadId: started.thread.id,
            ...settings,
            input: [{ type: "text", text, text_elements: [] }],
          },
          requestOptions,
        );
        await vi.waitFor(() => expect(completed.has(turn.turn.id)).toBe(true), { timeout: 15_000 });
      }
      expect(updates).toHaveLength(1);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.model)).toEqual(["gpt-5.4", "gpt-5.4"]);
      expect(JSON.stringify(requests[0]?.input)).toContain("first pending input");
      expect(JSON.stringify(requests[1]?.input)).toContain("same-settings continuation");
      // Report only protocol facts; no real credentials or account eligibility are involved.
      console.log(
        JSON.stringify({
          binary: CODEX_APP_SERVER_VERSION,
          normalizedDefaultTier: true,
          builtInInstructions: true,
          settingsNotifications: updates.length,
          completedTurns: completed.size,
          backendRequests: requests.length,
          legacyAppliedEvents: applied,
        }),
      );
    },
  );
});
