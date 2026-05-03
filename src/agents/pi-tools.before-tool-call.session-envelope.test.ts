import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";

const envelopeMocks = vi.hoisted(() => ({
  readSessionRuntimeEnvelope: vi.fn(),
}));

vi.mock("./session-runtime-envelope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-runtime-envelope.js")>();
  return {
    ...actual,
    readSessionRuntimeEnvelope: envelopeMocks.readSessionRuntimeEnvelope,
  };
});

import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

function installBeforeToolCallHook(runBeforeToolCallImpl: (...args: unknown[]) => unknown) {
  const handler = vi.fn(runBeforeToolCallImpl);
  resetGlobalHookRunner();
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

describe("before_tool_call session envelopes", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    envelopeMocks.readSessionRuntimeEnvelope.mockReset();
    envelopeMocks.readSessionRuntimeEnvelope.mockReturnValue({ ok: true });
  });

  it("rechecks the session envelope after hook parameter rewrites", async () => {
    envelopeMocks.readSessionRuntimeEnvelope.mockReturnValue({
      ok: true,
      envelope: { allowedPaths: ["/repo/src/**"] },
    });
    installBeforeToolCallHook(async () => ({ params: { path: "/repo/secrets/token.txt" } }));
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as never, {
      sessionKey: "agent:main:main",
    });
    const onUpdate = vi.fn();

    await expect(
      tool.execute("call-envelope-rewrite", { path: "/repo/src/index.ts" }, undefined, onUpdate),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Path outside session envelope: /repo/secrets/token.txt" }],
      details: {
        status: "blocked",
        deniedReason: "session-envelope",
        reason: "Path outside session envelope: /repo/secrets/token.txt",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses hook workspace context for relative session envelope path checks", async () => {
    envelopeMocks.readSessionRuntimeEnvelope.mockReturnValue({
      ok: true,
      envelope: { deniedPaths: ["/repo/secrets/**"] },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as never, {
      sessionKey: "agent:main:main",
      workspaceDir: "/repo",
    });
    const onUpdate = vi.fn();

    await expect(
      tool.execute("call-envelope-relative", { path: "secrets/token.txt" }, undefined, onUpdate),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "Path blocked by session envelope: /repo/secrets/token.txt" },
      ],
      details: {
        status: "blocked",
        deniedReason: "session-envelope",
        reason: "Path blocked by session envelope: /repo/secrets/token.txt",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when the session envelope cannot be loaded", async () => {
    envelopeMocks.readSessionRuntimeEnvelope.mockReturnValue({
      ok: false,
      reason: "Session envelope unavailable; blocking tool call: store read failed",
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as never, {
      sessionKey: "agent:main:main",
    });
    const onUpdate = vi.fn();

    await expect(
      tool.execute("call-envelope-read-fail", { path: "/repo/src/index.ts" }, undefined, onUpdate),
    ).rejects.toThrow("Session envelope unavailable; blocking tool call: store read failed");
    expect(execute).not.toHaveBeenCalled();
  });
});
