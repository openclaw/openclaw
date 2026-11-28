import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  captureAgent,
  createTurnSequenceStream,
  makeCall,
  makeTool,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { applyCodeModeCatalog, createCodeModeTools } from "../../code-mode.js";
import { createWriteTool } from "../../sessions/tools/write.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  restrictToolSearchCatalog,
} from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createAttemptDeferredToolResolver } from "./attempt-deferred-tool-resolver.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("recovers a deferred structured call only through dispatch_action", async () => {
  const workspace = tempDirs.make("tool-search-direct-recovery-");
  const target = { ...createWriteTool(workspace), name: "probe_write" };
  const execute = vi.spyOn(target, "execute");
  const config = { tools: { toolSearch: { mode: "tools" as const } } };
  const catalogRef = createToolSearchCatalogRef();
  const ctx = { config, catalogRef };
  onTestFinished(() => clearToolSearchCatalog(ctx));
  const { tools } = applyToolSearchCatalog({
    ...ctx,
    tools: [...createToolSearchTools(ctx), target, makeTool("denied_write")],
  });
  restrictToolSearchCatalog({ catalogRef, allowedToolNames: new Set(["probe_write"]) });
  const resolveDeferredTool = createAttemptDeferredToolResolver({
    attempt: { config, sessionId: "session", runId: "run" },
    clientTools: {
      codeModeControlsEnabledForRun: false,
      deferredDirectoryToolsCallable: false,
      toolSearchCatalogRef: catalogRef,
      catalogToolHookContext: undefined,
    },
    customTools: tools,
    runAbortSignal: new AbortController().signal,
    sessionAgentId: "main",
  });
  const input = { path: "result.txt", content: "written through dispatch_action\n" };
  const { agent } = captureAgent(tools, {
    resolveDeferredTool,
    streamFn: createTurnSequenceStream(
      [
        [
          { ...makeCall("probe_write"), arguments: input },
          makeCall("denied_write"),
          makeCall("unknown_tool"),
        ],
        [{ ...makeCall("dispatch_action"), arguments: { id: "probe_write", args: input } }],
        [{ type: "text", text: "done" }],
      ],
      [],
      (context, turn) => {
        expect(context.tools?.some((tool) => tool.name === "probe_write")).toBe(false);
        if (turn === 2) {
          expect(execute).not.toHaveBeenCalled();
        }
      },
    ),
  });
  await agent.prompt("write the result");
  const results = agent.state.messages.filter((message) => message.role === "toolResult");
  expect(results[0]).toMatchObject({
    isError: true,
    content: [
      { type: "text", text: expect.stringContaining('Call dispatch_action with id "probe_write"') },
    ],
  });
  expect(results.slice(1, 3).map((result) => result.content)).toEqual([
    [{ type: "text", text: "Tool denied_write not found" }],
    [{ type: "text", text: "Tool unknown_tool not found" }],
  ]);
  expect(results[3]).toMatchObject({ toolName: "dispatch_action", isError: false });
  expect(execute).toHaveBeenCalledOnce();
  expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe(input.content);
});

it.each(["tools", "code-mode"] as const)(
  "loads an on-demand tool on its first direct call in %s and keeps its screenshot",
  async (mode) => {
    const screenshot = { type: "image" as const, data: "c2NyZWVu", mimeType: "image/png" };
    const content = [{ type: "text" as const, text: "frame 1" }, screenshot];
    const execute = vi.fn(async () => ({ content, details: {} }));
    const target: AnyAgentTool = { ...makeTool("probe_screen"), catalogMode: "on-demand", execute };
    const config = { tools: mode === "tools" ? { toolSearch: { mode } } : { codeMode: true } };
    const catalogRef = { ...createToolSearchCatalogRef(), loadsOnDemandTools: true as const };
    const ctx = { config, runtimeConfig: config, catalogRef };
    onTestFinished(() => clearToolSearchCatalog(ctx));
    const { tools } =
      mode === "tools"
        ? applyToolSearchCatalog({ ...ctx, tools: [...createToolSearchTools(ctx), target] })
        : applyCodeModeCatalog({ ...ctx, tools: [...createCodeModeTools(ctx), target] });
    const promoted: string[] = [];
    const resolveDeferredTool = createAttemptDeferredToolResolver({
      attempt: { config, sessionId: "session", runId: "run" },
      clientTools: {
        codeModeControlsEnabledForRun: mode === "code-mode",
        deferredDirectoryToolsCallable: false,
        toolSearchCatalogRef: catalogRef,
        catalogToolHookContext: undefined,
        onPromoteTool: (tool) => promoted.push(tool.name),
      },
      customTools: tools,
      runAbortSignal: new AbortController().signal,
      sessionAgentId: "main",
    });
    const call = (id: string) => [{ ...makeCall("probe_screen", id), arguments: {} }];
    const firstRequestTools: string[] = [];
    const { agent } = captureAgent(tools, {
      resolveDeferredTool,
      streamFn: createTurnSequenceStream(
        [call("first"), call("second"), [{ type: "text", text: "done" }]],
        [],
        (context, turn) =>
          turn === 1 && firstRequestTools.push(...context.tools!.map((t) => t.name)),
      ),
    });
    await agent.prompt("look at the screen");
    expect(firstRequestTools).not.toContain("probe_screen");
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results.map((result) => [result.isError, result.content])).toEqual([
      [false, content],
      [false, content],
    ]);
    expect(promoted).toEqual(["probe_screen"]);
  },
);
