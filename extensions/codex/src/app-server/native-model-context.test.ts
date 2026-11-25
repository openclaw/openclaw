import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexNativeModelContext } from "./native-model-context.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";

// Only the client registry is replaced; the rollout scan and config resolution are real.
vi.mock("./client-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-runtime.js")>()),
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
const line = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;

async function nativeReport(action: "resumed" | "started", instructionsFile?: string | null) {
  const home = tempDirs.make("codex-native-base-");
  const rolloutPath = path.join(home, "sessions", "rollout.jsonl");
  await fs.mkdir(path.dirname(rolloutPath));
  await fs.writeFile(
    rolloutPath,
    line("session_meta", { id: "thread", base_instructions: { text: "Creation-time base." } }) +
      line("world_state", { full: true, state: { agents_md: { directory: home, text: "Tabs." } } }),
  );
  const file = instructionsFile ?? path.join(home, "instructions.md");
  // Edited after the thread was created; Codex reads it again when it loads the thread.
  await fs.writeFile(path.join(home, "instructions.md"), "\nEdited base instructions.\n");
  const resources = {
    state: {
      // No request method: reporting must reuse the snapshot preflight already read.
      client: { getRuntimeIdentity: () => ({ codexHome: home }) },
      thread: {
        threadId: "thread",
        rolloutPath,
        lifecycle: { action },
        // null: no authored base, so OpenClaw sent its own base on start and resume.
        preparedEffectiveConfig:
          instructionsFile === null
            ? { config: {}, origins: {} }
            : {
                config: { model_instructions_file: file },
                origins: { model_instructions_file: { name: { type: "user" }, version: "1" } },
              },
      },
    },
    prompt: {
      context: {
        runtime: {
          connection: { appServer: { start: { transport: "stdio", codexHome: home } } },
        },
      },
    },
  } as unknown as StartedCodexAttemptResources;
  const report = await readCodexNativeModelContext(resources, new AbortController().signal);
  return { ...report, agentsMd: report?.agentsMd?.text };
}

describe("readCodexNativeModelContext", () => {
  it("estimates the configured base instructions Codex prefers over session_meta on resume", async () => {
    await expect(nativeReport("resumed")).resolves.toEqual({
      baseInstructions: "Edited base instructions.",
      baseInstructionsEstimated: true,
      agentsMd: "Tabs.",
    });
    // An unreadable override keeps the rollout result, AGENTS.md included.
    await expect(nativeReport("resumed", "/missing/instructions.md")).resolves.toEqual({
      baseInstructions: "Creation-time base.",
      baseInstructionsEstimated: true,
      agentsMd: "Tabs.",
    });
    // A thread started this attempt recorded its live base text in session_meta.
    await expect(nativeReport("started")).resolves.toEqual({
      baseInstructions: "Creation-time base.",
      agentsMd: "Tabs.",
    });
  });

  it("leaves out session_meta's copy of the base OpenClaw sent itself", async () => {
    // The report already counts OpenClaw's base with its instructions.
    for (const action of ["started", "resumed"] as const) {
      await expect(nativeReport(action, null)).resolves.toEqual({ agentsMd: "Tabs." });
    }
  });
});
