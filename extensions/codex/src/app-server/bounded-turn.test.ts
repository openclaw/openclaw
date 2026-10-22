import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import {
  codexModel,
  completedTurnResult,
  createClientFactory,
  inProgressTurnResult,
  threadStartResult,
} from "./bounded-turn.test-harness.js";
import type { JsonValue } from "./protocol.js";
import * as shared from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

afterEach(() => vi.restoreAllMocks());

function requestParams(fake: ReturnType<typeof createClientFactory>, method: string) {
  return fake.request.mock.calls.find(([name]) => name === method)?.[1];
}

function wireResults(
  turn:
    | ReturnType<typeof completedTurnResult>
    | ReturnType<typeof inProgressTurnResult> = completedTurnResult(),
) {
  return {
    "model/list": { data: [codexModel()], nextCursor: null },
    "config/read": { config: {}, layers: [] },
    "configRequirements/read": { requirements: null },
    "thread/start": threadStartResult("gpt-5.4"),
    "mcpServerStatus/list": { data: [], nextCursor: null },
    "turn/start": turn,
  };
}

type TurnParams = Parameters<typeof runBoundedCodexAppServerTurn>[0];
const success = { text: "The message was sent successfully." };
const threadIdentity = { threadId: "thread-finalizer", turnId: "turn-finalizer" };
const configArgs = (...settings: string[]) => settings.flatMap((setting) => ["-c", setting]);
const stdioArgs = (...args: string[]) => [...args, "--listen", "stdio://"];
const appServerOptions = (
  appServer: NonNullable<TurnParams["options"]["pluginConfig"]>["appServer"],
) => ({ pluginConfig: { appServer } });
const clientOptions = (fake: ReturnType<typeof createClientFactory>) =>
  vi.mocked(fake.factory).mock.calls[0]?.[0];
const agentMessage = (id: string, text: string) => ({ id, type: "agentMessage", text });
const completedNotification = () => ({
  method: "turn/completed",
  params: { threadId: threadIdentity.threadId, ...completedTurnResult() },
});

function runTurn(
  clientFactory: typeof shared.createIsolatedCodexAppServerClient,
  params: Partial<TurnParams> = {},
) {
  vi.spyOn(shared, "createIsolatedCodexAppServerClient").mockImplementation(clientFactory);
  return runBoundedCodexAppServerTurn({
    model: { mode: "required", id: "gpt-5.4" },
    timeoutMs: 5_000,
    taskLabel: "isolated completion",
    developerInstructions: "Answer only.",
    input: [{ type: "text", text: "Name this conversation.", text_elements: [] }],
    requiredModalities: ["text"],
    isolation: "private-stdio",
    ...params,
    options: params.options ?? {},
  });
}

function runRestricted(
  fake: ReturnType<typeof createClientFactory>,
  params: Partial<TurnParams> = {},
) {
  return runTurn(fake.factory, { requireNoExternalCapabilities: true, ...params });
}

it("preserves mandatory hooks in a private tool-free turn", async () => {
  const fake = createClientFactory({
    managedRequirements: { featureRequirements: { hooks: true } },
    hooks: [{ key: "managed:pre_tool_use:0:0", enabled: true, isManaged: true }],
  });

  await expect(runRestricted(fake)).resolves.toMatchObject(success);

  const start = requestParams(fake, "thread/start");
  expect(start).toMatchObject({
    environments: [],
    dynamicTools: [],
    ephemeral: true,
    sandbox: "read-only",
    config: {
      "features.hooks": true,
      "features.shell_tool": false,
      "features.code_mode": false,
      "features.plugins": false,
      "features.apps": false,
      "orchestrator.mcp.enabled": false,
      mcp_servers: { inherited: { enabled: false } },
      notify: [],
      project_root_markers: [],
    },
  });
  expect(clientOptions(fake)?.startOptions).toMatchObject({
    cwd: (start as { cwd: string }).cwd,
    args: expect.arrayContaining([
      "project_root_markers=[]",
      "features.hooks=true",
      "features.plugins=false",
    ]),
  });
  expect(fake.methods.indexOf("hooks/list")).toBeLessThan(fake.methods.indexOf("thread/start"));
});

it("still refuses managed tool enablement before starting a private completion", async () => {
  const fake = createClientFactory({
    managedRequirements: { featureRequirements: { hooks: true, shell_tool: true } },
  });
  await expect(runRestricted(fake)).rejects.toThrow("cannot override required feature shell_tool");
  expect(fake.methods).not.toContain("thread/start");
});

it.each([true, false])(
  "never returns a draft rejected by a managed Stop hook (revised answer: %s)",
  async (hasRevision) => {
    const fake = createClientFactory({
      managedRequirements: {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "managed-policy" }] }] },
      },
      hooks: [{ key: "managed:stop:0:0", enabled: true, isManaged: true }],
      terminalItems: [
        agentMessage("draft", "Rejected draft."),
        {
          id: "policy",
          type: "hookPrompt",
          fragments: [{ text: "Revise this answer.", hookRunId: "managed-stop" }],
        },
        ...(hasRevision ? [agentMessage("revision", "Approved revision.")] : []),
      ],
    });
    const run = runRestricted(fake);
    if (hasRevision) {
      await expect(run).resolves.toMatchObject({
        text: "Approved revision.",
        managedHooksEnabled: true,
      });
    } else {
      await expect(run).rejects.toThrow("returned no text");
    }
  },
);

it.each(["bound notification", "queued notification", "terminal response"] as const)(
  "keeps an accepted %s when the transport closes immediately afterward",
  async (receipt) => {
    const started = createDeferred<void>();
    const declined = createDeferred<void>();
    const sendCompletion = () => {
      harness.send({
        method: "item/completed",
        params: {
          ...threadIdentity,
          item: agentMessage("first", "First answer."),
        },
      });
      harness.send(completedNotification());
      harness.emitExit();
    };
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number | string; method?: string };
        if (request.id === "binding-fence") {
          declined.resolve();
          return;
        }
        const results: Record<string, unknown> = wireResults(
          receipt === "terminal response" ? completedTurnResult() : inProgressTurnResult(),
        );
        send({ id: request.id, result: results[request.method ?? ""] });
        if (request.method === "turn/start") {
          started.resolve();
          if (receipt === "queued notification") {
            sendCompletion();
          } else if (receipt === "terminal response") {
            harness.emitExit();
          }
        }
      },
    });
    const run = runTurn(async () => harness.client, {
      isolation: "configured-transport",
    });
    const result = expect(run).resolves.toMatchObject({
      text: `${receipt === "terminal response" ? "" : "First answer.\n\n"}The message was sent successfully.`,
    });
    try {
      await started.promise;
      if (receipt === "bound notification") {
        // A serviced request proves the exact turn has bound, without depending on microtask counts.
        harness.send({
          id: "binding-fence",
          method: "mcpServer/elicitation/request",
          params: { ...threadIdentity, serverName: "forms" },
        });
        await declined.promise;
        sendCompletion();
      }
      await result;
    } finally {
      harness.client.close();
      await run.catch(() => {});
    }
  },
);

it("rejects a waiting completion when its app-server client closes", async () => {
  const fake = createClientFactory({ completeTurn: false });
  const controller = new AbortController();
  let outcome: unknown;
  const run = runTurn(fake.factory, {
    signal: controller.signal,
    isolation: "configured-transport",
  }).catch((error: unknown) => {
    outcome = error;
  });
  try {
    await vi.waitFor(() => expect(fake.methods).toContain("turn/start"));
    fake.close(new Error("app-server transport disconnected"));
    await vi.waitFor(
      () => expect(outcome).toMatchObject({ message: expect.stringContaining("closed") }),
      { timeout: 200 },
    );
  } finally {
    controller.abort("test cleanup");
    await run;
  }
});

it("bounds turn notifications received before turn/start acknowledges", async () => {
  const fake = createClientFactory({ preBindDeltaCount: 257 });
  await expect(runTurn(fake.factory, { isolation: "configured-transport" })).rejects.toThrow(
    "pre-bind notification buffer exceeded",
  );
});

it("does not dispatch a turn after its caller retires during MCP attestation", async () => {
  const suspended = createDeferred<void>();
  const release = createDeferred<void>();
  const fake = createClientFactory({
    beforeRequest: async (method) => {
      if (method === "mcpServerStatus/list") {
        suspended.resolve();
        await release.promise;
      }
    },
  });
  const retired = new Error("bounded turn caller retired");
  let current = true;
  const run = runRestricted(fake, {
    assertCurrent: () => {
      if (!current) {
        throw retired;
      }
    },
  });
  const rejection = expect(run).rejects.toBe(retired);
  await suspended.promise;
  const codexHome = clientOptions(fake)?.startOptions?.env?.CODEX_HOME;
  current = false;
  release.resolve();

  await rejection;
  expect(fake.methods).not.toContain("turn/start");
  expect([fake.notifications.size, fake.requests.size]).toEqual([0, 0]);
  if (!codexHome) {
    throw new Error("expected the bounded turn's temporary Codex home");
  }
  await expect(fs.access(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["thread/start", "turn/start"] as const)(
  "rejects expired authority before the physical %s write after setup",
  async (blockedMethod) => {
    let current = true;
    const expired = new Error("completion owner expired during setup");
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number; method: string };
        const results: Record<string, unknown> = wireResults();
        const retirementMethod =
          blockedMethod === "turn/start" ? "mcpServerStatus/list" : "configRequirements/read";
        if (request.method === retirementMethod) {
          current = false;
        }
        send({ id: request.id, result: results[request.method] });
      },
    });
    try {
      await expect(
        runTurn(async () => harness.client, {
          assertCurrent: () => {
            if (!current) {
              throw expired;
            }
          },
          isolation: "configured-transport",
          requireNoExternalCapabilities: true,
        }),
      ).rejects.toBe(expired);
      expect(harness.writes.map((line) => JSON.parse(line).method)).not.toContain(blockedMethod);
    } finally {
      harness.client.close();
    }
  },
);

it("returns an explicit unsupported decline for interactive MCP input", async () => {
  const fake = createClientFactory({ completeTurn: false });
  const run = runTurn(fake.factory, { taskLabel: "hosted search" });
  await vi.waitFor(() => expect(fake.methods).toContain("turn/start"));

  await expect(
    fake.handleServerRequest({
      id: "bounded-elicitation",
      method: "mcpServer/elicitation/request",
      params: {
        ...threadIdentity,
        serverName: "forms",
        mode: "form",
        message: "Enter a value",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    }),
  ).resolves.toEqual({
    action: "decline",
    content: null,
    _meta: { message: "OpenClaw Codex hosted search does not support interactive input." },
  });

  await fake.notify(completedNotification());
  await expect(run).resolves.toMatchObject(success);
});

it("does not adopt a prior turn's timeout as its own", async () => {
  const first = createClientFactory({ completeTurn: false });
  let priorTimeout: unknown;
  try {
    await runTurn(first.factory, {
      timeoutMs: 100,
      taskLabel: "first hosted search",
    });
  } catch (error) {
    priorTimeout = error;
  }
  expect(priorTimeout).toMatchObject({
    name: "TimeoutError",
    timeoutMs: 100,
    message: "codex app-server first hosted search turn timed out after 100ms",
  });

  const caller = new AbortController();
  caller.abort(priorTimeout);
  const second = createClientFactory({ completeTurn: false });
  await expect(
    runTurn(second.factory, {
      signal: caller.signal,
      taskLabel: "second hosted search",
    }),
  ).rejects.toMatchObject({
    name: "Error",
    message: "codex app-server second hosted search turn aborted",
  });
});

it.each([
  { receipt: "retry", codexErrorInfo: undefined, status: undefined },
  { receipt: "notification", codexErrorInfo: "serverOverloaded", status: 503 },
  { receipt: "turn", codexErrorInfo: "rateLimitExceeded", status: 429 },
  {
    receipt: "turn",
    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 502 } },
    status: 502,
  },
  { receipt: "interrupted", codexErrorInfo: undefined, status: undefined },
])(
  "handles $receipt completion with status $status",
  async ({ receipt, codexErrorInfo, status }) => {
    const error = { message: "terminal upstream failure", codexErrorInfo };
    const fake = createClientFactory(
      receipt === "retry"
        ? { errorBeforeCompletion: { message: "temporary upstream disconnect", willRetry: true } }
        : receipt === "interrupted"
          ? {
              terminalStatus: "interrupted",
              assistantDelta: "Partial answer that must not be delivered.",
            }
          : receipt === "notification"
            ? { errorBeforeCompletion: { ...error, willRetry: false } }
            : { terminalStatus: "failed", terminalError: error },
    );
    const run = runRestricted(fake, { taskLabel: "settled-turn finalization" });
    if (receipt === "retry") {
      await expect(run).resolves.toMatchObject(success);
    } else if (receipt === "interrupted") {
      await expect(run).rejects.toThrow("turn ended with status interrupted");
    } else {
      await expect(run).rejects.toMatchObject({ message: "terminal upstream failure", status });
    }
  },
);

it.each(["prepared", "profile"] as const)(
  "bridges %s auth into the private home when the configured home is native",
  async (authSelection) => {
    const fake = createClientFactory();
    const preparedAuth = { kind: "api-key" as const, apiKey: "test-key" };
    const profile = "openai:bounded";

    await runTurn(fake.factory, {
      ...(authSelection === "prepared" ? { preparedAuth } : { profile }),
      authRequirement: "api-key",
      options: appServerOptions({ homeScope: "user" }),
      requireNoExternalCapabilities: true,
    });

    expect(clientOptions(fake)).toMatchObject({
      ...(authSelection === "prepared" ? { preparedAuth } : { authProfileId: profile }),
      authRequirement: "api-key",
      startOptions: {
        homeScope: "agent",
        env: { CODEX_HOME: expect.stringContaining("codex-bounded-turn-") },
      },
    });
    expect(clientOptions(fake)).not.toHaveProperty(
      authSelection === "prepared" ? "authProfileId" : "preparedAuth",
    );
  },
);

const providerOverrides = [
  'openai_base_url="http://127.0.0.1:9/first"',
  'openai_base_url="http://127.0.0.1:9/last"',
  'model_catalog_json="/tmp/synthetic-models.json"',
];
it.each([
  {
    name: "carries provider overrides without importing tool policy",
    appServer: {
      args: [
        `-c${providerOverrides[0]}`,
        "app-server",
        `--config=${providerOverrides[1]}`,
        `-c=${providerOverrides[2]}`,
        "-csandbox_workspace_write.exclude_slash_tmp=false",
        "--config",
        "features.hooks=true",
        "--",
        '-copenai_base_url="http://127.0.0.1:9/ignored"',
      ],
    },
    restricted: false,
    expected: {
      args: stdioArgs("app-server", ...configArgs(...providerOverrides, "project_root_markers=[]")),
    },
  },
  {
    name: "resolves relative executable and model-catalog paths",
    appServer: {
      command: "./bin/custom-codex",
      args: ["app-server", "-c", "model_catalog_json='./fixtures/models.json'"],
    },
    restricted: true,
    expected: {
      command: path.resolve("./bin/custom-codex"),
      cwd: expect.stringContaining("codex-bounded-turn-"),
      args: expect.arrayContaining([
        `model_catalog_json=${JSON.stringify(path.resolve("./fixtures/models.json"))}`,
      ]),
    },
  },
  {
    name: "preserves the Node launcher without inherited native policy flags",
    appServer: {
      command: "node",
      args: ["./bin/codex-wrapper.js", "app-server", "--sandbox", "danger-full-access"],
    },
    restricted: true,
    expected: {
      command: "node",
      cwd: expect.stringContaining("codex-bounded-turn-"),
      args: stdioArgs(
        path.resolve("./bin/codex-wrapper.js"),
        "app-server",
        ...configArgs("project_root_markers=[]", "features.hooks=true", "features.plugins=false"),
      ),
    },
  },
])("private launch: $name", async ({ appServer, restricted, expected }) => {
  const fake = createClientFactory();
  await runTurn(fake.factory, {
    options: appServerOptions(appServer),
    ...(restricted ? { requireNoExternalCapabilities: true } : {}),
  });
  const startOptions = clientOptions(fake)?.startOptions;
  if (restricted) {
    expect(startOptions).toMatchObject(expected);
  } else {
    expect(startOptions?.args).toEqual(expected.args);
    expect(requestParams(fake, "thread/start")).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
  }
});

it("preserves and reports the configured native provider when no override is supplied", async () => {
  const model = "gpt-5.6-luna";
  const fake = createClientFactory({
    modelProvider: "synthetic-native-provider",
    models: [codexModel(model)],
  });

  const result = await runTurn(fake.factory, {
    model: { mode: "required", id: model },
    options: appServerOptions({ homeScope: "user" }),
    isolation: "configured-transport",
    requireNoExternalCapabilities: true,
  });

  expect(requestParams(fake, "thread/start")).not.toHaveProperty("modelProvider");
  expect(result.nativeSelection).toEqual({
    model,
    modelProvider: "synthetic-native-provider",
  });
  expect(clientOptions(fake)).toMatchObject({ startOptions: { homeScope: "user" } });
});

it("keeps hidden models out of live-default selection", async () => {
  const fake = createClientFactory({
    models: [
      { ...codexModel("test-hidden-catalog"), hidden: true, isDefault: false },
      { ...codexModel("image-only-default"), inputModalities: ["image"] },
      { ...codexModel("visible-execution-model", "visible-model"), isDefault: false },
    ],
  });

  await expect(
    runTurn(fake.factory, {
      model: { mode: "live-default" },
      taskLabel: "hosted search",
    }),
  ).resolves.toMatchObject({
    model: "visible-model",
    nativeSelection: { model: "visible-execution-model", modelProvider: "openai" },
    ...success,
  });

  expect(requestParams(fake, "thread/start")).toMatchObject({ model: "visible-execution-model" });
  expect(requestParams(fake, "turn/start")).not.toHaveProperty("model");
});

it("rejects a missing required model before starting a thread", async () => {
  const fake = createClientFactory();

  await expect(
    runTurn(fake.factory, {
      model: { mode: "required", id: "missing-model" },
      isolation: "configured-transport",
    }),
  ).rejects.toThrow("Codex app-server model not found: missing-model");
  expect(fake.methods).toEqual(["model/list"]);
});

it("attests ring-zero and retains usage when the final response has none", async () => {
  const fake = createClientFactory({
    responseCompletions: [
      {
        responseId: "response-first",
        usage: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 1,
          outputTokens: 4,
          reasoningOutputTokens: 3,
        },
      },
      { responseId: "response-without-usage", usage: null },
    ],
  });
  const historyItems: JsonValue[] = [
    { type: "function_call", call_id: "call-1", name: "message", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "sent" },
  ];

  await expect(
    runRestricted(fake, {
      taskLabel: "settled-turn finalization",
      historyItems,
    }),
  ).resolves.toMatchObject({
    ...success,
    model: "gpt-5.4",
    usage: {
      input: 5,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      reasoningTokens: 3,
      total: 12,
      contextUsage: { state: "unavailable" },
    },
  });

  expect(fake.methods).toEqual([
    "model/list",
    "config/read",
    "config/read",
    "hooks/list",
    "configRequirements/read",
    "thread/start",
    "mcpServerStatus/list",
    "thread/inject_items",
    "turn/start",
  ]);
  expect(requestParams(fake, "thread/start")).toMatchObject({
    baseInstructions: "",
    environments: [],
    dynamicTools: [],
    ephemeral: true,
    config: {
      "agents.enabled": false,
      "features.hooks": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.code_mode": false,
      "features.code_mode_only": false,
      "skills.include_instructions": false,
      include_environment_context: false,
      "tools.experimental_request_user_input.enabled": false,
      "tools.update_plan.enabled": false,
      mcp_servers: { inherited: { enabled: false } },
    },
  });
  expect(requestParams(fake, "turn/start")).not.toHaveProperty("cwd");
  expect(requestParams(fake, "turn/start")).not.toHaveProperty("environments");
  expect(fake.request).toHaveBeenCalledWith(
    "thread/inject_items",
    { threadId: "thread-finalizer", items: historyItems },
    expect.any(Object),
  );
});

it("fails before history injection when the started thread exposes an MCP server", async () => {
  const fake = createClientFactory({
    mcpServers: [{ name: "unexpected", serverInfo: null, tools: {} }],
  });

  await expect(
    runRestricted(fake, {
      taskLabel: "settled-turn finalization",
      historyItems: [{ type: "function_call_output", call_id: "call-1", output: "sent" }],
    }),
  ).rejects.toThrow(
    "Codex restricted-tool-surface MCP attestation found unexpected server unexpected",
  );
  expect(fake.methods).not.toContain("thread/inject_items");
  expect(fake.methods).not.toContain("turn/start");
});
