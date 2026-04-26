import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createCompletionTruthPublicHostHook,
  normalizeSessionsHistoryMessages,
  selectCompletionTruth,
} from "./completion-truth.js";

describe("completion-truth internal barrel", () => {
  it("exports the internal completion truth seam for agent runtime code", () => {
    expect(
      selectCompletionTruth({
        realtimeHint: {
          source: "sessions_yield",
          status: "yielded",
          worker_id: "hint",
        },
      }),
    ).toMatchObject({
      source: "realtimeHint",
      result: {
        source: "sessions_yield",
        status: "yielded",
        worker_id: "hint",
      },
    });

    expect(createCompletionTruthPublicHostHook()).toEqual(
      expect.objectContaining({
        yieldQueue: expect.any(Object),
        toolResultQueue: expect.any(Object),
      }),
    );

    expect(
      normalizeSessionsHistoryMessages([
        {
          role: "tool",
          name: "sessions_yield",
          result: {
            source: "sessions_yield",
            status: "yielded",
            worker_id: "done",
          },
        },
      ]),
    ).toEqual([
      {
        role: "tool",
        toolName: "sessions_yield",
        toolResult: {
          source: "sessions_yield",
          status: "yielded",
          worker_id: "done",
        },
      },
    ]);
  });

  it("keeps completion truth off public package/plugin-sdk exports", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const exportKeys = Object.keys(packageJson.exports ?? {});
    const pluginAgentHarness = fs.readFileSync("src/plugin-sdk/agent-harness.ts", "utf8");
    const pluginAgentHarnessRuntime = fs.readFileSync(
      "src/plugin-sdk/agent-harness-runtime.ts",
      "utf8",
    );
    const piTools = fs.readFileSync("src/agents/pi-tools.ts", "utf8");
    const publicOptionsStart = piTools.indexOf("export type OpenClawCodingToolsOptions");
    const internalOptionsStart = piTools.indexOf("type InternalOpenClawCodingToolsOptions");
    expect(publicOptionsStart).toBeGreaterThanOrEqual(0);
    expect(internalOptionsStart).toBeGreaterThan(publicOptionsStart);
    const publicOptions = piTools.slice(publicOptionsStart, internalOptionsStart);

    expect(exportKeys.filter((key) => key.includes("completion-truth"))).toEqual([]);
    expect(exportKeys.filter((key) => key.includes("completionTruth"))).toEqual([]);
    expect(exportKeys.filter((key) => key.includes("completion-truth"))).not.toContain(
      "./plugin-sdk/completion-truth",
    );
    expect(pluginAgentHarness).not.toContain("createOpenClawCodingToolsInternal");
    expect(pluginAgentHarnessRuntime).not.toContain("CompletionWorkerOutput");
    expect(pluginAgentHarnessRuntime).not.toContain("CompletionTruthSelection");
    expect(pluginAgentHarnessRuntime).not.toContain("completion-truth");
    expect(publicOptions).not.toContain("onCompletionTruth");
    expect(publicOptions).not.toContain("SessionsYieldCompletionOutput");
  });
});
