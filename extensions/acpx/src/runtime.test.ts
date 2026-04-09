import { describe, expect, it, vi } from "vitest";

const { AcpRuntimeErrorMock } = vi.hoisted(() => ({
  AcpRuntimeErrorMock: class AcpRuntimeError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "AcpRuntimeError";
      this.code = code;
    }
  },
}));

vi.mock("../runtime-api.js", () => ({
  AcpRuntimeError: AcpRuntimeErrorMock,
}));

import {
  AcpxRuntime,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
} from "./runtime.js";

describe("AcpxRuntime", () => {
  it("delegates session lifecycle to the native manager", async () => {
    const encoded = encodeAcpxRuntimeHandleState({
      name: "agent:codex:acp:test",
      agent: "codex",
      cwd: "/tmp/acpx",
      mode: "persistent",
      acpxRecordId: "agent:codex:acp:test",
      backendSessionId: "sid-1",
      agentSessionId: "inner-1",
    });
    expect(decodeAcpxRuntimeHandleState(encoded)).toEqual({
      name: "agent:codex:acp:test",
      agent: "codex",
      cwd: "/tmp/acpx",
      mode: "persistent",
      acpxRecordId: "agent:codex:acp:test",
      backendSessionId: "sid-1",
      agentSessionId: "inner-1",
    });

    const manager = {
      ensureSession: vi.fn(async () => ({
        acpxRecordId: "agent:codex:acp:test",
        acpSessionId: "sid-1",
        agentSessionId: "inner-1",
        cwd: "/tmp/acpx",
      })),
      runTurn: vi.fn(async function* () {
        yield { type: "text_delta", text: "hello", stream: "output" };
        yield { type: "done", stopReason: "end_turn" };
      }),
      getStatus: vi.fn(async () => ({
        summary: "status=ok",
        acpxRecordId: "agent:codex:acp:test",
      })),
      setMode: vi.fn(async () => {}),
      setConfigOption: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const runtime = new AcpxRuntime(
      {
        cwd: "/tmp/acpx",
        stateDir: "/tmp/acpx/state",
        permissionMode: "approve-reads",
        nonInteractivePermissions: "fail",
        pluginToolsMcpBridge: false,
        strictWindowsCmdWrapper: true,
        queueOwnerTtlSeconds: 0.1,
        mcpServers: {},
        agents: {},
      },
      {
        managerFactory: () => manager as never,
      },
    );

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:test",
      agent: "codex",
      mode: "persistent",
    });
    expect(handle.acpxRecordId).toBe("agent:codex:acp:test");
    expect(handle.backendSessionId).toBe("sid-1");
    expect(handle.agentSessionId).toBe("inner-1");

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "req-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello", stream: "output" },
      { type: "done", stopReason: "end_turn" },
    ]);

    await runtime.getStatus({ handle });
    await runtime.setMode({ handle, mode: "architect" });
    await runtime.setConfigOption({ handle, key: "approval", value: "manual" });
    await runtime.cancel({ handle });
    await runtime.close({ handle, reason: "test" });

    expect(manager.ensureSession).toHaveBeenCalledOnce();
    expect(manager.runTurn).toHaveBeenCalledOnce();
    expect(manager.getStatus).toHaveBeenCalledOnce();
    expect(manager.setMode).toHaveBeenCalledOnce();
    expect(manager.setConfigOption).toHaveBeenCalledOnce();
    expect(manager.cancel).toHaveBeenCalledOnce();
    expect(manager.close).toHaveBeenCalledOnce();
  });
});
