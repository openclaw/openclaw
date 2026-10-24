// Proves execution binds a native Claude login history owner to the environment it spawns with.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliExecutionHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  supervisorSpawnMock.mockReset();
});

/** A native writer whose spawn environment selects another login than the attested one. */
function driftedWriter(replaysHistory: boolean) {
  const calls: string[] = [];
  const writer: CliExecutionHistoryWriter = {
    target: { agentId: "main", sessionId: "s1", sessionKey: "agent:main:s1", storePath: "x" },
    runId: "run-test",
    authFingerprint: "f".repeat(64),
    bindsNativeLogin: true,
    replaysHistory,
    assertCurrent: () => {},
    assertReadable: async () => {},
    confirmsOwner: () => false,
    checkNativeLoginBoundary: () => {},
    // As the real writer does on a drifted login: refuse a turn carrying saved history,
    // and let any other turn run without coverage.
    bindExecutionEnv: vi.fn((_env: NodeJS.ProcessEnv, carriesSavedHistory: boolean) => {
      calls.push("bindExecutionEnv");
      if (carriesSavedHistory) {
        throw new Error("CLI history authority changed before execution");
      }
    }),
    settleNativeLogin: vi.fn(async () => void calls.push("settleNativeLogin")),
  };
  return { writer, calls };
}

function nativeContext(writer: CliExecutionHistoryWriter, calls: string[], history = false) {
  const context = buildPreparedCliRunContext({
    model: "fixture-model",
    backend: {
      command: "/bin/sh",
      args: [],
      output: "text",
      systemPromptFileArg: undefined,
      input: "stdin",
      env: { CLAUDE_CONFIG_DIR: "/fixture/backend-selected" },
    },
  });
  context.cliHistoryWriter = writer;
  if (history) {
    context.openClawHistoryPrompt = "saved history";
  }
  supervisorSpawnMock.mockImplementation(async () => {
    calls.push("spawn");
    return createManagedRun({ ...createSuccessfulProcessExit(), durationMs: 1, stdout: "done" });
  });
  return context;
}

describe("native login history owner at execution", () => {
  it("binds the owner to the environment the child is spawned with", async () => {
    const { writer, calls } = driftedWriter(false);
    const context = nativeContext(writer, calls);
    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
    const [boundEnv] = vi.mocked(writer.bindExecutionEnv).mock.calls[0] ?? [];
    expect(boundEnv).toMatchObject({ CLAUDE_CONFIG_DIR: "/fixture/backend-selected" });
    expect(supervisorSpawnMock.mock.lastCall?.[0].env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/fixture/backend-selected",
    });
    // A turn without saved history runs; the token the child may rotate is attested after it.
    expect(calls).toEqual(["bindExecutionEnv", "spawn", "settleNativeLogin"]);
  });

  it("spawns nothing for a fresh recovery turn whose environment selects another login", async () => {
    const { writer, calls } = driftedWriter(true);
    const context = nativeContext(writer, calls, true);
    await expect(executePreparedCliRun(context)).rejects.toThrow("CLI history authority changed");
    expect(calls).not.toContain("spawn");
  });

  it("spawns nothing for a resumed turn that replays history under another login", async () => {
    // Durable reference context and interrupted inputs reach a resumed session too.
    const { writer, calls } = driftedWriter(true);
    const context = nativeContext(writer, calls);
    await expect(executePreparedCliRun(context, "resumed-session")).rejects.toThrow(
      "CLI history authority changed",
    );
    expect(calls).not.toContain("spawn");
  });

  it("settles the native login even when the run fails", async () => {
    const { writer, calls } = driftedWriter(false);
    const context = nativeContext(writer, calls);
    supervisorSpawnMock.mockImplementation(async () => {
      calls.push("spawn");
      throw new Error("child failed");
    });
    await expect(executePreparedCliRun(context)).rejects.toThrow();
    expect(calls.slice(-2)).toEqual(["spawn", "settleNativeLogin"]);
  });
});
