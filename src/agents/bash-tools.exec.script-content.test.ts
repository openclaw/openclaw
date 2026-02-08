import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";

const isWin = process.platform === "win32";

// Check if Python is available (with timeout to prevent hanging)
// Note: We specifically check for python3 since that's what the code prefers
let pythonAvailable = false;
try {
  execSync("python3 --version", { stdio: "ignore", timeout: 5000 });
  pythonAvailable = true;
} catch {
  pythonAvailable = false;
}

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => "/custom/bin:/opt/bin"),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
  };
});

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

describe("exec script content detection (Issue #11724)", () => {
  it("should handle Python code with import statements via temp file", async () => {
    if (isWin || !pythonAvailable) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    // This would previously fail with ImageMagick errors
    const pythonScript = `import json
print("Hello from Python")`;

    const result = await tool.execute("call1", { command: pythonScript });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";

    // Should execute successfully via temp file
    expect(text).toContain("Hello from Python");
    expect(text).toContain("Note: Multi-line script detected");
  });

  it("should handle shebang scripts via temp file", async () => {
    if (isWin) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    // Use /bin/sh which is more portable than /bin/bash
    const shellScript = `#!/bin/sh
echo "Hello from Shell"`;

    const result = await tool.execute("call1", { command: shellScript });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";

    expect(text).toContain("Hello from Shell");
    expect(text).toContain("Note: Multi-line script detected");
  });

  it("should handle shebang with env via temp file", async () => {
    if (isWin || !pythonAvailable) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    const pythonScript = `#!/usr/bin/env python3
import json
print("Hello from env shebang")`;

    const result = await tool.execute("call1", { command: pythonScript });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";

    expect(text).toContain("Hello from env shebang");
  });

  it("should reject multi-line scripts with host=node", async () => {
    if (isWin) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
      node: "test-node",
    });

    const pythonScript = `import json
print("Hello")`;

    await expect(tool.execute("call1", { command: pythonScript })).rejects.toThrow(
      "Multi-line scripts cannot be executed with host=node",
    );
  });

  it("should handle single-line Python commands normally", async () => {
    if (isWin || !pythonAvailable) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    // Single-line command should work normally
    const result = await tool.execute("call1", {
      command: 'python3 -c "import json; print(1)"',
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";

    expect(text).toContain("1");
    expect(text).not.toContain("Note: Multi-line script detected");
  });

  it("should handle regular shell commands without detection", async () => {
    if (isWin) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    const result = await tool.execute("call1", { command: "echo Hello" });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";

    expect(text).toContain("Hello");
    expect(text).not.toContain("Note: Multi-line script detected");
  });
});
