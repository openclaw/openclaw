import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import {
  clearToolActivityRun,
  getLastToolActivityMs,
  notifyToolActivity,
  onToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import {
  getBeforeToolCallSourceTool,
  isToolWrappedWithBeforeToolCallHook,
} from "../../before-tool-call-metadata.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../../channel-tool-metadata.js";
import { isCodeModeControlTool, markCodeModeControlTool } from "../../code-mode-control-tools.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../../tool-terminal-presentation.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";

const RUN = "test-run";
const wrap = (source: ReturnType<typeof createStubTool>) =>
  wrapEmbeddedAttemptToolWithActivity(source, RUN);

describe("tool-activity-heartbeat", () => {
  afterEach(() => clearToolActivityRun(RUN));

  it("supports multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();

    const unsubA = onToolActivity(RUN, a);
    onToolActivity(RUN, b);
    notifyToolActivity(RUN);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
  });

  it("scopes listeners per run - does not cross-fire", () => {
    const runAListener = vi.fn();
    const runBListener = vi.fn();

    onToolActivity("run-a", runAListener);
    onToolActivity("run-b", runBListener);
    notifyToolActivity("run-a");

    expect(runAListener).toHaveBeenCalledTimes(1);
    expect(runBListener).not.toHaveBeenCalled();
  });

  it("clearToolActivityRun removes listeners and last-activity timestamp", () => {
    const listener = vi.fn();
    onToolActivity(RUN, listener);
    notifyToolActivity(RUN);
    expect(getLastToolActivityMs(RUN)).toBeGreaterThan(0);

    clearToolActivityRun(RUN);
    expect(getLastToolActivityMs(RUN)).toBe(0);

    notifyToolActivity(RUN);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(["unsubscribe", "clear"])(
    "stale unsubscribe preserves replacement run listeners after %s",
    (retirement) => {
      const oldListener = vi.fn();
      const replacementListener = vi.fn();
      const unsubscribe = onToolActivity(RUN, oldListener);
      if (retirement === "clear") {
        clearToolActivityRun(RUN);
      } else {
        unsubscribe();
      }
      notifyToolActivity(RUN);
      expect(oldListener).not.toHaveBeenCalled();
      onToolActivity(RUN, replacementListener);
      unsubscribe();
      notifyToolActivity(RUN);
      expect(replacementListener).toHaveBeenCalledOnce();
      expect(oldListener).not.toHaveBeenCalled();
    },
  );
  it("preserves channel tool metadata on heartbeat-wrapped tools", () => {
    const source = createStubTool("test-tool");
    setChannelAgentToolMeta(source as never, { channelId: "telegram" });
    const wrapped = wrap(source);
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
  });

  it("preserves plugin tool metadata on heartbeat-wrapped tools", () => {
    const source = { name: "test-tool", execute: vi.fn() as never };
    setPluginToolMeta(source as never, { pluginId: "test-plugin", optional: false });

    const wrapped = wrapEmbeddedAttemptToolWithActivity(source as never, RUN) as typeof source;

    const meta = getPluginToolMeta(wrapped as never);
    expect(meta?.pluginId).toBe("test-plugin");
  });

  it("preserves before-tool-call marker on heartbeat-wrapped tools", () => {
    const sourceTool = createStubTool("test-tool");
    const source = wrapToolWithBeforeToolCallHook(sourceTool);
    const wrapped = wrap(source);
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
    expect(getBeforeToolCallSourceTool(wrapped)).toBe(sourceTool);
  });

  it("preserves terminal presentation metadata on heartbeat-wrapped tools", () => {
    const source = createStubTool("test-tool");
    const formatter = () => ({ text: "web_fetch: 3 pages" });
    setToolTerminalPresentation(source, formatter);
    const copiedFormatter = getToolTerminalPresentation(wrap(source));
    expect(copiedFormatter).toBe(formatter);
    expect(copiedFormatter?.(undefined, { content: [] } as never)?.text).toBe("web_fetch: 3 pages");
  });

  it("preserves code-mode control identity on heartbeat-wrapped tools", () => {
    const source = markCodeModeControlTool(createStubTool("exec"));
    expect(isCodeModeControlTool(wrap(source))).toBe(true);
  });

  it("applies heartbeat ownership to private preparation and execution", async () => {
    const body = vi.fn(async () => ({ content: [], details: {} }));
    const source = attachInternalToolExecutionPreparer(createStubTool("test-tool"), async () => ({
      kind: "ready",
      args: {},
      execute: body,
      dispose: vi.fn(),
    }));
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(wrap(source)),
      "heartbeat-adapted preparer",
    );

    const prepared = await preparer({ toolCallId: "heartbeat-call", args: {} });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      await prepared.execute();
    }

    expect(body).toHaveBeenCalledOnce();
    expect(getLastToolActivityMs(RUN)).toBeTypeOf("number");
  });
});
