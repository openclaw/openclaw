import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createCanonicalFixtureSkill } from "../../../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";

describe("createSubscribedToolSearchExecutor", () => {
  it("prepares tool arguments before lifecycle and execution", async () => {
    const preparedInput = { query: "orchid codename", maxResults: 3 };
    const prepareArguments = vi.fn(() => preparedInput);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = {
      name: "memory_search",
      prepareArguments,
      execute,
    } as unknown as AnyAgentTool;
    let lifecycleArgs: unknown;
    const runToolLifecycle = vi.fn(
      async ({
        args,
        execute: run,
      }: {
        args: unknown;
        execute: (onImplementationStart: () => void) => Promise<unknown>;
      }) => {
        lifecycleArgs = args;
        return await run(() => {});
      },
    );
    const runSignal = new AbortController().signal;
    const executor = createSubscribedToolSearchExecutor({
      attempt: { runId: "run", sessionKey: "key" },
      runSignal,
      sessionManager: { getAppendParentId: () => undefined } as never,
      subscription: { runToolLifecycle } as never,
      isCurrent: () => true,
      isReplaySafeTool: () => true,
      nestedToolActivityState: { scopeId: "scope", successfulToolNames: new Set() },
    });

    await executor({
      tool,
      toolName: "memory_search",
      source: "openclaw",
      sourceName: "memory-core",
      toolCallId: "call",
      input: { query: "orchid codename", min_score: 0.01, max_results: 3 },
      acceptResultBeforeProjection: async (result) => result,
    });

    expect(prepareArguments).toHaveBeenCalledWith({
      query: "orchid codename",
      min_score: 0.01,
      max_results: 3,
    });
    expect(lifecycleArgs).toBe(preparedInput);
    expect(execute).toHaveBeenCalledWith("call", preparedInput, expect.any(AbortSignal), undefined);
  });

  it("adds the skill a nested call used to its activity, not to the validated result", async () => {
    const runId = "run-nested-skill";
    const skillDir = path.join("/workspace", ".agents", "skills", "demo-skill");
    const toolResult = {
      content: [{ type: "text" as const, text: "# Demo" }],
      details: { kind: "text", content: "# Demo" },
    };
    const read = wrapToolWithBeforeToolCallHook(
      { name: "read", execute: async () => toolResult } as unknown as AnyAgentTool,
      {
        runId,
        workspaceDir: "/workspace",
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "demo-skill" }],
          resolvedSkills: [
            createCanonicalFixtureSkill({
              name: "demo-skill",
              description: "Demo",
              filePath: path.join(skillDir, "SKILL.md"),
              baseDir: skillDir,
              source: "workspace",
            }),
          ],
        },
      },
    );
    const runToolLifecycle = vi.fn(
      async (lifecycle: {
        args: unknown;
        execute: (onImplementationStart: () => void) => Promise<unknown>;
        onTerminal: (terminal: unknown) => Promise<void>;
      }) => {
        const result = await lifecycle.execute(() => {});
        await lifecycle.onTerminal({
          executedArguments: lifecycle.args,
          readSanitizedResult: () => result,
          isError: false,
        });
        return result;
      },
    );
    const appendMessageAsync = vi.fn(async (_message: unknown) => "entry");
    const executor = createSubscribedToolSearchExecutor({
      attempt: { runId, sessionKey: "key" },
      runSignal: new AbortController().signal,
      sessionManager: {
        getAppendParentId: () => null,
        getSessionTarget: () => undefined,
        getSessionId: () => "session",
        appendMessageAsync,
      } as never,
      subscription: { runToolLifecycle } as never,
      isCurrent: () => true,
      isReplaySafeTool: () => true,
      nestedToolActivityState: { scopeId: "scope", successfulToolNames: new Set() },
    });
    const accepted: unknown[] = [];
    for (const [toolCallId, filePath] of [
      ["nested-skill", ".agents/skills/demo-skill/SKILL.md"],
      ["nested-readme", "README.md"],
    ] as const) {
      await executor({
        tool: read,
        toolName: "read",
        source: "openclaw",
        toolCallId,
        input: { path: filePath },
        acceptResultBeforeProjection: async (result) => {
          accepted.push(result);
          return result;
        },
      });
    }

    // Output-schema validation sees exactly what the tool returned.
    expect(accepted).toEqual([toolResult, toolResult]);
    expect(
      appendMessageAsync.mock.calls.map(
        ([message]) => readNestedToolActivity(message)?.details.result,
      ),
    ).toEqual([
      {
        ...toolResult,
        details: {
          ...toolResult.details,
          openclawSkillUsage: {
            skillName: "demo-skill",
            skillSource: "workspace",
            activation: "read",
          },
        },
      },
      toolResult,
    ]);
  });

  it("runs argument preparation failures through the nested lifecycle", async () => {
    const input = { query: "orchid codename", min_score: 0.01 };
    const error = new Error("invalid arguments");
    const prepareArguments = vi.fn(() => {
      throw error;
    });
    const execute = vi.fn();
    const tool = {
      name: "memory_search",
      prepareArguments,
      execute,
    } as unknown as AnyAgentTool;
    let lifecycleArgs: unknown;
    const runToolLifecycle = vi.fn(
      async ({
        args,
        execute: run,
      }: {
        args: unknown;
        execute: (onImplementationStart: () => void) => Promise<unknown>;
      }) => {
        lifecycleArgs = args;
        return await run(() => {});
      },
    );
    const executor = createSubscribedToolSearchExecutor({
      attempt: { runId: "run", sessionKey: "key" },
      runSignal: new AbortController().signal,
      sessionManager: { getAppendParentId: () => undefined } as never,
      subscription: { runToolLifecycle } as never,
      isCurrent: () => true,
      isReplaySafeTool: () => true,
      nestedToolActivityState: { scopeId: "scope", successfulToolNames: new Set() },
    });

    await expect(
      executor({
        tool,
        toolName: "memory_search",
        source: "openclaw",
        sourceName: "memory-core",
        toolCallId: "call",
        input,
        acceptResultBeforeProjection: async (result) => result,
      }),
    ).rejects.toBe(error);

    expect(prepareArguments).toHaveBeenCalledWith(input);
    expect(lifecycleArgs).toBe(input);
    expect(execute).not.toHaveBeenCalled();
  });
});
