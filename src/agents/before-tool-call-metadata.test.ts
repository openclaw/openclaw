import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  prepareBeforeToolCallExecutionParams,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.wrapper.js";
import {
  getBeforeToolCallDiagnosticOptions,
  getBeforeToolCallHookContext,
  isToolWrappedWithBeforeToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
} from "./before-tool-call-metadata.js";
import { getInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import type { AnyAgentTool } from "./tools/common.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./tools/gateway-caller-context.js";

function createTool(): AnyAgentTool {
  return {
    name: "metadata_fixture",
    label: "Metadata fixture",
    description: "Exercise host tool metadata",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: {} })),
  };
}

describe("before-tool-call metadata across plugin views", () => {
  it.each(["execute", "prepare"] as const)(
    "preserves caller authority and cancellation during rebuilt %s preparation",
    async (phase) => {
      const entered = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      const owner = new PluginInstance("wrapped-authority");
      const source = createTool();
      let callerSession: string | undefined;
      source.prepareBeforeToolCallParams = async (params) => {
        callerSession = getGatewayToolCallerIdentity()?.sessionKey;
        entered.resolve();
        await release.promise;
        return params;
      };
      const original = wrapToolWithAbortSignal(
        wrapToolWithGatewayCallerIdentity(wrapToolWithBeforeToolCallHook(source), {
          agentId: "main",
          sessionKey: "agent:main:wrapper-authority",
        }),
        controller.signal,
      );
      const rebuilt = rewrapToolWithBeforeToolCallHook(owner.wrap(original), {
        runId: "new-hooks",
      });
      const pending =
        phase === "execute"
          ? rebuilt.execute("canceled-preparation", {})
          : getInternalToolExecutionPreparer(rebuilt)!({
              toolCallId: "canceled-preparation",
              args: {},
            });
      await entered.promise;
      controller.abort();
      try {
        expect(callerSession).toBe("agent:main:wrapper-authority");
        await expect(pending).rejects.toThrow("Aborted");
        expect(source.execute).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        const result = await pending.catch(() => undefined);
        if (result && "dispose" in result) {
          result.dispose();
        }
        await owner.dispose();
      }
    },
  );

  it("recognizes wrapper metadata after module reevaluation and object spread", async () => {
    const source = createTool();
    const context = { runId: "cross-module-metadata" };
    const wrapped = wrapToolWithBeforeToolCallHook(source, context);
    const options = getBeforeToolCallDiagnosticOptions(wrapped);
    // Independent SDK source evaluation must share marker and host state with compiled core.
    vi.resetModules();
    const other = await import("./before-tool-call-metadata.js");
    const spread = { ...wrapped };
    expect(other.isToolWrappedWithBeforeToolCallHook(spread)).toBe(true);
    expect(other.getBeforeToolCallHookContext(spread)).toBe(context);
    expect(other.getBeforeToolCallSourceTool(wrapped)).toBe(source);
    expect(other.getBeforeToolCallDiagnosticOptions(spread)).toBe(options);
    other.setBeforeToolCallDiagnosticsEnabled(spread, false);
    expect(options?.emitDiagnostics).toBe(false);
  });

  it("preserves host context and mutable diagnostic identity through nested views and copies", async () => {
    const inner = new PluginInstance("inner-metadata");
    const outer = new PluginInstance("outer-metadata");
    const context = { runId: "metadata-run", onToolOutcome: vi.fn() };
    const wrapped = wrapToolWithBeforeToolCallHook(createTool(), context);
    const options = getBeforeToolCallDiagnosticOptions(wrapped);
    try {
      const view = outer.wrap(inner.wrap(wrapped));
      const copied = copyAgentToolMetadata(view, { ...view });
      expect(isToolWrappedWithBeforeToolCallHook(copied)).toBe(true);
      expect(getBeforeToolCallHookContext(view) === context).toBe(true);
      expect(getBeforeToolCallHookContext(copied) === context).toBe(true);
      expect(getBeforeToolCallDiagnosticOptions(copied) === options).toBe(true);
      setBeforeToolCallDiagnosticsEnabled(copied, false);
      expect(options?.emitDiagnostics).toBe(false);
      expect(context.onToolOutcome).not.toHaveBeenCalled();
    } finally {
      await Promise.all([inner.dispose(), outer.dispose()]);
    }
  });

  it.each(
    (["inner", "outer"] as const).flatMap((owner) =>
      (["execute", "prepare"] as const).map((phase) => ({ owner, phase })),
    ),
  )(
    "retains $owner admission for $phase after rewrapping with a new context",
    async ({ owner, phase }) => {
      const inner = new PluginInstance("inner-retirement");
      const outer = new PluginInstance("outer-retirement");
      const source = createTool();
      const prepare = vi.fn((params: unknown) => params);
      if (phase === "prepare") {
        source.prepareBeforeToolCallParams = prepare;
      }
      const context = { runId: "replacement-context", onToolOutcome: vi.fn() };
      const wrapped = wrapToolWithBeforeToolCallHook(
        source,
        { runId: "original-context" },
        {
          emitDiagnostics: false,
        },
      );
      try {
        const view = outer.wrap(inner.wrap(wrapped));
        const rewrapped = rewrapToolWithBeforeToolCallHook(view, context);
        expect(getBeforeToolCallHookContext(rewrapped)).toBe(context);
        await expect(rewrapped.execute("active-execute", {})).resolves.toMatchObject({
          content: [],
        });
        expect(source.execute).toHaveBeenCalledOnce();
        vi.mocked(source.execute).mockClear();
        prepare.mockClear();
        await (owner === "inner" ? inner : outer).dispose();

        await expect(rewrapped.execute("retired-execute", {})).rejects.toThrow(
          "reloaded or disabled",
        );
        if (phase === "prepare") {
          await expect(
            prepareBeforeToolCallExecutionParams({ tool: rewrapped, params: {} }),
          ).rejects.toThrow("reloaded or disabled");
        } else {
          const preparer = getInternalToolExecutionPreparer(rewrapped)!;
          const prepared = await preparer({ toolCallId: "retired-prepared-execute", args: {} });
          try {
            expect(prepared.kind).toBe("ready");
            if (prepared.kind === "ready") {
              await expect(prepared.execute()).rejects.toThrow("reloaded or disabled");
            }
          } finally {
            prepared.dispose();
          }
        }
        expect(source.execute).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        const rewrapAfterRetirement = async () =>
          rewrapToolWithBeforeToolCallHook(view, context).execute("retired-rewrap", {});
        await expect(rewrapAfterRetirement()).rejects.toThrow("reloaded or disabled");
      } finally {
        await Promise.all([inner.dispose(), outer.dispose()]);
      }
    },
  );
});
