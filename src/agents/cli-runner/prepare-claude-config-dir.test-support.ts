import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import type { setRawCliBackendForPrepareTest } from "./prepare-mcp.test-support.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

/** Root the upcoming Claude child selects when nothing overrides the Gateway environment. */
export function gatewayClaudeProjectsRoot(): string {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? os.homedir(), ".claude"),
    "projects",
  );
}

export function registerClaudeConfigDirPreparationTests({
  getFixture,
  setBackend,
  setRawBackend,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  setBackend: (params: {
    liveSession?: boolean;
    sessionMode?: "none";
    reseedFromRawTranscriptWhenUncompacted?: boolean;
    prepareExecution?: CliBackendPlugin["prepareExecution"];
  }) => void;
  setRawBackend: typeof setRawCliBackendForPrepareTest;
}) {
  it("ignores stored CLI session candidates when the backend disables sessions", async () => {
    setBackend({
      sessionMode: "none",
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const transcriptCheck = vi.fn(async () => false);
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });

    const context = await getFixture().prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: "stateless ask",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "stale-claude-sid" },
      cliSessionId: "stale-claude-sid",
    });

    expect(context.reusableCliSession).toEqual({ mode: "none" });
    expect(transcriptCheck).not.toHaveBeenCalled();
    expect(orphanCheck).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "resumes a configured-root transcript without requiring a live generation (warm=%s)",
    async (warm) => {
      const fixture = getFixture();
      const taskDir = path.join(fixture.session.dir, "task");
      fs.mkdirSync(taskDir);
      const canonicalCwd = fs.realpathSync.native(taskDir);
      const configDir = path.join(fixture.session.dir, "selected Claude");
      const projectDir = path.join(
        configDir,
        "projects",
        canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-"),
      );
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "configured-session.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
        })}\n`,
      );
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      setBackend({ liveSession: true });
      setCliRunnerPrepareTestDeps({
        getCliLiveSessionGeneration: () => (warm ? "existing-generation" : undefined),
      });

      // Keep both transcript probes real: a false miss either invalidates the
      // cold binding or unnecessarily pins the warm process generation.
      const context = await fixture.prepare({
        cwd: taskDir,
        provider: "claude-cli",
        model: "opus",
        cliSessionBinding: {
          sessionId: "configured-session",
          cwdHash: hashCliSessionText(taskDir),
        },
      });
      expect(context.reusableCliSession).toEqual({
        mode: "reuse",
        sessionId: "configured-session",
      });
      expect(context.requiredClaudeLiveSessionGeneration).toBeUndefined();
    },
  );

  it("checks claude-cli transcript content under the resolved cwd", async () => {
    const fixture = getFixture();
    const { dir } = fixture.session;
    const taskDir = path.join(dir, "task");
    fs.mkdirSync(taskDir, { recursive: true });
    setRawBackend({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: false,
      config: {
        command: "claude",
        args: ["--print"],
        resumeArgs: ["--resume", "{sessionId}"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    const transcriptCheck = vi.fn(async () => true);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      cwd: taskDir,
      prompt: "follow-up",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "live-claude-sid", cwdHash: hashCliSessionText(taskDir) },
      cliSessionId: "live-claude-sid",
    });

    expect(transcriptCheck).toHaveBeenCalledWith({
      sessionId: "live-claude-sid",
      workspaceDir: taskDir,
      projectsRoot: gatewayClaudeProjectsRoot(),
    });
    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "live-claude-sid",
    });
  });

  it("checks the claude-cli transcript under the config dir the next child receives", async () => {
    const fixture = getFixture();
    const { dir } = fixture.session;
    const childConfigDir = path.join(dir, "child-claude-profile");
    setBackend({
      prepareExecution: async () => ({ env: { CLAUDE_CONFIG_DIR: childConfigDir } }),
    });
    const staleProjectsRoot = path.join(dir, "previous-claude-profile", "projects");
    // The transcript only exists under the profile the previous run wrote to.
    const transcriptCheck = vi.fn(
      async (probe: { projectsRoot?: string }) => probe.projectsRoot === staleProjectsRoot,
    );
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: "follow-up",
      provider: "claude-cli",
      model: "opus",
      // The stored root belongs to the profile a previous run wrote under.
      cliSessionBinding: {
        sessionId: "moved-claude-sid",
        cwdHash: hashCliSessionText(dir),
        transcriptRoot: staleProjectsRoot,
      },
      cliSessionId: "moved-claude-sid",
    });

    expect(transcriptCheck).toHaveBeenCalledWith({
      sessionId: "moved-claude-sid",
      workspaceDir: dir,
      projectsRoot: path.join(childConfigDir, "projects"),
    });
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "missing-transcript",
    });
    // The stale profile's transcript cannot authorize a resume under the new one.
    expect(orphanCheck).not.toHaveBeenCalled();
  });

  it("checks the claude-cli transcript under a skill-selected child config dir", async () => {
    const fixture = getFixture();
    const { dir } = fixture.session;
    const taskDir = path.join(dir, "skill-task");
    fs.mkdirSync(taskDir, { recursive: true });
    const canonicalCwd = fs.realpathSync.native(taskDir);
    const childConfigDir = path.join(dir, "skill-claude-profile");
    const projectDir = path.join(
      childConfigDir,
      "projects",
      canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "skill-configured-sid.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
      })}\n`,
    );
    setBackend({ liveSession: true });

    const config: OpenClawConfig = {
      skills: {
        entries: { "skill-selected-profile": { env: { CLAUDE_CONFIG_DIR: childConfigDir } } },
      },
    };
    // Skill env application reads the active runtime snapshot, just as execution does.
    const previousConfig = getRuntimeConfigSnapshot();
    setRuntimeConfigSnapshot(config);
    try {
      const context = await fixture.prepare({
        cwd: taskDir,
        config,
        skillsSnapshot: {
          prompt: "",
          skills: [
            {
              name: "skill-selected-profile",
              skillKey: "skill-selected-profile",
            },
          ],
        },
        provider: "claude-cli",
        model: "opus",
        cliSessionBinding: {
          sessionId: "skill-configured-sid",
          cwdHash: hashCliSessionText(taskDir),
        },
        cliSessionId: "skill-configured-sid",
      });

      expect(context.reusableCliSession).toEqual({
        mode: "reuse",
        sessionId: "skill-configured-sid",
      });
      expect(context.requiredClaudeLiveSessionGeneration).toBeUndefined();
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      if (previousConfig) {
        setRuntimeConfigSnapshot(previousConfig);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });
}
