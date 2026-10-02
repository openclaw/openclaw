import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../../../../packages/agent-core/src/internal-hooks.js";
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
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../../tool-terminal-presentation.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";

const RUN = "test-run";
const wrap = (source: ReturnType<typeof createStubTool>) =>
  wrapEmbeddedAttemptToolWithActivity(source, RUN);

afterEach(() => clearToolActivityRun(RUN));

it("notifies only the current run's listeners and clears its activity", () => {
  const a = vi.fn();
  const b = vi.fn();
  const other = vi.fn();
  const unsubA = onToolActivity(RUN, a);
  onToolActivity(RUN, b);
  const unsubOther = onToolActivity("other-run", other);
  notifyToolActivity(RUN);
  expect(a).toHaveBeenCalledOnce();
  expect(b).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  expect(getLastToolActivityMs(RUN)).toBeGreaterThan(0);
  clearToolActivityRun(RUN);
  expect(getLastToolActivityMs(RUN)).toBe(0);
  notifyToolActivity(RUN);
  expect(a).toHaveBeenCalledOnce();
  expect(b).toHaveBeenCalledOnce();
  unsubA();
  unsubOther();
  clearToolActivityRun("other-run");
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
it("preserves execution and presentation metadata on heartbeat-wrapped tools", () => {
  const sourceTool = createStubTool("test-tool");
  const source = markCodeModeControlTool(wrapToolWithBeforeToolCallHook(sourceTool));
  const formatter = () => ({ text: "web_fetch: 3 pages" });
  setChannelAgentToolMeta(source as never, { channelId: "telegram" });
  setPluginToolMeta(source, { pluginId: "test-plugin", optional: false });
  setToolTerminalPresentation(source, formatter);
  const wrapped = wrap(source);
  expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
  expect(getPluginToolMeta(wrapped)?.pluginId).toBe("test-plugin");
  expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  expect(getBeforeToolCallSourceTool(wrapped)).toBe(sourceTool);
  expect(getToolTerminalPresentation(wrapped)).toBe(formatter);
  expect(isCodeModeControlTool(wrapped)).toBe(true);
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
