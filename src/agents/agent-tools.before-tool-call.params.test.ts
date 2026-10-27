import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginHookBeforeToolCallEvent } from "../plugins/types.js";
import { mergeParamsWithApprovalOverrides } from "./agent-tools.before-tool-call.approval.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "./subagents/swarm/swarm-code-mode.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetAdjustedParamsByToolCallIdForTests();
});

it("keeps private spawn parameters when a real before_tool_call hook rewrites public arguments", async () => {
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "rewrite-fixture",
    hookName: "before_tool_call",
    handler: (event: PluginHookBeforeToolCallEvent) => ({
      params: { ...event.params, runTimeoutSeconds: 600 },
    }),
  });
  initializeGlobalHookRunner(registry);
  const params = { task: "Summarize the fixture", collect: true };
  Object.defineProperties(params, {
    [SWARM_CODE_MODE_IDEMPOTENCY_KEY]: { value: "fixture:launch:1" },
    [SWARM_CODE_MODE_REQUEST_FINGERPRINT]: { value: "sha256:fixture" },
    internalContext: { value: "fixture-context" },
  });
  const tool: AnyAgentTool = {
    name: "sessions_spawn",
    label: "Spawn fixture",
    description: "Observe the parameters delivered to the tool",
    parameters: Type.Object({}),
    async execute(_id, received) {
      if (!received || typeof received !== "object") {
        throw new TypeError("Expected tool parameters");
      }
      return {
        content: [],
        details: {
          timeout: Reflect.get(received, "runTimeoutSeconds"),
          replayKey: Reflect.get(received, SWARM_CODE_MODE_IDEMPOTENCY_KEY),
          fingerprint: Reflect.get(received, SWARM_CODE_MODE_REQUEST_FINGERPRINT),
          internalContext: Reflect.get(received, "internalContext"),
          replayDescriptor: Object.getOwnPropertyDescriptor(
            received,
            SWARM_CODE_MODE_IDEMPOTENCY_KEY,
          ),
          contextDescriptor: Object.getOwnPropertyDescriptor(received, "internalContext"),
        },
      };
    },
  };

  const result = await wrapToolWithBeforeToolCallHook(tool, undefined, {
    emitDiagnostics: false,
  }).execute("params-retention", params);

  expect(result.details).toEqual({
    timeout: 600,
    replayKey: "fixture:launch:1",
    fingerprint: "sha256:fixture",
    internalContext: "fixture-context",
    replayDescriptor: {
      value: "fixture:launch:1",
      enumerable: false,
      configurable: false,
      writable: false,
    },
    contextDescriptor: {
      value: "fixture-context",
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  expect(params).toEqual({ task: "Summarize the fixture", collect: true });
});

it("lets explicit overrides replace non-configurable originals without invoking retained accessors", () => {
  const symbol = Symbol("private");
  let reads = 0;
  const original = Object.defineProperties(
    {},
    {
      task: { value: "original" },
      [symbol]: { value: "original-private" },
      context: {
        get() {
          reads++;
          return "retained-context";
        },
      },
    },
  );
  const overrides = { task: "rewritten", [symbol]: undefined };

  const merged = mergeParamsWithApprovalOverrides(original, overrides);

  expect(reads).toBe(0);
  expect(merged).toHaveProperty("task", "rewritten");
  expect(Object.getOwnPropertyDescriptor(merged, symbol)).toEqual({
    value: undefined,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  expect(merged).toHaveProperty("context", "retained-context");
  expect(reads).toBeGreaterThan(0);
  expect(Object.getOwnPropertyDescriptor(original, "task")?.value).toBe("original");
  expect(Object.getOwnPropertyDescriptor(original, symbol)?.value).toBe("original-private");
});
