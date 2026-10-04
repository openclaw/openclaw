import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as nativeHistory from "../../gateway/cli-session-history.claude.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { RunAgentAttemptOverrides } from "./attempt-execution.cli.test-support.js";
import { makeCliResult } from "./attempt-execution.cli.test-support.js";

export function makeClaudeCliSessionEntry(
  openclawSessionId: string,
  cliSessionId: string,
): SessionEntry {
  return {
    sessionId: openclawSessionId,
    updatedAt: Date.now(),
    cliSessionBindings: {
      "claude-cli": {
        sessionId: cliSessionId,
        authProfileId: "anthropic:claude-cli",
      },
    },
    cliSessionIds: { "claude-cli": cliSessionId },
    claudeCliSessionId: cliSessionId,
  };
}

type FallbackAttemptOverrides = Omit<
  Partial<RunAgentAttemptOverrides>,
  "agentDir" | "workspaceDir" | "sessionEntry"
> & {
  config?: OpenClawConfig;
  sessionEntry?: Partial<SessionEntry>;
  additionalSessionEntries?: Record<string, Partial<SessionEntry>>;
};

type ClaudeConfigDirAttemptFixture = {
  getTmpDir: () => string;
  readSessionStore: () => Record<string, SessionEntry>;
  createCliSession: (
    sessionKey: string,
    sessionEntry: SessionEntry,
  ) => Promise<{ runCli: (params: { body: string; runId: string }) => Promise<unknown> }>;
  runFallbackAttempt: (overrides: FallbackAttemptOverrides) => Promise<Record<string, unknown>>;
  setRunCliAgentImplementation: (implementation: () => Promise<EmbeddedAgentRunResult>) => void;
  firstRunCliAgentArg: () => Record<string, unknown>;
};

export function registerClaudeConfigDirAttemptTests(
  getFixture: () => ClaudeConfigDirAttemptFixture,
) {
  registerNodeOwnedClaudeCliBindingTest({ getFixture });
  registerClaudeConfigDirFallbackPromptTests({ getFixture });
}

function registerNodeOwnedClaudeCliBindingTest({
  getFixture,
}: {
  getFixture: () => ClaudeConfigDirAttemptFixture;
}) {
  it("preserves a node-placed binding when its native transcript is absent on the Gateway", async () => {
    const fixture = getFixture();
    const sessionKey = "agent:main:direct:node-claude-history";
    const cliSessionId = "node-owned-native-session";
    const sessionEntry = {
      ...makeClaudeCliSessionEntry("node-local-session", cliSessionId),
      execHost: "node" as const,
      execNode: "fixture-node",
    };
    const { runCli } = await fixture.createCliSession(sessionKey, sessionEntry);
    fixture.setRunCliAgentImplementation(async () => {
      expect(
        fixture.readSessionStore()[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId,
      ).toBe(cliSessionId);
      return makeCliResult("node response");
    });
    await runCli({
      body: "resume remotely",
      runId: "node-resume",
    });
    expect(fixture.firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
  });
}

function registerClaudeConfigDirFallbackPromptTests({
  getFixture,
}: {
  getFixture: () => ClaudeConfigDirAttemptFixture;
}) {
  it.each(["absolute", "relative", "bound", "changed", "changed-cwd"] as const)(
    "uses only authorized %s Claude history in the actual fallback prompt",
    async (kind) => {
      const fixture = getFixture();
      const tmpDir = fixture.getTmpDir();
      const homeDir = path.join(tmpDir, "fallback-home");
      const childCwd = path.join(tmpDir, "task-subdirectory");
      await fs.mkdir(childCwd, { recursive: true });
      const configDir =
        kind === "absolute" || kind === "bound"
          ? path.join(tmpDir, "alternate Claude")
          : "alternate Claude";
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      const cliSessionId = "configured-fallback-session";
      const projectKey = (await fs.realpath(childCwd)).replace(/[^a-zA-Z0-9]/g, "-");
      for (const [root, text] of [
        [path.resolve(childCwd, configDir), "Native configured history"],
        [path.join(homeDir, ".claude"), "Wrong default history"],
      ] as const) {
        const projectDir = path.join(root, "projects", projectKey);
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
          path.join(projectDir, `${cliSessionId}.jsonl`),
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: text },
          }) + "\n",
        );
      }
      if (kind === "changed") {
        vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tmpDir, "new profile"));
      }
      const reader = vi.spyOn(nativeHistory, "readClaudeCliFallbackSeed");
      const attempt = await fixture.runFallbackAttempt({
        originalProvider: "claude-cli",
        isFallbackRetry: true,
        cwd: kind === "bound" || kind === "changed-cwd" ? tmpDir : childCwd,
        body: "Continue this task",
        sessionEntry: {
          cliSessionBindings: {
            "claude-cli": {
              sessionId: cliSessionId,
              ...(kind === "bound" || kind === "changed" || kind === "changed-cwd"
                ? {
                    cwd: childCwd,
                    transcriptRoot: path.join(path.resolve(childCwd, configDir), "projects"),
                  }
                : {}),
            },
          },
        },
      });
      const prompt = attempt.prompt;
      if (typeof prompt !== "string") {
        throw new Error("Expected the fallback model to receive a text prompt");
      }
      if (kind === "changed" || kind === "changed-cwd") {
        expect(prompt).not.toContain("Native configured history");
        expect(reader).not.toHaveBeenCalled();
      } else {
        expect(prompt).toContain("Native configured history");
        expect(reader).toHaveBeenCalledOnce();
      }
      expect(prompt).not.toContain("Wrong default history");
      expect(prompt.match(/Continue this task/g)).toHaveLength(1);
      reader.mockRestore();
    },
  );
}
