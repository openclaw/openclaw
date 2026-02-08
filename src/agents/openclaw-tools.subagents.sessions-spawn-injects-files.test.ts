import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

// Cross-platform test paths - use path.join to ensure correct separators
const TEST_WORKSPACE = path.resolve("/test/workspace");
const CUSTOM_WORKSPACE = path.resolve("/custom/workspace");

/** Helper to create a cross-platform absolute path for test mocks */
function testPath(workspace: string, ...segments: string[]): string {
  return path.resolve(workspace, ...segments);
}

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

describe("sessions_spawn file injection", () => {
  beforeEach(() => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    readFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("injects files from agents.defaults.subagents.injectFiles into extraSystemPrompt", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          subagents: {
            injectFiles: ["SECURITY.md", "GUIDELINES.md"],
          },
        },
      },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === testPath(TEST_WORKSPACE, "SECURITY.md")) {
        return "# Security Rules\nDo not access sensitive files.";
      }
      if (filePath === testPath(TEST_WORKSPACE, "GUIDELINES.md")) {
        return "# Guidelines\nFollow best practices.";
      }
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-inject-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-inject-1", {
      task: "do secure thing",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });

    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;
    expect(extraSystemPrompt).toContain("# Project Context");
    expect(extraSystemPrompt).toContain("## SECURITY.md");
    expect(extraSystemPrompt).toContain("# Security Rules");
    expect(extraSystemPrompt).toContain("## GUIDELINES.md");
    expect(extraSystemPrompt).toContain("# Guidelines");
  });

  it("per-agent injectFiles overrides defaults", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          subagents: {
            injectFiles: ["DEFAULT.md"],
          },
        },
        list: [
          {
            id: "custom",
            workspace: "/custom/workspace",
            subagents: {
              injectFiles: ["CUSTOM.md"],
            },
          },
        ],
      },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === testPath(CUSTOM_WORKSPACE, "CUSTOM.md")) {
        return "# Custom Context\nAgent-specific content.";
      }
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-custom-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:custom:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-custom-1", {
      task: "do custom thing",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });

    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;
    // Should have CUSTOM.md, not DEFAULT.md
    expect(extraSystemPrompt).toContain("## CUSTOM.md");
    expect(extraSystemPrompt).toContain("# Custom Context");
    expect(extraSystemPrompt).not.toContain("DEFAULT.md");
  });

  it("skips missing files with warning but continues", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          subagents: {
            injectFiles: ["MISSING.md", "EXISTS.md"],
          },
        },
      },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === testPath(TEST_WORKSPACE, "EXISTS.md")) {
        return "# Existing File\nThis exists.";
      }
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-missing-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-missing-1", {
      task: "do thing with missing file",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
    });

    // Should have warned about missing file
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Inject file not found: MISSING.md"),
    );

    // Should still include the existing file
    const agentCall = calls.find((call) => call.method === "agent");
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;
    expect(extraSystemPrompt).toContain("## EXISTS.md");
    expect(extraSystemPrompt).toContain("# Existing File");

    warnSpy.mockRestore();
  });

  it("skips empty files", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          subagents: {
            injectFiles: ["EMPTY.md", "CONTENT.md"],
          },
        },
      },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === testPath(TEST_WORKSPACE, "EMPTY.md")) {
        return "   \n   \n   ";
      }
      if (filePath === testPath(TEST_WORKSPACE, "CONTENT.md")) {
        return "# Real Content";
      }
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-empty-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call-empty-1", { task: "test" });

    const agentCall = calls.find((call) => call.method === "agent");
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;
    // Should have CONTENT.md but not EMPTY.md section
    expect(extraSystemPrompt).toContain("## CONTENT.md");
    expect(extraSystemPrompt).not.toContain("## EMPTY.md");
  });

  it("no injection when injectFiles is empty or not configured", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          // No injectFiles configured
        },
      },
    };

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-no-inject-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    await tool.execute("call-no-inject-1", { task: "test without injection" });

    const agentCall = calls.find((call) => call.method === "agent");
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;
    // Should not contain Project Context section
    expect(extraSystemPrompt).not.toContain("# Project Context");
    // readFile should not have been called
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("blocks path traversal attacks (relative and absolute paths)", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          subagents: {
            injectFiles: [
              "../secret.txt", // Relative path escape
              "/etc/passwd", // Absolute path
              "SAFE.md", // Legitimate file
            ],
          },
        },
      },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === testPath(TEST_WORKSPACE, "SAFE.md")) {
        return "# Safe Content\nThis is legitimate.";
      }
      // These paths should never be reached due to security checks
      if (filePath === path.resolve("/test/secret.txt")) {
        return "SECRET_PASSWORD=hunter2";
      }
      if (filePath === path.resolve("/etc/passwd")) {
        return "root:x:0:0:root:/root:/bin/bash";
      }
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-traversal-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-traversal-1", {
      task: "try path traversal",
    });

    // Spawn should still succeed (not crash)
    expect(result.details).toMatchObject({
      status: "accepted",
    });

    // Should have warned about both malicious paths
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping inject file outside workspace: ../secret.txt"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping inject file outside workspace: /etc/passwd"),
    );

    // Verify dangerous content is NOT in the extraSystemPrompt
    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;

    // Should NOT contain secret content
    expect(extraSystemPrompt).not.toContain("SECRET_PASSWORD");
    expect(extraSystemPrompt).not.toContain("hunter2");
    expect(extraSystemPrompt).not.toContain("../secret.txt");

    // Should NOT contain passwd content
    expect(extraSystemPrompt).not.toContain("root:x:0:0");
    expect(extraSystemPrompt).not.toContain("/etc/passwd");

    // SHOULD contain the safe file
    expect(extraSystemPrompt).toContain("## SAFE.md");
    expect(extraSystemPrompt).toContain("# Safe Content");
    expect(extraSystemPrompt).toContain("This is legitimate.");

    warnSpy.mockRestore();
  });

  it("allows files starting with .. that are not path escapes", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();

    // A file literally named "..bar.md" should be allowed (not a path escape)
    configOverride = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          workspace: "/test/workspace",
          subagents: {
            injectFiles: ["..bar.md"],
          },
        },
      },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === testPath(TEST_WORKSPACE, "..bar.md")) {
        return "# Content from ..bar.md\nThis file legitimately starts with dots.";
      }
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-dotdot-1", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-dotdot-1", {
      task: "test file starting with dots",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
    });

    // Verify the content WAS injected (not blocked)
    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    const extraSystemPrompt = agentCall?.params?.extraSystemPrompt as string;
    expect(extraSystemPrompt).toContain("## ..bar.md");
    expect(extraSystemPrompt).toContain("# Content from ..bar.md");
    expect(extraSystemPrompt).toContain("This file legitimately starts with dots.");
  });
});
