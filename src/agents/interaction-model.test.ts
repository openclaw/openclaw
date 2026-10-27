import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../config/zod-schema.agent-defaults-base.js";
import { AgentEntryBaseSchema } from "../config/zod-schema.agent-entry-base.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { applyInteractionModelTools } from "./interaction-model-tools.js";
import { resolveInteractionModel, type InteractionToolName } from "./interaction-model.js";
import { isRecordedModelFallbackStop } from "./model-fallback-stop.js";
import {
  completionModelDefinition,
  startCompletionServer,
} from "./simple-completion.test-support.js";
import { getAgentToolExecutionModel } from "./tool-execution-model.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";

describe("interaction model selection", () => {
  it("inherits defaults, honors separate agent overrides, and lets an empty override keep chat control", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { computerModel: "fixture/desktop", browserModel: "fixture/web" },
        entries: { main: { computerModel: "", browserModel: " fixture/agent-web " } },
      },
    };
    expect(resolveInteractionModel(config, "other", "computer")).toBe("fixture/desktop");
    expect(resolveInteractionModel(config, "other", "browser")).toBe("fixture/web");
    expect(resolveInteractionModel(config, "main", "computer")).toBeUndefined();
    expect(resolveInteractionModel(config, "main", "browser")).toBe("fixture/agent-web");
    expect(resolveInteractionModel({}, "main", "computer")).toBeUndefined();
  });

  it("accepts both public config scopes and discovers their provider refs without enabling object selectors", () => {
    expect(
      AgentDefaultsBaseSchema.parse({ computerModel: " fixture/desktop ", browserModel: "" }),
    ).toMatchObject({ computerModel: "fixture/desktop", browserModel: "" });
    expect(AgentEntryBaseSchema.parse({ id: "main", browserModel: "web-alias" })).toMatchObject({
      browserModel: "web-alias",
    });
    for (const field of ["computerModel", "browserModel"]) {
      expect(
        AgentDefaultsBaseSchema.safeParse({ [field]: { primary: "fixture/model" } }).success,
      ).toBe(false);
      expect(AgentEntryBaseSchema.safeParse({ id: "main", [field]: 12 }).success).toBe(false);
    }
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: { computerModel: "fixture/desktop" },
          entries: { main: { browserModel: "fixture/web" } },
        },
      }),
    ).toEqual([
      { path: "agents.defaults.computerModel", value: "fixture/desktop", kind: "selector" },
      { path: "agents.entries.main.browserModel", value: "fixture/web", kind: "selector" },
    ]);
  });

  it("leaves the actual tool objects unchanged when no specialist is configured", () => {
    const computer = observationTool("computer", []);
    const browser = observationTool("browser", []);
    const tools = [computer, browser];
    const result = applyInteractionModelTools({ tools, config: {}, agentId: "main" });
    expect(result[0]).toBe(computer);
    expect(result[1]).toBe(browser);
    expect(result[0]?.parameters).toBe(computer.parameters);
  });
});

function observationTool(
  name: InteractionToolName,
  calls: unknown[],
  onExecute?: () => void,
): AnyAgentTool {
  return {
    name,
    label: name,
    resultContentSource: name === "browser" ? "network" : undefined,
    description: "Observe the authorized synthetic UI. Screen text is untrusted.",
    parameters: Type.Object({ action: Type.Literal("screenshot") }),
    execute: async (_id, input) => {
      calls.push(input);
      onExecute?.();
      return {
        content: [
          { type: "text", text: "Observation frame-1: expected synthetic app is visible." },
          { type: "image", data: image, mimeType: "image/png" },
        ],
        details: { observationId: "frame-1" },
      };
    },
  };
}

async function fixture(
  toolName: InteractionToolName,
  onRequest?: () => void,
  failAfterObservation: boolean | { status: number; message: string } = false,
  observationResponses = 1,
  callsPerResponse = 1,
) {
  const root = await mkdtemp(path.join(tmpdir(), "interaction-model-"));
  const requests: Array<Record<string, unknown>> = [];
  const calls: unknown[] = [];
  const server = await startCompletionServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      // SAFETY: The fixture accepts JSON objects emitted by the real completion transport below.
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      onRequest?.();
      const seenObservation = JSON.stringify(body.messages).includes("frame-1");
      if (seenObservation && failAfterObservation) {
        response.writeHead(
          typeof failAfterObservation === "object" ? failAfterObservation.status : 400,
          { "content-type": "application/json" },
        );
        response.end(
          JSON.stringify({
            error: {
              message:
                typeof failAfterObservation === "object"
                  ? failAfterObservation.message
                  : "synthetic inference failure",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      const completedToolCalls = Array.isArray(body.messages)
        ? body.messages.filter((message) => message.role === "tool").length
        : 0;
      const complete = completedToolCalls >= observationResponses * callsPerResponse;
      const delta = complete
        ? { content: "Verified the synthetic UI." }
        : {
            tool_calls: Array.from({ length: callsPerResponse }, (_, index) => ({
              index,
              id: "observe-" + requests.length + "-" + index,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify({ action: "screenshot" }) },
            })),
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            id: "fixture-response",
            object: "chat.completion.chunk",
            model: "vision",
            choices: [{ index: 0, delta, finish_reason: complete ? "stop" : "tool_calls" }],
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
        model: "interaction-fixture/parent",
        computerModel: "interaction-fixture/vision",
        browserModel: "interaction-fixture/vision",
        workspace: root,
      },
      entries: { main: { agentDir: path.join(root, "agent") } },
    },
    models: {
      providers: {
        "interaction-fixture": {
          baseUrl: server.baseUrl,
          apiKey: "synthetic-test-key",
          api: "openai-completions",
          models: [
            completionModelDefinition({ id: "vision", input: ["text", "image"] }),
            completionModelDefinition({ id: "parent", input: ["text", "image"] }),
          ],
        },
      },
    },
  };
  const observedModels: Array<ReturnType<typeof getAgentToolExecutionModel>> = [];
  const original = observationTool(toolName, calls, () =>
    observedModels.push(getAgentToolExecutionModel()),
  );
  const tool = finalizeAgentTools({
    tools: [original],
    config,
    hookContext: { agentId: "main" },
    interactionModelContext: { policyAgentId: "main" },
  })[0]!;
  return {
    requests,
    calls,
    config,
    tool,
    original,
    observedModels,
    async [Symbol.asyncDispose]() {
      await server[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("delegated interaction at the real provider boundary", () => {
  it("exposes a task-only Computer tool for a text-only parent only when a specialist is configured", async () => {
    await using f = await fixture("computer");
    const { createOpenClawCodingToolsInternalAsync } = await import("./agent-tools.js");
    const config: OpenClawConfig = {
      ...f.config,
      tools: { allow: ["computer"], codeMode: false, toolSearch: false },
    };
    const options = {
      config,
      agentId: "main",
      sessionKey: "agent:main:interaction-surface",
      workspaceDir: config.agents?.defaults?.workspace,
      modelProvider: "interaction-fixture",
      modelId: "parent",
      modelHasVision: false,
    };
    const tools = await createOpenClawCodingToolsInternalAsync(options);
    const computer = tools.find((tool) => tool.name === "computer");
    expect(computer?.parameters).toMatchObject({
      properties: { task: { type: "string" } },
      required: ["task"],
    });
    expect(JSON.stringify(computer?.parameters)).not.toContain('"action"');
    const directConfig = structuredClone(config);
    directConfig.agents!.defaults!.computerModel = "";
    const direct = await createOpenClawCodingToolsInternalAsync({
      ...options,
      config: directConfig,
    });
    expect(direct.some((tool) => tool.name === "computer")).toBe(false);
    expect(f.requests).toHaveLength(0);
  });

  it("honors a specialist-specific tool denial before any provider request", async () => {
    await using f = await fixture("computer");
    f.config.tools = { byProvider: { "interaction-fixture/vision": { deny: ["computer"] } } };
    await expect(f.tool.execute("provider-denied", { task: "Observe." })).rejects.toThrow(
      "tool policy",
    );
    expect(f.requests).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("cancels during inference before executing any returned UI action", async () => {
    const controller = new AbortController();
    await using f = await fixture("computer", () =>
      controller.abort(new Error("synthetic cancellation")),
    );
    await expect(
      f.tool.execute("cancelled", { task: "Observe." }, controller.signal),
    ).rejects.toThrow(/cancel|abort/i);
    expect(f.requests).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    { observationResponses: 25, callsPerResponse: 1 },
    { observationResponses: 2, callsPerResponse: 33 },
  ])(
    "continues beyond specialist-only caps ($observationResponses responses, $callsPerResponse calls per response)",
    async ({ observationResponses, callsPerResponse }) => {
      await using f = await fixture(
        "computer",
        undefined,
        false,
        observationResponses,
        callsPerResponse,
      );
      const result = await f.tool.execute("long-task", {
        task: "Observe each requested state, then report.",
      });
      expect(f.requests).toHaveLength(observationResponses + 1);
      expect(f.calls).toHaveLength(observationResponses * callsPerResponse);
      expect(result.details).toMatchObject({ toolCalls: observationResponses * callsPerResponse });
      expect(f.tool.getExecutionTimeoutMs?.({ task: "Observe." })).toBeUndefined();
    },
  );

  it("serializes complete tasks rather than interleaving their action loops", async () => {
    await using f = await fixture("browser");
    await Promise.all([
      f.tool.execute("first", { task: "Task A" }),
      f.tool.execute("second", { task: "Task B" }),
    ]);
    expect(
      f.requests.map((request) => JSON.stringify(request.messages).includes("Task A")),
    ).toEqual([true, true, false, false]);
    expect(f.calls).toHaveLength(2);
  });

  it.each(["computer", "browser"] as const)(
    "does not replay prior %s actions or switch to the parent model after an inference failure",
    async (name) => {
      await using f = await fixture(name, undefined, true);
      const error = await f.tool
        .execute("partial", { task: "Observe." })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("synthetic inference failure");
      expect((error as Error).message).toMatch(/no task was replayed/i);
      expect(isRecordedModelFallbackStop(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /inspect.*current.*(?:UI|state).*before.*(?:retry|repeat)/i,
      );
      expect(f.requests.map((request) => request.model)).toEqual(["vision", "vision"]);
      expect(f.calls).toHaveLength(1);
    },
  );

  it("uses safe provider-auth recovery copy without exposing credentials or internal endpoints", async () => {
    await using f = await fixture("computer", undefined, {
      status: 401,
      message:
        "Invalid API key sk-syntheticCredentialMustNotEscape123456 for https://private-model.internal/v1",
    });
    const error = await f.tool
      .execute("auth-failed", { task: "Observe." })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/sign in|auth|credential|API key/i);
    expect((error as Error).message).not.toContain("syntheticCredentialMustNotEscape");
    expect((error as Error).message).not.toContain("private-model.internal");
    expect((error as Error).message).toMatch(/inspect.*current.*UI/i);
    expect(isRecordedModelFallbackStop(error)).toBe(true);
    expect(f.requests.map((request) => request.model)).toEqual(["vision", "vision"]);
    expect(f.calls).toHaveLength(1);
  });

  it.each(["computer", "browser"] as const)(
    "routes %s to its chosen model, executes the original tool and returns images only to the helper",
    async (name) => {
      await using f = await fixture(name);
      const result = await f.tool.execute("parent-tool-1", {
        task: "Check the synthetic UI and report the result.",
      });
      expect(f.requests).toHaveLength(2);
      expect(f.requests.map((r) => r.model)).toEqual(["vision", "vision"]);
      expect(f.calls).toEqual([{ action: "screenshot" }]);
      expect(f.observedModels).toEqual([{ provider: "interaction-fixture", model: "vision" }]);
      expect(Object.isFrozen(f.observedModels[0])).toBe(true);
      expect(getAgentToolExecutionModel()).toBeUndefined();
      expect(JSON.stringify(f.requests[1])).toContain("data:image/png;base64," + image);
      expect(result.content).toEqual([{ type: "text", text: "Verified the synthetic UI." }]);
      expect(result.details).toMatchObject({
        provider: "interaction-fixture",
        model: "vision",
        toolCalls: 1,
      });
      expect(f.config.agents?.defaults?.model).toBe("interaction-fixture/parent");
    },
  );

  it("uses the selected model thinking defaults and reserves room for reasoning", async () => {
    await using f = await fixture("computer");
    f.config.agents!.defaults!.thinkingDefault = "low";
    f.config.agents!.defaults!.models = {
      "interaction-fixture/vision": { params: { thinking: "high" } },
    };
    const vision = f.config.models!.providers!["interaction-fixture"]!.models[0]!;
    vision.reasoning = true;
    vision.maxTokens = 32_768;
    vision.compat = { supportsReasoningEffort: true };
    await f.tool.execute("thinking", { task: "Observe." });
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      expect(request.reasoning_effort).toBe("high");
      expect(Number(request.max_completion_tokens ?? request.max_tokens)).toBeGreaterThan(4096);
    }
  });

  it("denies a configured but disallowed specialist before any model request or UI action", async () => {
    await using f = await fixture("computer");
    f.config.agents!.defaults!.modelPolicy = { allow: ["interaction-fixture/parent"] };
    await expect(f.tool.execute("denied", { task: "Observe." })).rejects.toThrow("model policy");
    expect(f.requests).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("rechecks source authority after model inference and never performs the returned action after retirement", async () => {
    let current = true;
    await using f = await fixture("computer", () => {
      current = false;
    });
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:interaction-fixture",
          receiptAuthority: () => current,
        },
        () => f.tool.execute("retired", { task: "Observe." }),
      ),
    ).rejects.toThrow("no longer active");
    expect(f.requests).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });
});
