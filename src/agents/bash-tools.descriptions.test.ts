/** Model-facing description contracts at the public Bash/process tool factory boundary. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { gateAgentToolExecution } from "./agent-tool-availability.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

const execDefaults = { host: "gateway", security: "full", ask: "off" } as const;
const execTool = createExecTool(execDefaults);
const processTool = createProcessTool();

afterEach(() => vi.restoreAllMocks());

describe("tool descriptions", () => {
  it("retains offered exec descriptors while a process execution gate refuses durable work", async () => {
    const exec = createLazyExecTool(execDefaults);
    const process = createProcessTool();
    const prepare = (continuation: typeof process) =>
      expectDefined(
        finalizeAgentTools({
          tools: [exec, continuation],
          hookContext: {},
          wrapBeforeToolCallHook: false,
        })[0],
        "finalized exec tool",
      );
    const offered = prepare(process);
    const gated = prepare(
      gateAgentToolExecution(process, "Completion turn cannot control processes."),
    );
    expect(gated.parameters).toEqual(offered.parameters);
    expect(gated.description).toBe(offered.description);
    for (const field of ["background", "durable", "yieldMs"]) {
      expect(gated.parameters).toHaveProperty(`properties.${field}`);
    }
    await expect(
      gated.execute("denied-durable", { command: "exit 99", background: true, durable: true }),
    ).rejects.toThrow("the process tool enabled");
  });

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
      "automatic completion wake, when enabled, occurs only after exit; otherwise process confirms completion",
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
});
