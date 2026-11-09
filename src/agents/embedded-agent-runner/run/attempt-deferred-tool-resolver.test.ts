import { describe, expect, it } from "vitest";
import {
  captureAgentLoop,
  config as loopConfig,
  createTurnSequenceStream,
  makeCall,
  makeTool,
  toolResultMessages,
  user,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
} from "../../tool-search.js";
import { createAttemptDeferredToolResolver } from "./attempt-deferred-tool-resolver.js";

describe("createAttemptDeferredToolResolver", () => {
  it("runs a deferred tool only through dispatch_action in Tool Search tools mode", async () => {
    const config: OpenClawConfig = { tools: { toolSearch: true } };
    const catalogRef = createToolSearchCatalogRef();
    const executed: string[] = [];
    const { tools } = applyToolSearchCatalog({
      tools: [...createToolSearchTools({ config, catalogRef }), makeTool("probe_write", executed)],
      config,
      catalogRef,
    });
    const resolveDeferredTool = createAttemptDeferredToolResolver({
      attempt: { config, sessionId: "session", runId: "run" },
      clientToolPreparation: {
        catalogToolHookContext: undefined,
        deferredDirectoryToolsCallable: false,
        effectiveTools: tools,
        toolSearchCatalogRef: catalogRef,
      },
      runAbortSignal: new AbortController().signal,
      sessionAgentId: "main",
    });
    const dispatch = {
      ...makeCall("dispatch_action", "dispatch"),
      arguments: { id: "probe_write", args: {} },
    };
    const executedAtRequest: number[] = [];
    try {
      const run = captureAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools },
        { ...loopConfig, resolveDeferredTool },
        undefined,
        createTurnSequenceStream(
          [[makeCall("probe_write", "direct")], [dispatch], [{ type: "text", text: "done" }]],
          [],
          () => executedAtRequest.push(executed.length),
        ),
      );
      await run.result;

      expect(toolResultMessages(run.events)[0]).toMatchObject({
        toolName: "probe_write",
        isError: true,
        content: [
          {
            type: "text",
            text: 'Tool probe_write is deferred and not directly callable. Call dispatch_action with id "probe_write" and its parameters in args.',
          },
        ],
      });
      expect(executedAtRequest).toEqual([0, 0, 1]);
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  });
});
