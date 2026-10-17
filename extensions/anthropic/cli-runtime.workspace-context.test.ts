import { createHash } from "node:crypto";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_PROTOCOL_FIXTURE,
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
} from "./cli-runtime.test-support.js";

const harness = createCliTestHarness("openclaw-workspace-hook-");
afterEach(async () => {
  await harness.cleanup();
});

async function createContext(
  scenario: string,
  overrides: Partial<CliBackendExecuteContext>,
): Promise<CliBackendExecuteContext> {
  return harness.context(
    CLAUDE_PROTOCOL_FIXTURE,
    {
      prompt: "synthetic input",
      systemPrompt: "stable operator policy",
      liveSession: harness.liveSession(),
      ...overrides,
    },
    { CLAUDE_FIXTURE_SCENARIO: scenario },
  );
}

describe("Claude workspace lifecycle context", () => {
  it("injects workspace context once per process and awaits compact context before continuation", async () => {
    const workspaceContext = vi.fn(async (source: "startup" | "resume" | "compact") =>
      source === "compact" ? "FRESH_WORKSPACE" : "SAVED_WORKSPACE",
    );
    const context = await createContext("workspace-context", { workspaceContext });
    const first = resultDetail(await collectClaudeCli(context));
    expect(first.privateContext).toBe("SAVED_WORKSPACE");
    const second = resultDetail(await collectClaudeCli({ ...context, useResume: true }));
    expect(second.privateContext).toBeUndefined();
    expect(second.compactContext).toBe("FRESH_WORKSPACE");
    expect(workspaceContext.mock.calls).toEqual([["startup"], ["compact"]]);
    expect(second.pid).toBe(first.pid);
    console.info(
      "WORKSPACE_TRANSPORT_RECEIPT",
      JSON.stringify({
        transport: "synthetic-native-stdio",
        stage: "compact-before-continuation",
        startupContextReceived: first.privateContext === "SAVED_WORKSPACE",
        ordinaryTurnContextAbsent: second.privateContext === undefined,
        freshCompactContextReceived: second.compactContext === "FRESH_WORKSPACE",
        compactContextSha256: createHash("sha256")
          .update(String(second.compactContext))
          .digest("hex"),
        sameNativeProcess: second.pid === first.pid,
      }),
    );
  });

  it("does not replay precompact files when native rewrites the same submitted input", async () => {
    const context = await createContext("workspace-context-rerun", {
      workspaceContext: async (source) =>
        source === "compact" ? "FRESH_WORKSPACE" : "SAVED_WORKSPACE",
    });
    const output = resultDetail(await collectClaudeCli(context));
    expect(output.privateContext).toBe("SAVED_WORKSPACE");
    expect(output.compactContext).toBe("FRESH_WORKSPACE");
    expect(output.compactRerunContext).toBeUndefined();
    console.info(
      "WORKSPACE_TRANSPORT_RECEIPT",
      JSON.stringify({
        transport: "synthetic-native-stdio",
        stage: "same-input-postcompact-rerun",
        startupContextReceived: output.privateContext === "SAVED_WORKSPACE",
        freshCompactContextReceived: output.compactContext === "FRESH_WORKSPACE",
        staleRerunContextAbsent: output.compactRerunContext === undefined,
      }),
    );
  });

  it("aborts the native process when required workspace persistence fails", async () => {
    const context = await createContext("workspace-context", {
      workspaceContext: async () => {
        throw new Error("snapshot write failed");
      },
    });
    const execution = collectClaudeCli(context);
    await expect(execution).rejects.toThrow("snapshot write failed");
    const executionRejected = await execution.then(
      () => false,
      () => true,
    );
    expect(context.liveSession?.current()).toBeUndefined();
    console.info(
      "WORKSPACE_TRANSPORT_RECEIPT",
      JSON.stringify({
        transport: "synthetic-native-stdio",
        stage: "snapshot-persistence-failed",
        executionRejected,
        nativeLiveSessionAbsent: context.liveSession?.current() === undefined,
      }),
    );
  });
});
