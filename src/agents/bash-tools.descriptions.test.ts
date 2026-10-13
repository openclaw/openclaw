/** Model-facing description contracts at the public Bash/process tool factory boundary. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

const execDefaults = { host: "gateway", security: "full", ask: "off" } as const;
const execTool = createExecTool(execDefaults);
const processTool = createProcessTool();

afterEach(() => vi.restoreAllMocks());

describe("tool descriptions", () => {
  it.each(["auto", "ask"] as const)(
    "includes denial guidance only for auto review through finalization: %s",
    (mode) => {
      const guidance =
        "An automatic reviewer may deny a command and explain why; if denied, choose a materially safer alternative or ask the user, never work around the denial.";
      for (const createTool of [createExecTool, createLazyExecTool]) {
        const tool = createTool({ ...execDefaults, mode });
        const [finalized] = finalizeAgentTools({
          tools: [tool],
          hookContext: {},
          wrapBeforeToolCallHook: false,
        });
        for (const description of [
          tool.description,
          expectDefined(finalized, "finalized exec tool").description,
        ]) {
          expect(description.includes(guidance)).toBe(mode === "auto");
        }
      }
    },
  );

  it.each(["win32"] as const)(
    "keeps exec descriptors stable across approval changes on %s",
    (platform) =>
      withMockedPlatform(platform, () => {
        const file: execApprovals.ExecApprovalsFile = {
          version: 1,
          agents: { main: { allowlist: [] } },
        };
        vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => file);
        const descriptors = () => {
          const tools = [
            createExecTool({ ...execDefaults, agentId: "main" }),
            createLazyExecTool({ ...execDefaults, agentId: "main" }),
          ];
          return JSON.stringify(
            [
              ...tools,
              ...tools.flatMap((tool) =>
                finalizeAgentTools({
                  tools: [tool],
                  hookContext: {},
                  wrapBeforeToolCallHook: false,
                }),
              ),
            ].map(({ name, description, parameters }) => ({ name, description, parameters })),
          );
        };
        const before = descriptors();
        file.agents!.main!.allowlist!.push({
          pattern: "C:\\Tools\\node.exe",
          argPattern: "--version",
        });
        expect(descriptors()).toBe(before);
      }),
  );
  it("adds automation follow-up guidance only when the scheduler is available", () => {
    const execWithCron = createExecTool({ ...execDefaults, hasCronTool: true });
    const processWithCron = createProcessTool({ hasCronTool: true });

    expect(execWithCron.description).toContain(
      "automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion",
    );
    expect(processWithCron.description).toContain("completion without auto-wake");
    expect(processWithCron.description).toContain("write, send-keys, submit, paste, kill");
    expect(execWithCron.description).toContain(
      "No sleep loops for reminders/follow-ups; use automations.",
    );
    expect(processWithCron.description).toContain(
      "No polling as timer/reminder; scheduled follow-up uses automations.",
    );
    expect(execTool.description).not.toContain("use cron instead");
    expect(processTool.description).not.toContain("scheduled follow-ups");
    expect(execTool.description).toContain("otherwise process confirms completion");
    expect(processTool.description).toContain("completion without auto-wake");
    expect(processTool.description).toContain("write, send-keys, submit, paste, kill");
  });

  it("names only dedicated file-writing tools that survived filtering", () => {
    const guidanceFor = (names: readonly string[]) =>
      `File writes: prefer dedicated file-writing tools (${names.join("/")}) over shell heredocs or bash -c for multi-line content.`;
    const fileTool = (name: string) => ({
      name,
      label: name,
      description: `${name} tool`,
      parameters: {},
      execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: undefined }),
    });
    const cases = [
      { tools: [] as string[], expected: undefined },
      { tools: ["write"], expected: ["write"] },
      { tools: ["edit"], expected: ["edit"] },
      { tools: ["apply_patch", "write"], expected: ["write", "apply_patch"] },
      { tools: ["apply_patch", "edit", "write"], expected: ["write", "edit", "apply_patch"] },
    ] as const;

    for (const createTool of [createExecTool, createLazyExecTool]) {
      for (const testCase of cases) {
        const exec = createTool({ ...execDefaults });
        const finalized = finalizeAgentTools({
          tools: [exec, ...testCase.tools.map((name) => fileTool(name))],
          hookContext: {},
          wrapBeforeToolCallHook: false,
        });
        const descriptions = [
          ...(createTool === createLazyExecTool ? [exec.description] : []),
          expectDefined(
            finalized.find((tool) => tool.name === "exec"),
            "finalized exec tool",
          ).description,
        ];
        for (const description of descriptions) {
          if (!testCase.expected) {
            expect(description).not.toContain("File writes:");
            continue;
          }
          expect(description).toContain(guidanceFor(testCase.expected));
          const named = description.match(
            /File writes: prefer dedicated file-writing tools \(([^)]+)\)/,
          )?.[1];
          expect(named).toBe(testCase.expected.join("/"));
        }
      }
    }
  });
});
