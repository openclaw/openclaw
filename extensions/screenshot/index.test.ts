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
      async (_argv: string[], opts: { env: Record<string, string | undefined> }) => {
        const outputPath = opts.env.SCREENSHOT_OUTPUT_PATH;
        if (!outputPath) {
          throw new Error("capture command was launched without an output path");
        }
        await fs.writeFile(outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

  type Executable = {
    execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
  };

  // Simulates authority revoked after `allowedCalls` successful guard checks.
  function revokedAfter(allowedCalls: number) {
    let calls = 0;
    return vi.fn(() => {
      calls += 1;
      if (calls > allowedCalls) {
        throw new Error("invocation authority revoked");
      }
    });
  }

  it("is unavailable to non-owners and sandboxed sessions", () => {
    const { descriptor } = registerTool();
    expect(descriptor.create(context({ senderIsOwner: false }))).toBeNull();
    expect(descriptor.create(context({ senderIsOwner: undefined }))).toBeNull();
    expect(descriptor.create(context({ sandboxed: true }))).toBeNull();
    expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("saves the capture in the workspace and sends it to the current conversation", async () => {
    const send = vi.fn(async () => {});
    const ctx = context({ delivery: { send } });
    const tool = registerTool().descriptor.create(ctx) as Executable;

    const result = await tool.execute("call-1", {});

    const details = result.details as { path: string; delivered: boolean };
    expect(path.dirname(details.path)).toBe(path.join(workspaceDir, "screenshots"));
    expect((await fs.stat(details.path)).size).toBeGreaterThan(0);
    expect(details.delivered).toBe(true);
    expect(send).toHaveBeenCalledWith({ mediaUrl: details.path });
    // Start of the invocation, right before the capture launch, right before the send.
    expect(ctx.assertInvocationCurrent).toHaveBeenCalledTimes(3);
  });

  it("only saves the file when send is false", async () => {
    const send = vi.fn(async () => {});
    const tool = registerTool().descriptor.create(context({ delivery: { send } })) as Executable;

    const result = await tool.execute("call-2", { send: false });

    expect((result.details as { delivered: boolean }).delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not capture or send when authority is revoked at the start", async () => {
    const send = vi.fn(async () => {});
    const tool = registerTool().descriptor.create(
      context({ delivery: { send }, assertInvocationCurrent: revokedAfter(0) }),
    ) as Executable;

    await expect(tool.execute("call-3", {})).rejects.toThrow("revoked");

    expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not launch the capture when authority is revoked while the directory is prepared", async () => {
    const send = vi.fn(async () => {});
    const tool = registerTool().descriptor.create(
      context({ delivery: { send }, assertInvocationCurrent: revokedAfter(1) }),
    ) as Executable;

    await expect(tool.execute("call-4", { send: false })).rejects.toThrow("revoked");

    expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send the image when authority is revoked after the capture", async () => {
    const send = vi.fn(async () => {});
    const tool = registerTool().descriptor.create(
      context({ delivery: { send }, assertInvocationCurrent: revokedAfter(2) }),
    ) as Executable;

    await expect(tool.execute("call-5", {})).rejects.toThrow("revoked");

    expect(processMocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
