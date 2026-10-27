import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { isGatewayToolPolicyControl } from "./agent-tool-metadata.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { applyGatewayToolPolicy } from "./gateway-tool-policy.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";
import {
  completionModelDefinition,
  startCompletionServer,
} from "./simple-completion.test-support.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

// Production inference transport, finalizer and deployment policy; the final I/O witness is synthetic.
async function policyFixture(name: "computer" | "browser", beforeResponse?: () => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "interaction-policy-"));
  const requests: unknown[] = [];
  const effects: unknown[] = [];
  const server = await startCompletionServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      await beforeResponse?.();
      const complete = body.messages.some((message: { role: string }) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            id: "policy-fixture",
            object: "chat.completion.chunk",
            model: "vision",
            choices: [
              {
                index: 0,
                delta: complete
                  ? { content: "Observed." }
                  : {
                      tool_calls: [
                        {
                          index: 0,
                          id: "observe",
                          type: "function",
                          function: { name, arguments: JSON.stringify({ action: "screenshot" }) },
                        },
                      ],
                    },
                finish_reason: complete ? "stop" : "tool_calls",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "policy-fixture/parent",
        computerModel: "policy-fixture/vision",
        browserModel: "policy-fixture/vision",
        workspace: root,
      },
      entries: { main: { agentDir: path.join(root, "agent") } },
    },
    models: {
      providers: {
        "policy-fixture": {
          baseUrl: server.baseUrl,
          apiKey: "synthetic-key",
          api: "openai-completions",
          models: [
            completionModelDefinition({ id: "vision", input: ["text", "image"] }),
            completionModelDefinition({ id: "parent" }),
          ],
        },
      },
    },
    tools: { gatewayPolicy: { allow: [name], actions: { [name]: ["screenshot"] } } },
  };
  const source: AnyAgentTool = {
    name,
    label: name,
    description: "Controlled final I/O witness.",
    parameters: Type.Object({ action: Type.String({ enum: ["screenshot", "left_click"] }) }),
    execute: async (_id, input) => {
      effects.push(input);
      return { content: [{ type: "text", text: "Observed." }], details: {} };
    },
  };
  const build = () =>
    finalizeAgentTools({
      tools: applyGatewayToolPolicy([source], config),
      config,
      hookContext: { agentId: "main" },
      interactionModelContext: { policyAgentId: "main" },
    });
  return {
    config,
    requests,
    effects,
    source,
    build,
    async [Symbol.asyncDispose]() {
      await server[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("interaction task deployment-policy and authority boundaries", () => {
  it.each(["computer", "browser"] as const)(
    "allows a %s task through its original screenshot-only executor",
    async (name) => {
      await using f = await policyFixture(name);
      const tool = f.build()[0]!;
      const result = await tool.execute("allowed", { task: "Observe only." });
      expect(result.content).toEqual([{ type: "text", text: "Observed." }]);
      expect(f.requests).toHaveLength(2);
      expect(f.effects).toEqual([{ action: "screenshot" }]);
      expect(isGatewayToolPolicyControl(f.source)).toBe(false);
    },
  );

  it("survives later catalog policy projection without turning task arguments into actions", async () => {
    await using f = await policyFixture("computer");
    const tool = applyGatewayToolPolicy(f.build(), f.config)[0]!;
    await tool.execute("reprojected", { task: "Observe only." });
    expect(f.effects).toEqual([{ action: "screenshot" }]);
  });

  it("still rejects a hook-rewritten forbidden action at the original final effect boundary", async () => {
    await using f = await policyFixture("computer");
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "fixture",
      hookName: "before_tool_call",
      handler: async (event: { params: Record<string, unknown> }) => {
        if (event.params.action) {
          return { params: { action: "left_click" } };
        }
        return undefined;
      },
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    await expect(f.build()[0]!.execute("rewritten", { task: "Observe only." })).rejects.toThrow(
      "Gateway tool policy denies computer action",
    );
    expect(f.requests).toHaveLength(1);
    expect(f.effects).toHaveLength(0);
  });

  it("does not construct a task for a deployment-denied source tool", async () => {
    await using f = await policyFixture("computer");
    f.config.tools!.gatewayPolicy!.allow = [];
    expect(f.build()).toEqual([]);
    expect(f.requests).toHaveLength(0);
    expect(f.effects).toHaveLength(0);
  });

  it("honors a task-level hook veto before any inference", async () => {
    await using f = await policyFixture("computer");
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "fixture",
      hookName: "before_tool_call",
      handler: async () => ({ block: true, blockReason: "task-veto" }),
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const result = await f.build()[0]!.execute("vetoed-task", { task: "Observe." });
    expect(result.details).toMatchObject({ status: "blocked" });
    expect(f.requests).toHaveLength(0);
    expect(f.effects).toHaveLength(0);
  });

  it("allows a host-issued operator with permission for the selected specialist", async () => {
    await using f = await policyFixture("computer");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "allowed-fixture",
      scopes: [],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg: f.config,
        policy: { allow: ["policy-fixture/*"] },
      }),
    });
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:policy-fixture", operatorAuthority },
      () => f.build()[0]!.execute("allowed-operator", { task: "Observe." }),
    );
    expect(f.requests).toHaveLength(2);
    expect(f.effects).toEqual([{ action: "screenshot" }]);
  });

  it("rejects a host-issued operator whose model policy allows chat but not the specialist", async () => {
    await using f = await policyFixture("computer");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "restricted-fixture",
      scopes: [],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg: f.config,
        policy: { allow: ["policy-fixture/parent"] },
      }),
    });
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:policy-fixture", operatorAuthority },
        () => f.build()[0]!.execute("denied-operator", { task: "Observe." }),
      ),
    ).rejects.toThrow("operator role cannot use this model");
    expect(f.requests).toHaveLength(0);
    expect(f.effects).toHaveLength(0);
  });

  it("rejects a source run retired during real asynchronous provider transport before I/O", async () => {
    const arrived = createDeferred();
    const release = createDeferred();
    await using f = await policyFixture("computer", async () => {
      arrived.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (reason) => controller.abort(reason),
    });
    let result: Promise<unknown> | undefined;
    await budget.run(async () => {
      result = Promise.resolve(f.build()[0]!.execute("retired-source", { task: "Observe." }));
      void result.catch(() => {});
      // Race catches setup failures without deadlocking the deferred provider fixture.
      await Promise.race([arrived.promise, result]);
    });
    release.resolve();
    await expect(result).rejects.toThrow("no longer active");
    expect(f.requests).toHaveLength(1);
    expect(f.effects).toHaveLength(0);
  });
});
