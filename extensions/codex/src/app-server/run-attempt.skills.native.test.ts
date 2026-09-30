import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

const NATIVE_FIRST_CATALOG =
  "<available_skills><skill><name>alpha-native</name><description>Creation-time catalog.</description></skill></available_skills>";
const NATIVE_SECOND_CATALOG =
  "<available_skills><skill><name>bravo-native</name><description>Refreshed catalog.</description></skill></available_skills>";

/**
 * Serves the Responses wire for the real Codex binary and records every request
 * body. `usage.tokens` is mutable so a turn can report the context pressure that
 * drives Codex's own pre-sampling auto-compaction (codex-rs/core/src/session/turn.rs
 * run_pre_sampling_compact).
 */
async function startResponsesFixture(): Promise<{
  requests: JsonObject[];
  port: number;
  usage: { tokens: number };
  close: () => Promise<void>;
}> {
  const requests: JsonObject[] = [];
  const usage = { tokens: 10 };
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const parsed: unknown = JSON.parse(body);
      if (!isJsonObject(parsed)) {
        response.writeHead(400).end();
        return;
      }
      requests.push(parsed);
      const events = [
        { type: "response.created", response: { id: "skill-response" } },
        {
          type: "response.completed",
          response: {
            id: "skill-response",
            usage: {
              input_tokens: usage.tokens,
              output_tokens: 1,
              total_tokens: usage.tokens + 1,
            },
          },
        },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback provider address");
  }
  return {
    requests,
    port: address.port,
    usage,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Writes the synthetic model catalog and provider config. `contextWindow` sets
 * the auto-compaction budget: ModelInfo::auto_compact_token_limit is
 * `context_window * 9 / 10` (codex-rs/protocol/src/openai_models.rs).
 */
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
          display_name: "Synthetic skill carrier model",
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
      'model_provider="skill-fixture"',
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      "[model_providers.skill-fixture]",
      'name="Synthetic skill provider"',
      `base_url="http://127.0.0.1:${options.port}/v1"`,
      'wire_api="responses"',
      "requires_openai_auth=false",
      "supports_websockets=false",
      "request_max_retries=0",
      "stream_max_retries=0",
    ].join("\n"),
  );
}

function developerMessageText(request: JsonObject | undefined): string {
  const input = request?.input;
  if (!Array.isArray(input)) {
    return "";
  }
  return JSON.stringify(input.filter((item) => isJsonObject(item) && item.role === "developer"));
}

describe("native Codex skill delivery", () => {
  it("delivers the ordinary root catalog when model metadata owns collaboration instructions", async () => {
    const root = await fs.realpath(tempDir);
    const native = await createCodexNativeTestState(root);
    for (const [name, value] of Object.entries(native.env)) {
      if (value !== undefined) {
        vi.stubEnv(name, value);
      }
    }
    const fixture = await startResponsesFixture();
    const modelId = "skill-carrier-model";
    await writeCodexFixtureConfig({
      root,
      codexHome: native.codexHome,
      modelId,
      port: fixture.port,
      contextWindow: 200_000,
    });
    let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
    try {
      const params = createNativeRunParams(path.join(root, "session.jsonl"), native.cwd);
      params.modelId = modelId;
      params.model = { ...params.model, id: modelId };
      params.prompt = "What is the weather in Wilmington today?";
      params.trigger = "user";
      params.timeoutMs = 20_000;
      const otherSkills = Array.from(
        { length: 40 },
        (_, index) =>
          `<skill><name>synthetic-${index}</name><description>${"Unrelated task capability. ".repeat(8)}</description><location>/synthetic/${index}/SKILL.md</location></skill>`,
      ).join("");
      params.skillsSnapshot = {
        prompt: `<available_skills>${otherSkills}<skill><name>weather</name><description>Current weather and forecasts.</description><location>/synthetic/weather/SKILL.md</location></skill></available_skills>`,
        skills: [],
      };
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
          return client;
        },
      });
      expect(result.terminal).toEqual({ kind: "ok" });
      expect(fixture.requests).toHaveLength(1);
      const input = fixture.requests[0]?.input;
      expect(Array.isArray(input)).toBe(true);
      const developerMessages = Array.isArray(input)
        ? input.filter((item) => isJsonObject(item) && item.role === "developer")
        : [];
      const developerText = JSON.stringify(developerMessages);
      expect(developerText).toContain("Synthetic model-owned Default policy.");
      expect(developerText).toContain(params.skillsSnapshot.prompt);
    } finally {
      if (client) {
        expect(await client.closeAndWait()).toMatchObject({ exited: true });
      }
      await fixture.close();
    }
  }, 45_000);

  it("delivers and refreshes persona through an external WebSocket Harness", async () => {
    const root = await fs.realpath(tempDir);
    const native = await createCodexNativeTestState(root);
    for (const [name, value] of Object.entries(native.env)) {
      if (value !== undefined) {
        vi.stubEnv(name, value);
      }
    }
    const fixture = await startResponsesFixture();
    const modelId = "persona-carrier-model";
    await writeCodexFixtureConfig({
      root,
      codexHome: native.codexHome,
      modelId,
      port: fixture.port,
      contextWindow: 200_000,
    });
    // The OS assigns the port while the native listener owns it throughout.
    // An external client must not accidentally qualify for the stdio relay.
    const harness = spawn(native.command, ["app-server", "--listen", "ws://127.0.0.1:0"], {
      cwd: native.cwd,
      env: native.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        startupTimer = setTimeout(
          () => reject(new Error("Native WebSocket startup timed out")),
          15_000,
        );
        harness.once("error", reject);
        harness.once("exit", (code) =>
          reject(new Error(`Native WebSocket exited: ${code} ${stderr}`)),
        );
        harness.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          const match = stderr.match(/listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/);
          if (match?.[1]) {
            clearTimeout(startupTimer);
            resolve(match[1]);
          }
        });
      });
      const soulPath = path.join(native.cwd, "SOUL.md");
      const firstSoul = "SYNTHETIC_REMOTE_PERSONA_FIRST";
      const editedSoul = "SYNTHETIC_REMOTE_PERSONA_EDITED";
      const threadIds = new Set<string>();
      for (const [index, soul] of [firstSoul, editedSoul, undefined].entries()) {
        if (soul) {
          await fs.writeFile(soulPath, soul);
        } else {
          await fs.unlink(soulPath);
        }
        const params = createNativeRunParams(path.join(root, "remote-persona.jsonl"), native.cwd);
        params.disableTools = false;
        params.runId = `remote-persona-${index}`;
        params.modelId = modelId;
        params.model = { ...params.model, id: modelId };
        params.prompt = `Ordinary remote turn ${index}.`;
        params.trigger = "user";
        params.timeoutMs = 20_000;
        const result = await runCodexAppServerAttempt(params, {
          pluginConfig: {
            appServer: {
              transport: "websocket",
              url,
              sandbox: "read-only",
              approvalPolicy: "never",
            },
          },
          nativeHookRelay: { enabled: false },
          clientFactory: async (options) => {
            if (!client) {
              client = await createIsolatedCodexAppServerClient(options);
              client.addNotificationHandler((notification) => {
                if (notification.method === "turn/started" && isJsonObject(notification.params)) {
                  const threadId = notification.params.threadId;
                  if (typeof threadId === "string") {
                    threadIds.add(threadId);
                  }
                }
              });
            }
            return client;
          },
        });
        expect(result.terminal).toEqual({ kind: "ok" });
        const text = developerMessageText(fixture.requests.at(-1));
        expect(text).toContain("Synthetic model-owned Default policy.");
        if (soul) {
          expect(text).toContain(soul);
          if (index === 1) {
            expect(text.lastIndexOf(editedSoul)).toBeGreaterThan(text.lastIndexOf(firstSoul));
          }
        } else {
          // Resume replaces the current section; historical turns may still
          // contain old text, so inspect the latest policy handoff.
          const latestDeveloper = fixture.requests.at(-1)?.input;
          expect(Array.isArray(latestDeveloper)).toBe(true);
          const handoffs = Array.isArray(latestDeveloper)
            ? latestDeveloper.filter(
                (item) =>
                  isJsonObject(item) &&
                  item.role === "developer" &&
                  JSON.stringify(item).includes("complete current OpenClaw"),
              )
            : [];
          expect(handoffs.length).toBeGreaterThan(0);
          expect(JSON.stringify(handoffs.at(-1))).not.toContain(editedSoul);
          expect(JSON.stringify(handoffs.at(-1))).not.toContain(firstSoul);
        }
      }
      expect(threadIds.size).toBe(1);
    } finally {
      clearTimeout(startupTimer);
      if (client) {
        await client.closeAndWait();
      }
      if (harness.exitCode === null && harness.signalCode === null) {
        const closed = once(harness, "close");
        harness.kill("SIGTERM");
        await closed;
      }
      await fixture.close();
    }
  }, 90_000);

  it.each([
    {
      label: "an edited catalog",
      refreshed: NATIVE_SECOND_CATALOG,
      current: NATIVE_SECOND_CATALOG,
    },
    {
      label: "a withdrawn catalog",
      refreshed: undefined,
      current: "refreshable thread instructions are empty",
    },
  ])(
    "keeps $label visible to the model after native compaction rebuilds the incognito thread",
    async ({ refreshed, current }) => {
      const root = await fs.realpath(tempDir);
      const native = await createCodexNativeTestState(root);
      for (const [name, value] of Object.entries(native.env)) {
        if (value !== undefined) {
          vi.stubEnv(name, value);
        }
      }
      const fixture = await startResponsesFixture();
      const modelId = "skill-carrier-model";
      // auto_compact_token_limit resolves to 900, so a turn reporting 5_000
      // tokens forces the next turn to compact before it samples.
      const contextWindow = 1_000;
      const overAutoCompactLimitTokens = 5_000;
      await writeCodexFixtureConfig({
        root,
        codexHome: native.codexHome,
        modelId,
        port: fixture.port,
        contextWindow,
      });
      const sessionKey = `agent:main:dashboard:incognito-native-compaction-${refreshed ? "edit" : "removal"}`;
      await seedRunSessionOwnerForTest("session-1", sessionKey);
      const sessionFile = path.join(root, "incognito-compaction-session.jsonl");
      let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
      try {
        const runTurn = async (runId: string, catalog: string | undefined, prompt: string) => {
          const before = fixture.requests.length;
          const params = createNativeRunParams(sessionFile, native.cwd, sessionKey);
          // A native-tool-restricted turn always starts a transient thread, which
          // would replace the live incognito thread this regression depends on.
          params.disableTools = false;
          params.runId = runId;
          params.modelId = modelId;
          params.model = { ...params.model, id: modelId };
          params.prompt = prompt;
          params.trigger = "user";
          params.timeoutMs = 60_000;
          params.skillsSnapshot = catalog ? { prompt: catalog, skills: [] } : undefined;
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
              // One physical client across turns: an ephemeral thread has no
              // resume source, so reuse depends on this live subscription.
              client ??= await createIsolatedCodexAppServerClient(options);
              return client;
            },
          });
          expect(result.terminal).toEqual({ kind: "ok" });
          return fixture.requests.slice(before);
        };

        const [creationRequest] = await runTurn("run-1", NATIVE_FIRST_CATALOG, "first");
        expect(developerMessageText(creationRequest)).toContain(NATIVE_FIRST_CATALOG);

        fixture.usage.tokens = overAutoCompactLimitTokens;
        const [refreshRequest] = await runTurn("run-2", refreshed, "second");
        expect(developerMessageText(refreshRequest)).toContain(current);

        fixture.usage.tokens = 10;
        const compactionTurn = await runTurn("run-3", refreshed, "third");
        // Codex summarizes, then resumes the same turn against the rebuilt context.
        const summarizationIndex = compactionTurn.findIndex((request) =>
          JSON.stringify(request).includes("You are performing a CONTEXT CHECKPOINT COMPACTION."),
        );
        expect(summarizationIndex).toBeGreaterThanOrEqual(0);
        const continuationRequest = compactionTurn[summarizationIndex + 1];
        expect(continuationRequest).toBeDefined();
        // The rebuilt context restores the creation-time carrier and drops the
        // client-authored refresh, which is exactly the reversion under test.
        expect(developerMessageText(continuationRequest)).toContain(NATIVE_FIRST_CATALOG);
        expect(developerMessageText(continuationRequest)).not.toContain(current);

        const [restoredRequest] = await runTurn("run-4", refreshed, "fourth");
        const restored = developerMessageText(restoredRequest);
        expect(restored).toContain(current);
        // The creation-time catalog is immutable on an ephemeral thread, so the
        // proof is that the current catalog is the model's latest instruction.
        expect(restored.lastIndexOf(current)).toBeGreaterThan(
          restored.lastIndexOf(NATIVE_FIRST_CATALOG),
        );
      } finally {
        if (client) {
          await client.closeAndWait();
        }
        await fixture.close();
      }
    },
    180_000,
  );
});
