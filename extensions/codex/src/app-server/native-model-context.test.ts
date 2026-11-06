import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexNativeModelContext } from "./native-model-context.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";

// Only the client registry is replaced; the rollout scan and config resolution are real.
vi.mock("./client-runtime.js", () => ({
  withCodexClientWorkspace: (_client: unknown, read: (state: unknown, max: number) => unknown) =>
    read(
      {
        closed: false,
        sessionMetadata: new Map(),
        modelContextScans: new Map(),
        workspaceReferences: new Map(),
      },
      8,
    ),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function resumedThreadReport(action: "resumed" | "started") {
  const home = tempDirs.make("codex-native-base-");
  const rolloutPath = path.join(home, "sessions", "rollout.jsonl");
  const instructionsFile = path.join(home, "instructions.md");
  await fs.mkdir(path.dirname(rolloutPath));
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "thread", base_instructions: { text: "Creation-time base." } },
    })}\n`,
  );
  // Edited after the thread was created; Codex reads it again on cold resume.
  await fs.writeFile(instructionsFile, "\nEdited base instructions.\n");
  const client = {
    getRuntimeIdentity: () => ({ codexHome: home }),
    request: async () => ({
      config: { model_instructions_file: instructionsFile, instructions: "Legacy." },
      origins: { model_instructions_file: { name: { type: "user" }, version: "1" } },
    }),
  };
  const resources = {
    state: {
      client,
      thread: { threadId: "thread", rolloutPath, lifecycle: { action } },
      codexExecutionCwd: home,
    },
    prompt: {
      context: {
        runtime: {
          connection: { appServer: { start: { transport: "stdio", codexHome: home } } },
        },
      },
    },
  } as unknown as StartedCodexAttemptResources;
  return await readCodexNativeModelContext(resources, new AbortController().signal);
}

describe("readCodexNativeModelContext", () => {
  it("counts the configured base instructions Codex prefers over session_meta on resume", async () => {
    await expect(resumedThreadReport("resumed")).resolves.toEqual({
      baseInstructions: "Edited base instructions.",
    });
    // A thread started this attempt recorded its live base text in session_meta.
    await expect(resumedThreadReport("started")).resolves.toEqual({
      baseInstructions: "Creation-time base.",
    });
  });
});
