import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  prepareBeforeToolCallExecutionParams as prepareParams,
  rewrapToolWithBeforeToolCallHook as rewrap,
  wrapToolWithBeforeToolCallHook as wrap,
} from "./agent-tools.before-tool-call.wrapper.js";
import * as metadata from "./before-tool-call-metadata.js";
import { getInternalToolExecutionPreparer as getPreparer } from "./runtime/internal-hooks.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import type { AnyAgentTool } from "./tools/common.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./tools/gateway-caller-context.js";

const createTool = (): AnyAgentTool => ({
  ...createStubTool("metadata_fixture"),
  execute: vi.fn(async () => ({ content: [], details: {} })),
});

const owners: PluginInstance[] = [];
function createOwner(name: string) {
  const owner = new PluginInstance(name);
  owners.push(owner);
  return owner;
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
});
function createView(tool: AnyAgentTool) {
  const inner = createOwner("inner-metadata");
  const outer = createOwner("outer-metadata");
  return { inner, outer, view: outer.wrap(inner.wrap(tool)) };
}
const expectRetired = (pending: Promise<unknown>) =>
  expect(pending).rejects.toThrow("reloaded or disabled");

it.each(["execute", "prepare"] as const)(
  "preserves caller authority and cancellation in rebuilt %s",
  async (phase) => {
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    const owner = createOwner("wrapped-authority");
    const source = createTool();
    let callerSession: string | undefined;
    source.prepareBeforeToolCallParams = async (params) => {
      callerSession = getGatewayToolCallerIdentity()?.sessionKey;
      entered.resolve();
      await release.promise;
      return params;
    };
    const original = wrapToolWithAbortSignal(
      wrapToolWithGatewayCallerIdentity(wrap(source), {
        agentId: "main",
        sessionKey: "agent:main:wrapper-authority",
      }),
      controller.signal,
    );
    const rebuilt = rewrap(owner.wrap(original), { runId: "new-hooks" });
    const pending =
      phase === "execute"
        ? rebuilt.execute("canceled-preparation", {})
        : getPreparer(rebuilt)!({ toolCallId: "canceled-preparation", args: {} });
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
    }
  },
);

it.each(["module reevaluation and spread", "nested plugin views and copy"])(
  "preserves host metadata identity through %s",
  async (mode) => {
    const source = createTool();
    const context = { runId: "metadata-run", onToolOutcome: vi.fn() };
    const wrapped = wrap(source, context);
    const options = metadata.getBeforeToolCallDiagnosticOptions(wrapped);
    let reader = metadata;
    let copied: AnyAgentTool;
    if (mode === "module reevaluation and spread") {
      // Independent SDK evaluation must share the compiled host's marker and state.
      vi.resetModules();
      reader = await import("./before-tool-call-metadata.js");
      copied = { ...wrapped };
      expect(reader.getBeforeToolCallSourceTool(wrapped)).toBe(source);
    } else {
      const { view } = createView(wrapped);
      copied = copyAgentToolMetadata(view, { ...view });
      expect(reader.getBeforeToolCallHookContext(view)).toBe(context);
    }
    expect(reader.isToolWrappedWithBeforeToolCallHook(copied)).toBe(true);
    expect(reader.getBeforeToolCallHookContext(copied)).toBe(context);
    expect(reader.getBeforeToolCallDiagnosticOptions(copied)).toBe(options);
    reader.setBeforeToolCallDiagnosticsEnabled(copied, false);
    expect(options?.emitDiagnostics).toBe(false);
    expect(context.onToolOutcome).not.toHaveBeenCalled();
  },
);

it.each(
  (["inner", "outer"] as const).flatMap((owner) =>
    (["execute", "prepare"] as const).map((phase) => ({ owner, phase })),
  ),
)("retains $owner admission for rewrapped $phase", async ({ owner, phase }) => {
  const source = createTool();
  const prepare = vi.fn((params: unknown) => params);
  if (phase === "prepare") {
    source.prepareBeforeToolCallParams = prepare;
  }
  const context = { runId: "replacement-context", onToolOutcome: vi.fn() };
  const { inner, outer, view } = createView(
    wrap(source, { runId: "original" }, { emitDiagnostics: false }),
  );
  const rewrapped = rewrap(view, context);
  expect(metadata.getBeforeToolCallHookContext(rewrapped)).toBe(context);
  await expect(rewrapped.execute("active-execute", {})).resolves.toMatchObject({ content: [] });
  expect(source.execute).toHaveBeenCalledOnce();
  vi.mocked(source.execute).mockClear();
  prepare.mockClear();
  await (owner === "inner" ? inner : outer).dispose();

  await expectRetired(rewrapped.execute("retired-execute", {}));
  if (phase === "prepare") {
    await expectRetired(prepareParams({ tool: rewrapped, params: {} }));
  } else {
    const preparer = getPreparer(rewrapped)!;
    const prepared = await preparer({ toolCallId: "retired-prepared-execute", args: {} });
    try {
      expect(prepared.kind).toBe("ready");
      if (prepared.kind === "ready") {
        await expectRetired(prepared.execute());
      }
    } finally {
      prepared.dispose();
    }
  }
  expect(source.execute).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  await expectRetired((async () => rewrap(view, context).execute("retired-rewrap", {}))());
});
