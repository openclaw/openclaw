import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const processMocks = vi.hoisted(() => ({ runCommandWithTimeout: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", () => processMocks);

type ToolDescriptor = {
  contextVersion: 2;
  create: (context: OpenClawPluginToolContext<2>) => unknown;
};

function registerTool() {
  let descriptor: ToolDescriptor | undefined;
  let options: unknown;
  plugin.register({
    registerTool: (value: ToolDescriptor, opts: unknown) => {
      descriptor = value;
      options = opts;
    },
  } as never);
  if (!descriptor) {
    throw new Error("screenshot did not register a tool");
  }
  return { descriptor, options };
}

describe("screenshot plugin", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-screenshot-"));
    processMocks.runCommandWithTimeout.mockReset();
    processMocks.runCommandWithTimeout.mockImplementation(
      async (_argv: string[], opts: { env: Record<string, string> }) => {
        await fs.writeFile(opts.env.OPENCLAW_SCREENSHOT_OUT, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return { code: 0, stdout: "", stderr: "" };
      },
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function context(overrides: Partial<OpenClawPluginToolContext<2>> = {}) {
    return {
      senderIsOwner: true,
      workspaceDir,
      assertInvocationCurrent: vi.fn(),
      ...overrides,
    } as OpenClawPluginToolContext<2>;
  }

  it("registers one optional tool", () => {
    expect(registerTool().options).toEqual({ name: "screenshot", optional: true });
  });

  it("is unavailable to non-owners and sandboxed sessions", () => {
    const { descriptor } = registerTool();
    expect(descriptor.create(context({ senderIsOwner: false }))).toBeNull();
    expect(descriptor.create(context({ senderIsOwner: undefined }))).toBeNull();
    expect(descriptor.create(context({ sandboxed: true }))).toBeNull();
  });

  it("saves the capture in the workspace and sends it to the current conversation", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const send = vi.fn(async () => {});
    const ctx = context({ delivery: { send } });
    const tool = registerTool().descriptor.create(ctx) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
    };

    const result = await tool.execute("call-1", {});

    const details = result.details as { path: string; delivered: boolean };
    expect(path.dirname(details.path)).toBe(path.join(workspaceDir, "screenshots"));
    expect((await fs.stat(details.path)).size).toBeGreaterThan(0);
    expect(details.delivered).toBe(true);
    expect(send).toHaveBeenCalledWith({ mediaUrl: details.path });
    expect(ctx.assertInvocationCurrent).toHaveBeenCalledTimes(2);
  });

  it("only saves the file when send is false", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const send = vi.fn(async () => {});
    const tool = registerTool().descriptor.create(context({ delivery: { send } })) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
    };

    const result = await tool.execute("call-2", { send: false });

    expect((result.details as { delivered: boolean }).delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
