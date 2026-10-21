import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAgentHarnessPreflightError, AgentHarnessPreflightError } from "../harness/errors.js";
import { assertSandboxedDelegatedChildNotCli } from "./attempt-sandbox-cli-admission.js";

const sessionKey = "agent:main:subagent:child";
const sessionAgentId = "main";

function makeConfig(sandboxMode?: "all"): OpenClawConfig {
  const sandbox = sandboxMode ? { sandbox: { mode: sandboxMode } } : undefined;
  return {
    agents: {
      defaults: sandbox ?? {},
      entries: {
        main: sandbox ?? {},
      },
    },
  };
}

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "child-session", updatedAt: 1, ...overrides };
}

describe("sandboxed delegated-child CLI admission", () => {
  it("rejects a CLI candidate for a sandbox-classified subagent child", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "claude-cli",
        cfg: makeConfig("all"),
        sessionKey,
        sessionAgentId,
        sessionEntry: makeSessionEntry(),
      }),
    ).toThrowError(AgentHarnessPreflightError);
    try {
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "claude-cli",
        cfg: makeConfig("all"),
        sessionKey,
        sessionAgentId,
        sessionEntry: makeSessionEntry(),
      });
      throw new Error("Expected the sandboxed CLI candidate to be rejected");
    } catch (err) {
      if (!isAgentHarnessPreflightError(err)) {
        throw err;
      }
      expect(err.message).toContain("claude-cli");
      expect(err.message).toContain("cannot honor the sandbox");
    }
  });

  it("rejects a CLI candidate for a delegated child stamped with sandbox required", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "google-gemini-cli",
        cfg: makeConfig(),
        sessionKey,
        sessionAgentId,
        sessionEntry: makeSessionEntry({ sandbox: "required" }),
      }),
    ).toThrowError(/cannot honor the sandbox/);
  });

  it("rejects a CLI candidate for a visible child stamped with spawn provenance", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "claude-cli",
        cfg: makeConfig("all"),
        sessionKey: "agent:main:dashboard:child",
        sessionAgentId,
        sessionEntry: makeSessionEntry({
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:main",
        }),
      }),
    ).toThrowError(/cannot honor the sandbox/);
  });

  it("keeps CLI execution for an operator dashboard session parented to main", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "claude-cli",
        cfg: makeConfig("all"),
        sessionKey: "agent:main:dashboard:operator-chat",
        sessionAgentId,
        sessionEntry: makeSessionEntry({ parentSessionKey: "agent:main:main" }),
      }),
    ).not.toThrow();
  });

  it("keeps CLI execution for a sandbox-classified non-delegated session", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "claude-cli",
        cfg: makeConfig("all"),
        sessionKey: "agent:main:direct:operator-run",
        sessionAgentId,
        sessionEntry: makeSessionEntry(),
      }),
    ).not.toThrow();
  });

  it("keeps CLI execution for an unsandboxed delegated child", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: true,
        cliExecutionProvider: "claude-cli",
        cfg: makeConfig(),
        sessionKey,
        sessionAgentId,
        sessionEntry: makeSessionEntry({ spawnedBy: "agent:main:main" }),
      }),
    ).not.toThrow();
  });

  it("keeps embedded execution for a sandbox-classified delegated child", () => {
    expect(() =>
      assertSandboxedDelegatedChildNotCli({
        useCliExecution: false,
        cliExecutionProvider: "openai",
        cfg: makeConfig("all"),
        sessionKey,
        sessionAgentId,
        sessionEntry: makeSessionEntry({ spawnedBy: "agent:main:main" }),
      }),
    ).not.toThrow();
  });
});
