import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
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

async function startResponsesFixture() {
  const requests: JsonObject[] = [];
  const usage = { tokens: 10 };
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const parsed: unknown = JSON.parse(await readText(request));
    if (!isJsonObject(parsed)) {
      response.writeHead(400).end();
      return;
    }
    requests.push(parsed);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, data: JsonObject) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, response: data })}\n\n`);
    emit("response.created", { id: "skill-response" });
    emit("response.completed", {
      id: "skill-response",
      usage: { input_tokens: usage.tokens, output_tokens: 1, total_tokens: usage.tokens + 1 },
    });
    response.end();
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

async function createNativeFixture(modelId: string, contextWindow = 200_000) {
  const root = await fs.realpath(tempDir);
  const native = await createCodexNativeTestState(root);
  for (const [name, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  const fixture = await startResponsesFixture();
  const catalogPath = path.join(root, "models.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      models: [
        {
          slug: modelId,
          display_name: "Synthetic skill carrier model",
          supported_reasoning_levels: [],
          shell_type: "local",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          support_verbosity: false,
          truncation_policy: { mode: "bytes", limit: 10000 },
          experimental_supported_tools: [],
          context_window: contextWindow,
          model_messages: {
            instructions_template: "You are a test assistant.",
            collaboration_modes: { default: "Synthetic model-owned Default policy." },
          },
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(native.codexHome, "config.toml"),
    [
      `model=${JSON.stringify(modelId)}`,
      'model_provider="skill-fixture"',
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      "[model_providers.skill-fixture]",
      'name="Synthetic skill provider"',
      `base_url="http://127.0.0.1:${fixture.port}/v1"`,
      "request_max_retries=0",
      "stream_max_retries=0",
    ].join("\n"),
  );
  const createParams = (filename: string, sessionKey?: string) => {
    const params = createNativeRunParams(path.join(root, filename), native.cwd, sessionKey);
    params.modelId = modelId;
    params.model = { ...params.model, id: modelId };
    params.trigger = "user";
    params.timeoutMs = 20_000;
    return params;
  };
  const threadIds = new Set<string>();
  let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
  const run = (params: ReturnType<typeof createParams>, url?: string) =>
    runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          sandbox: "read-only",
          approvalPolicy: "never",
          ...(url
            ? { transport: "websocket", url }
            : {
                command: native.command,
                args: ["app-server"],
                homeScope: "user",
              }),
        },
      },
      nativeHookRelay: { enabled: false },
      clientFactory: async (clientOptions) => {
        if (!client) {
          client = await createIsolatedCodexAppServerClient(clientOptions);
          client.addNotificationHandler((notification: CodexServerNotification) => {
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
  const close = async () => {
    if (client) {
      expect(await client.closeAndWait()).toMatchObject({ exited: true });
    }
    await fixture.close();
  };
  return { native, fixture, createParams, run, threadIds, close, [Symbol.asyncDispose]: close };
}

function developerMessages(request: JsonObject | undefined) {
  const input = request?.input;
  return Array.isArray(input)
    ? input.filter((item) => isJsonObject(item) && item.role === "developer")
    : [];
}
const developerMessageText = (request: JsonObject | undefined) =>
  JSON.stringify(developerMessages(request));

it("delivers the ordinary root catalog when model metadata owns collaboration instructions", async () => {
  await using native = await createNativeFixture("skill-carrier-model");
  const { fixture, createParams, run } = native;
  const params = createParams("session.jsonl");
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
  const result = await run(params);
  expect(result.terminal).toEqual({ kind: "ok" });
  expect(fixture.requests).toHaveLength(1);
  expect(Array.isArray(fixture.requests[0]?.input)).toBe(true);
  const developerText = developerMessageText(fixture.requests[0]);
  expect(developerText).toContain("Synthetic model-owned Default policy.");
  expect(developerText).toContain(params.skillsSnapshot.prompt);
}, 45_000);

it("delivers and refreshes persona through an external WebSocket Harness", async ({ signal }) => {
  const state = await createNativeFixture("persona-carrier-model");
  const { native, fixture, createParams, run, threadIds } = state;
  // External transport must not qualify for the stdio relay.
  const harness = spawn(native.command, ["app-server", "--listen", "ws://127.0.0.1:0"], {
    cwd: native.cwd,
    env: native.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
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
    for (const [index, soul] of [firstSoul, editedSoul, undefined].entries()) {
      if (soul) {
        await fs.writeFile(soulPath, soul);
      } else {
        await fs.unlink(soulPath);
      }
      const params = createParams("remote-persona.jsonl");
      params.disableTools = false;
      params.runId = `remote-persona-${index}`;
      params.prompt = `Ordinary remote turn ${index}.`;
      const result = await run(params, url);
      expect(result.terminal).toEqual({ kind: "ok" });
      // Native history/configuration can be inherited by full-history forks.
      expect(JSON.stringify(fixture.requests)).not.toContain(personalUser);
      expect(result.systemPromptReport?.injectedWorkspaceFiles).toContainEqual(
        expect.objectContaining({ path: personalPath, injectedChars: 0, truncated: false }),
      );
      const text = developerMessageText(fixture.requests.at(-1));
      expect(text).toContain(sharedUser);
      expect(text).toContain("Synthetic model-owned Default policy.");
      if (soul) {
        expect(text).toContain(soul);
        if (index === 1) {
          expect(text.lastIndexOf(editedSoul)).toBeGreaterThan(text.lastIndexOf(firstSoul));
        }
      } else {
        // Historical turns retain old text; inspect the latest policy handoff.
        expect(Array.isArray(fixture.requests.at(-1)?.input)).toBe(true);
        const handoffs = developerMessages(fixture.requests.at(-1)).filter((item) =>
          JSON.stringify(item).includes("complete current OpenClaw"),
        );
        expect(handoffs.length).toBeGreaterThan(0);
        expect(JSON.stringify(handoffs.at(-1))).not.toContain(editedSoul);
        expect(JSON.stringify(handoffs.at(-1))).not.toContain(firstSoul);
      }
    }
    expect(threadIds.size).toBe(1);
  } finally {
    await state.close();
    if (harness.exitCode === null && harness.signalCode === null) {
      const closed = once(harness, "close");
      harness.kill("SIGTERM");
      await closed;
    }
  }
}, 90_000);

it("keeps a withdrawn catalog visible to the model after native compaction rebuilds the incognito thread", async () => {
  const current = "refreshable thread instructions are empty";
  // 5,000 tokens exceeds the 900-token native auto-compaction threshold.
  await using native = await createNativeFixture("skill-carrier-model", 1_000);
  const { fixture, createParams, run } = native;
  const sessionKey = "agent:main:dashboard:incognito-native-compaction-removal";
  await seedRunSessionOwnerForTest("session-1", sessionKey);
  const runTurn = async (runId: string, catalog: string | undefined, prompt: string) => {
    const before = fixture.requests.length;
    const params = createParams("incognito-compaction-session.jsonl", sessionKey);
    // Tool restriction would replace the live incognito thread.
    params.disableTools = false;
    params.runId = runId;
    params.prompt = prompt;
    params.timeoutMs = 60_000;
    params.skillsSnapshot = catalog ? { prompt: catalog, skills: [] } : undefined;
    const result = await run(params);
    expect(result.terminal).toEqual({ kind: "ok" });
    return fixture.requests.slice(before);
  };

  const [creationRequest] = await runTurn("run-1", NATIVE_FIRST_CATALOG, "first");
  expect(developerMessageText(creationRequest)).toContain(NATIVE_FIRST_CATALOG);

  fixture.usage.tokens = 5_000;
  const [refreshRequest] = await runTurn("run-2", undefined, "second");
  expect(developerMessageText(refreshRequest)).toContain(current);

  fixture.usage.tokens = 10;
  const compactionTurn = await runTurn("run-3", undefined, "third");
  const summarizationIndex = compactionTurn.findIndex((request) =>
    JSON.stringify(request).includes("You are performing a CONTEXT CHECKPOINT COMPACTION."),
  );
  expect(summarizationIndex).toBeGreaterThanOrEqual(0);
  const continuationRequest = compactionTurn[summarizationIndex + 1];
  expect(continuationRequest).toBeDefined();
  // Compaction restores the immutable creation-time carrier, losing the refresh.
  expect(developerMessageText(continuationRequest)).toContain(NATIVE_FIRST_CATALOG);
  expect(developerMessageText(continuationRequest)).not.toContain(current);

  const [restoredRequest] = await runTurn("run-4", undefined, "fourth");
  const restored = developerMessageText(restoredRequest);
  expect(restored).toContain(current);
  expect(restored.lastIndexOf(current)).toBeGreaterThan(restored.lastIndexOf(NATIVE_FIRST_CATALOG));
}, 180_000);
