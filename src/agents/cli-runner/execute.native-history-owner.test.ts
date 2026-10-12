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

function writerStub(bindsNativeLogin: boolean) {
  const calls: string[] = [];
  const writer: CliExecutionHistoryWriter = {
    target: { agentId: "main", sessionId: "s1", sessionKey: "agent:main:s1", storePath: "x" },
    runId: "run-test",
    authFingerprint: "f".repeat(64),
    bindsNativeLogin,
    assertCurrent: vi.fn(() => void calls.push("assertCurrent")),
    assertReadable: vi.fn(() => void calls.push("assertReadable")),
    confirmsOwner: vi.fn(() => true),
    checkNativeLoginBoundary: vi.fn(() => void calls.push("checkNativeLoginBoundary")),
    bindExecutionEnv: vi.fn(() => void calls.push("bindExecutionEnv")),
    replaysHistory: true,
    settleNativeLogin: vi.fn(async () => void calls.push("settleNativeLogin")),
  };
  return { writer, calls };
}

function nativeContext(writer: CliExecutionHistoryWriter, history = false, calls?: string[]) {
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
  // The supervisor runs beforeSpawn as its synchronous launch admission.
  supervisorSpawnMock.mockImplementation(async (input) => {
    input.beforeSpawn?.();
    calls?.push("spawn");
    return createManagedRun({ ...createSuccessfulProcessExit(), durationMs: 1, stdout: "done" });
  });
  return context;
}

describe("native login history owner at execution", () => {
  it("binds the spawned environment and checks the login at launch, without saved history", async () => {
    const { writer, calls } = writerStub(true);
    // A refresh-due turn runs without saved history.
    writer.replaysHistory = false;
    const context = nativeContext(writer, false, calls);
    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
    expect(writer.bindExecutionEnv).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writer.bindExecutionEnv).mock.calls[0]?.[0]).toMatchObject({
      CLAUDE_CONFIG_DIR: "/fixture/backend-selected",
    });
    expect(vi.mocked(writer.bindExecutionEnv).mock.calls[0]?.[1]).toBe(false);
    expect(supervisorSpawnMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/fixture/backend-selected" }),
      }),
    );
    // Bind to the final environment, one fresh boundary check at launch, the spawn, and the
    // post-run attestation of any token the child rotated, before its rows commit.
    // The proof check guards the run's authority; it never reads the login.
    expect(calls.filter((call) => call !== "assertReadable")).toEqual([
      "bindExecutionEnv",
      "checkNativeLoginBoundary",
      "spawn",
      "settleNativeLogin",
    ]);
    expect(writer.checkNativeLoginBoundary).toHaveBeenCalledWith(false);
    // Liveness checks never go through the login lookup.
    expect(writer.assertCurrent).not.toHaveBeenCalled();
  });

  it("treats a resumed turn that replays history as carrying saved history", async () => {
    // Durable reference context and interrupted inputs reach a resumed session too.
    const { writer } = writerStub(true);
    const context = nativeContext(writer);
    await executePreparedCliRun(context, "resumed-session");
    expect(vi.mocked(writer.bindExecutionEnv).mock.calls[0]?.[1]).toBe(true);
    expect(writer.checkNativeLoginBoundary).toHaveBeenCalledWith(true);
    expect(writer.assertReadable).toHaveBeenCalled();
  });

  it("spawns nothing when the launch boundary refuses the login", async () => {
    const { writer, calls } = writerStub(true);
    vi.mocked(writer.checkNativeLoginBoundary).mockImplementation(() => {
      throw new Error("CLI history authority changed before execution");
    });
    const context = nativeContext(writer, true, calls);
    await expect(executePreparedCliRun(context)).rejects.toThrow("CLI history authority changed");
    expect(calls).not.toContain("spawn");
  });

  it("settles the native login even when the run fails", async () => {
    const { writer, calls } = writerStub(true);
    const context = nativeContext(writer, false, calls);
    supervisorSpawnMock.mockImplementation(async () => {
      calls.push("spawn");
      throw new Error("child failed");
    });
    await expect(executePreparedCliRun(context)).rejects.toThrow();
    expect(calls.slice(-2)).toEqual(["spawn", "settleNativeLogin"]);
  });

  it("spawns nothing when the executing environment selects another owner", async () => {
    const { writer } = writerStub(true);
    vi.mocked(writer.bindExecutionEnv).mockImplementation(() => {
      throw new Error("CLI history authority changed before execution");
    });
    const context = nativeContext(writer, true);
    await expect(executePreparedCliRun(context)).rejects.toThrow("CLI history authority changed");
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
  });

  it("uses the readable proof and recovery boundaries for a fresh recovery turn", async () => {
    const { writer } = writerStub(true);
    const context = nativeContext(writer, true);
    await executePreparedCliRun(context);
    expect(writer.assertReadable).toHaveBeenCalled();
    expect(vi.mocked(writer.bindExecutionEnv).mock.calls[0]?.[1]).toBe(true);
    expect(writer.checkNativeLoginBoundary).toHaveBeenCalledWith(true);
  });

  it("keeps a credential-owned writer off the native login checks", async () => {
    const { writer } = writerStub(false);
    const context = nativeContext(writer);
    await executePreparedCliRun(context);
    expect(writer.assertCurrent).not.toHaveBeenCalled();
    expect(writer.checkNativeLoginBoundary).not.toHaveBeenCalled();
    expect(supervisorSpawnMock.mock.lastCall?.[0]).not.toHaveProperty("beforeSpawn");
  });
});
