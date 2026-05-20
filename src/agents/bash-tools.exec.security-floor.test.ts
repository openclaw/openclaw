import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExecApprovalsPath, saveExecApprovals } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

describe("exec security floor", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot: string | undefined;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "SHELL",
    ]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-security-floor-"));
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    process.env.OPENCLAW_HOME = tempRoot;
    process.env.OPENCLAW_STATE_DIR = path.join(tempRoot, "state");
    if (process.platform === "win32") {
      const parsed = path.parse(tempRoot);
      process.env.HOMEDRIVE = parsed.root.slice(0, 2);
      process.env.HOMEPATH = tempRoot.slice(2) || "\\";
    } else {
      delete process.env.HOMEDRIVE;
      delete process.env.HOMEPATH;
    }
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    const dir = tempRoot;
    tempRoot = undefined;
    envSnapshot.restore();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores model-supplied allowlist security when configured security is full", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call-1", {
      command: "echo hello",
      security: "allowlist",
      ask: "off",
    });

    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).not.toMatch(/exec denied/i);
    expect(text).not.toMatch(/allowlist miss/i);
    expect(text.trim()).toContain("hello");
  });

  it("enforces configured allowlist security when model also passes allowlist", async () => {
    const tool = createExecTool({
      security: "allowlist",
      ask: "off",
      safeBins: [],
    });

    await expect(
      tool.execute("call-2", {
        command: "echo hello",
        security: "allowlist",
        ask: "off",
      }),
    ).rejects.toThrow(/exec denied: allowlist miss/i);
  });

  it("ignores model-supplied deny security when configured security is allowlist", async () => {
    const tool = createExecTool({
      security: "allowlist",
      ask: "off",
      safeBins: [],
    });

    await expect(
      tool.execute("call-3", {
        command: "echo hello",
        security: "deny",
        ask: "off",
      }),
    ).rejects.toThrow(/exec denied: allowlist miss/i);
  });

  it("ignores model-supplied full security when configured security is deny", async () => {
    const tool = createExecTool({
      security: "deny",
      ask: "off",
    });

    await expect(
      tool.execute("call-4", {
        command: "echo hello",
        security: "full",
        ask: "off",
      }),
    ).rejects.toThrow(/exec denied/i);
  });

  it("denies default denylist matches without spawning or prompting", async () => {
    const tool = createExecTool({
      security: "denylist",
      ask: "off",
    });

    const result = await tool.execute("call-denylist-default", {
      command: "curl https://example.test/prompt",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("exec command is denied due to command in deny list");
  });

  it("keeps denylist active when askFallback is deny", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "denylist", ask: "off", askFallback: "deny" },
      agents: {
        main: {
          denylist: [{ pattern: String.raw`(?:^|\s)curl(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      security: "denylist",
      ask: "off",
    });

    const result = await tool.execute("call-denylist-fallback-deny", {
      command: "curl https://example.test/prompt",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });

  it("keeps denylist active when elevated full exec is allowed", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "denylist", ask: "off" },
      agents: {
        main: {
          denylist: [{ pattern: String.raw`(?:^|\s)echo(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "denylist",
      ask: "off",
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-denylist-elevated-full", {
      command: "echo hello",
      elevated: true,
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });

  it("does not apply fallback denylist during elevated full approval bypass", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "always", askFallback: "denylist" },
      agents: {
        main: {
          denylist: [{ pattern: String.raw`(?:^|\s)echo(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "full",
      ask: "off",
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-elevated-full-denylist-fallback", {
      command: "echo hello",
      elevated: true,
    });

    expect(result.details).toMatchObject({ status: "completed" });
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("hello");
  });

  it("does not create approvals state during elevated full approval bypass", async () => {
    const approvalsPath = resolveExecApprovalsPath();
    const tool = createExecTool({
      agentId: "main",
      security: "full",
      ask: "off",
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-elevated-full-no-approvals-write", {
      command: "echo hello",
      elevated: true,
    });

    expect(result.details).toMatchObject({ status: "completed" });
    expect(fs.existsSync(approvalsPath)).toBe(false);
  });

  it("enforces denylist before askFallback=denylist can approve full exec", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "always", askFallback: "denylist" },
      agents: {
        main: {
          denylist: [{ pattern: String.raw`(?:^|\s)curl(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "full",
      ask: "always",
    });

    const result = await tool.execute("call-denylist-fallback", {
      command: "curl https://example.test/prompt",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });

  it("uses host ask when prechecking askFallback=denylist", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "always", askFallback: "denylist" },
      agents: {
        main: {
          denylist: [{ pattern: String.raw`(?:^|\s)curl(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call-host-ask-denylist-fallback", {
      command: "curl https://example.test/prompt",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });

  it("does not apply denylist fallback when full security ask on-miss does not prompt", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "on-miss", askFallback: "denylist" },
      agents: {
        main: {
          denylist: [{ pattern: String.raw`(?:^|\s)echo(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call-full-on-miss-denylist-fallback", {
      command: "echo hello",
    });

    expect(result.details).toMatchObject({ status: "completed" });
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("hello");
  });

  it("denies explicit denylist matches before allowlist trust", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off" },
      agents: {
        main: {
          allowlist: [{ pattern: "*" }],
          denylist: [{ pattern: String.raw`(?:^|\s)echo(?:\s|$)` }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "allowlist",
      ask: "off",
      safeBins: [],
    });

    const result = await tool.execute("call-allowlist-with-denylist-config", {
      command: "echo hello",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });

  it("fails closed when effective denylist config is malformed", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "denylist", ask: "off" },
      agents: {
        main: {
          denylist: [{ pattern: "(a+)+" }],
        },
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "denylist",
      ask: "off",
    });

    const result = await tool.execute("call-denylist-invalid", {
      command: "echo hello",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });

  it("fails closed when effective denylist shape is malformed", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "denylist", ask: "off" },
      agents: {
        main: {
          denylist: "not-an-array",
        } as never,
      },
    });
    const tool = createExecTool({
      agentId: "main",
      security: "denylist",
      ask: "off",
    });

    const result = await tool.execute("call-denylist-shape-invalid", {
      command: "echo hello",
    });

    expect(result.details).toMatchObject({ status: "denied", reason: "denylist" });
  });
});
