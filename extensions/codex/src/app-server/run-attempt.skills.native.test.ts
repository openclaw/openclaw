import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { initializeGlobalHookRunner, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createNativeRunParams,
  createParams as createManagedRunParams,
  createRuntimeDynamicTool,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { setAgentWorkspaceForTest } from "./run-attempt-workspace.test-support.js";
import {
  createIsolatedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

const relayUpstream = vi.hoisted(() => ({ bodies: [] as JsonObject[] }));
const RELAY_TOOL_CALLS = 5;
// The managed relay's upstream is the only synthetic hop: OpenAI-shaped SSE with five tool calls.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    async fetchWithSsrFGuard(args: Parameters<typeof actual.fetchWithSsrFGuard>[0]) {
      if (args.url !== "https://api.openai.com/v1/responses") {
        return actual.fetchWithSsrFGuard(args);
      }
      const body: unknown = await new Response(args.init?.body).json();
      assert(isJsonObject(body));
      relayUpstream.bodies.push(body);
      args.beforeRequest?.();
      const index = relayUpstream.bodies.length;
      const id = `relay-${index}`;
      const item =
        index <= RELAY_TOOL_CALLS
          ? {
              type: "function_call",
              id: `fc-${index}`,
              call_id: `call-${index}`,
              name: "update_plan",
              arguments: JSON.stringify({ plan: [{ step: `step ${index}`, status: "completed" }] }),
            }
          : {
              type: "message",
              role: "assistant",
              id: "relay-answer",
              content: [{ type: "output_text", text: "DONE" }],
            };
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        },
      ];
      return {
        response: new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
        release: async () => {},
      };
    },
  };
});

const NATIVE_FIRST_CATALOG =
  "<available_skills><skill><name>alpha-native</name><description>Creation-time catalog.</description></skill></available_skills>";

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

async function createNativeFixture(modelId: string, contextWindow = 200_000) {
  const root = await fs.realpath(tempDir);
  const native = await createCodexNativeTestState(root);
  for (const [name, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  const fixture = await startResponsesFixture();
  try {
    await writeCodexFixtureConfig({
      root,
      codexHome: native.codexHome,
      modelId,
      port: fixture.port,
      contextWindow,
    });
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const attemptOptions: Parameters<typeof runCodexAppServerAttempt>[1] = {
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
  };
  const createParams = (filename: string, sessionKey?: string) => {
    const params = createNativeRunParams(path.join(root, filename), native.cwd, sessionKey);
    params.modelId = modelId;
    params.model = { ...params.model, id: modelId };
    params.trigger = "user";
    params.timeoutMs = 20_000;
    return params;
  };
  return { native, fixture, attemptOptions, createParams };
}

describe("native Codex skill delivery", () => {
  it.each([
    {
      label: "neither question tool",
      restricted: true,
      askUser: false,
      defaultQuestions: false,
      nativeTool: false,
    },
    {
      label: "callable Ask User",
      restricted: false,
      askUser: true,
      defaultQuestions: false,
      nativeTool: false,
    },
    {
      label: "registered but Default-ineligible native questions",
      restricted: false,
      askUser: false,
      defaultQuestions: false,
      nativeTool: true,
    },
    {
      label: "Default-eligible native questions",
      restricted: false,
      askUser: true,
      defaultQuestions: true,
      nativeTool: true,
    },
  ])(
    "delivers skills and capability-aware collaboration for $label",
    async ({ restricted, askUser, defaultQuestions, nativeTool }) => {
      const { native, fixture, attemptOptions, createParams } =
        await createNativeFixture("skill-carrier-model");
      let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
      try {
        const params = createParams("session.jsonl");
        params.disableTools = restricted;
        if (!restricted) {
          setCodexTestModelSupportsTools(params, true);
        }
        setCodexTestToolFactory(params, () =>
          askUser ? [createRuntimeDynamicTool("ask_user")] : [],
        );
        await fs.appendFile(
          path.join(native.codexHome, "config.toml"),
          `\n[features]\ndefault_mode_request_user_input=${defaultQuestions}\n` +
            (restricted ? "[tools.experimental_request_user_input]\nenabled=false\n" : ""),
        );
        params.prompt = "What is the weather in Wilmington today?";
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
          ...attemptOptions,
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
        expect(developerText).not.toContain("Synthetic model-owned Default policy.");
        expect(developerText).not.toContain("# Collaboration Mode: Default");
        expect(developerText.includes("request_user_input")).toBe(defaultQuestions);
        const tools = JSON.stringify(fixture.requests[0]?.tools);
        expect(tools.includes('"name":"request_user_input"')).toBe(nativeTool);
        expect(JSON.stringify(fixture.requests[0]).includes("ask_user")).toBe(askUser);
        expect(developerText).toContain(params.skillsSnapshot.prompt);
      } finally {
        if (client) {
          expect(await client.closeAndWait()).toMatchObject({ exited: true });
        }
        await fixture.close();
      }
    },
    45_000,
  );

  it("delivers and refreshes persona through an external WebSocket Harness", async ({ signal }) => {
    const { native, fixture, createParams } = await createNativeFixture("persona-carrier-model");
    // The OS assigns the port while the native listener owns it throughout.
    // An external client must not accidentally qualify for the stdio relay.
    const harness = spawn(native.command, ["app-server", "--listen", "ws://127.0.0.1:0"], {
      cwd: native.cwd,
      env: native.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
    try {
      const listening = new Promise<string>((resolve, reject) => {
        let stderr = "";
        harness.once("error", reject);
        harness.once("exit", (code) =>
          reject(new Error(`Native WebSocket exited: ${code} ${stderr}`)),
        );
        harness.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          const match = stderr.match(/listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/);
          if (match?.[1]) {
            resolve(match[1]);
          }
        });
      });
      const url = await withinTest(listening, signal);
      const soulPath = path.join(native.cwd, "SOUL.md");
      const firstSoul = "SYNTHETIC_REMOTE_PERSONA_FIRST";
      const editedSoul = "SYNTHETIC_REMOTE_PERSONA_EDITED";
      const sharedUser = "SYNTHETIC_SHARED_USER";
      const personalUser = "SYNTHETIC_PERSONAL_USER";
      const personalPath = path.join(native.cwd, "users", "alice", "USER.md");
      await fs.writeFile(path.join(native.cwd, "USER.md"), sharedUser);
      registerInternalHook("agent:bootstrap", (event) => {
        // Supply the same authenticated-selection metadata as the personal loader.
        const context = event.context as {
          bootstrapFiles: Array<{
            name: string;
            path: string;
            content?: string;
            missing: boolean;
            personalUser?: true;
          }>;
        };
        context.bootstrapFiles.push({
          name: "USER.md",
          path: personalPath,
          content: personalUser,
          missing: false,
          personalUser: true,
        });
      });
      const threadIds = new Set<string>();
      for (const [index, soul] of [firstSoul, editedSoul, undefined].entries()) {
        if (soul) {
          await fs.writeFile(soulPath, soul);
        } else {
          await fs.unlink(soulPath);
        }
        const before = fixture.requests.length;
        const params = createParams("remote-persona.jsonl");
        params.disableTools = false;
        params.runId = `remote-persona-${index}`;
        params.prompt = `Ordinary remote turn ${index}.`;
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
        // No personal overlay may enter native history or configuration, both of
        // which can be inherited by native children (including full-history forks).
        expect(JSON.stringify(fixture.requests)).not.toContain(personalUser);
        expect(result.systemPromptReport?.injectedWorkspaceFiles).toContainEqual(
          expect.objectContaining({ path: personalPath, injectedChars: 0, truncated: false }),
        );
        expect(fixture.requests).toHaveLength(before + 1);
        const request = fixture.requests.at(-1);
        expect(developerMessageText(request)).not.toContain(
          "Synthetic model-owned Default policy.",
        );
        // Inspect the latest framed policy: historical messages may retain old persona.
        const input = request?.input;
        const policy = Array.isArray(input)
          ? input.findLast(
              (item) =>
                isJsonObject(item) &&
                item.role === "developer" &&
                JSON.stringify(item).includes("<thread_policy>"),
            )
          : undefined;
        expect(policy).toBeDefined();
        const text = JSON.stringify(policy);
        expect(text).toContain(sharedUser);
        expect(text).not.toContain("Synthetic model-owned Default policy.");
        expect(text).not.toContain("# Collaboration Mode: Default");
        expect(text).not.toContain("request_user_input");
        if (index > 0) {
          expect(text).toContain("All earlier collaboration-mode instructions are withdrawn");
        }
        if (soul) {
          expect(text).toContain(soul);
        } else {
          expect(text).not.toContain(editedSoul);
        }
        if (index > 0) {
          expect(text).not.toContain(firstSoul);
        }
      }
      expect(threadIds.size).toBe(1);
    } finally {
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
    { thread: "incognito", sessionKey: "agent:main:dashboard:incognito-native-compaction" },
    { thread: "persistent", sessionKey: "agent:main:native-compaction" },
  ])(
    "keeps a withdrawn catalog withdrawn after native compaction rebuilds the $thread thread",
    async ({ thread, sessionKey }) => {
      const incognito = thread === "incognito";
      const current = "refreshable thread instructions are empty";
      // auto_compact_token_limit resolves to 900, so a turn reporting 5_000
      // tokens forces the next turn to compact before it samples.
      const { fixture, attemptOptions, createParams } = await createNativeFixture(
        "skill-carrier-model",
        1_000,
      );
      const overAutoCompactLimitTokens = 5_000;
      await seedRunSessionOwnerForTest("session-1", sessionKey);
      let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
      try {
        const runTurn = async (runId: string, catalog: string | undefined, prompt: string) => {
          const before = fixture.requests.length;
          const params = createParams(`${thread}-compaction-session.jsonl`, sessionKey);
          // A native-tool-restricted turn always starts a transient thread, which
          // would replace the live incognito thread this regression depends on.
          params.disableTools = false;
          params.runId = runId;
          params.prompt = prompt;
          params.timeoutMs = 60_000;
          params.skillsSnapshot = catalog ? { prompt: catalog, skills: [] } : undefined;
          const result = await runCodexAppServerAttempt(params, {
            ...attemptOptions,
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
        const [refreshRequest] = await runTurn("run-2", undefined, "second");
        // An ephemeral thread has no resume source and takes a handoff; an idle persistent
        // thread cold-resumes, so its native configuration drops the catalog.
        if (incognito) {
          expect(developerMessageText(refreshRequest)).toContain(current);
        }

        fixture.usage.tokens = 10;
        const compactionTurn = await runTurn("run-3", undefined, "third");
        // Codex summarizes, then resumes the same turn against the rebuilt context.
        const summarizationIndex = compactionTurn.findIndex((request) =>
          JSON.stringify(request).includes("You are performing a CONTEXT CHECKPOINT COMPACTION."),
        );
        expect(summarizationIndex).toBeGreaterThanOrEqual(0);
        const continuationRequest = compactionTurn[summarizationIndex + 1];
        expect(continuationRequest).toBeDefined();
        const continuation = developerMessageText(continuationRequest);
        // The rebuilt context restores the native carrier and drops client-authored
        // handoffs: an ephemeral thread's creation catalog reverts for this request.
        if (incognito) {
          expect(continuation).toContain(NATIVE_FIRST_CATALOG);
          expect(continuation).not.toContain(current);
        } else {
          expect(continuation).not.toContain(NATIVE_FIRST_CATALOG);
        }
        expect(continuation).toContain("silence is not an answer or approval");
        expect(continuation).not.toContain("Synthetic model-owned Default policy.");
        expect(continuation).not.toContain("request_user_input");

        const [restoredRequest] = await runTurn("run-4", undefined, "fourth");
        const restored = developerMessageText(restoredRequest);
        if (incognito) {
          expect(restored).toContain(current);
          // The creation-time catalog is immutable on an ephemeral thread, so the
          // proof is that the current catalog is the model's latest instruction.
          expect(restored.lastIndexOf(current)).toBeGreaterThan(
            restored.lastIndexOf(NATIVE_FIRST_CATALOG),
          );
        } else {
          expect(restored).not.toContain(NATIVE_FIRST_CATALOG);
        }
      } finally {
        if (client) {
          await client.closeAndWait();
        }
        await fixture.close();
      }
    },
    180_000,
  );

  it("keeps managed skills in the cached native prefix across a multi-request turn", async () => {
    const native = await createCodexNativeTestState(path.join(tempDir, "relay-native"));
    const childEnv = Object.fromEntries(
      Object.entries(native.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    for (const [name, value] of Object.entries(native.env)) {
      if (name !== "PATH") {
        vi.stubEnv(name, value);
      }
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "relay-state"));
    await seedRunSessionOwnerForTest("session-1", "agent:main:session-1");
    relayUpstream.bodies = [];
    const skillMarker = "SYNTHETIC_STABLE_SKILL_MARKER";
    const turnMarker = "SYNTHETIC_TURN_PLUGIN_CONTEXT";
    let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
    let closeHost: (() => void) | undefined;
    try {
      // An OpenAI-named provider on the standard endpoint selects the managed relay.
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.6-luna"',
          'model_provider="relay-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "code_mode=false",
          "[model_providers.relay-fixture]",
          'name="OpenAI"',
          'base_url="https://api.openai.com/v1"',
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_prompt_build", handler: () => ({ appendSystemContext: turnMarker }) },
        ]),
      );
      const factory: CodexAppServerClientFactory = async (options) => {
        const startOptions = options?.startOptions;
        assert(startOptions?.commandSource === "managed");
        client ??= await createIsolatedCodexAppServerClient({
          ...options,
          startOptions: {
            ...startOptions,
            managedCommandOrder: "package-only",
            transport: "stdio",
            args: startOptions.args ?? ["app-server"],
            cwd: native.cwd,
            headers: {},
            env: childEnv,
            clearEnv: Object.keys(process.env).filter((name) => !(name in childEnv)),
          },
        });
        return client;
      };
      const params = createManagedRunParams(path.join(tempDir, "relay-session.jsonl"), native.cwd, {
        prompt: `Make ${RELAY_TOOL_CALLS} update_plan calls, then reply DONE.`,
      });
      params.modelId = "gpt-5.6-luna";
      params.model = { ...params.model, id: params.modelId, name: params.modelId };
      params.timeoutMs = 60_000;
      params.permissionMode = "full";
      params.skillsSnapshot = {
        prompt: `<available_skills><skill><name>weather</name><description>${skillMarker}</description><location>/synthetic/weather/SKILL.md</location></skill></available_skills>`,
        skills: [],
      };
      setCodexTestModelSupportsTools(params, true);
      setAgentWorkspaceForTest(params, native.cwd);
      assert(params.config);
      setRuntimeConfigSnapshot(params.config);
      closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const result = await runCodexAppServerAttempt(params, {
        clientFactory: factory,
        pluginConfig: { appServer: { homeScope: "user", args: ["app-server"] } },
      });
      expect(result.assistantTexts.join("\n").trim()).toBe("DONE");
      const bodies = relayUpstream.bodies;
      expect(bodies).toHaveLength(RELAY_TOOL_CALLS + 1);
      for (const [index, body] of bodies.entries()) {
        // Stable context sits once in cached developer input; per-turn context stays request-local.
        const instructions = typeof body.instructions === "string" ? body.instructions : "";
        expect(instructions).toContain(turnMarker);
        expect(instructions).not.toContain(skillMarker);
        expect(developerMessageText(body).split(skillMarker)).toHaveLength(2);
        expect(JSON.stringify(body.input)).not.toContain(turnMarker);
        const previous = bodies[index - 1]?.input;
        if (Array.isArray(previous) && Array.isArray(body.input)) {
          expect(body.input.slice(0, previous.length)).toEqual(previous);
        }
      }
    } finally {
      try {
        if (client) {
          expect(await client.closeAndWait()).toMatchObject({ exited: true });
        }
      } finally {
        closeHost?.();
        clearRuntimeConfigSnapshot();
      }
    }
  }, 120_000);
});
