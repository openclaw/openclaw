import { afterEach, expect, test, vi } from "vitest";
import {
  addSession,
  getFinishedSession,
  getSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

const {
  openSandboxKillCommandSessionMock,
  openSandboxReadCommandOutputMock,
  openSandboxReadCommandStatusMock,
} = vi.hoisted(() => ({
  openSandboxKillCommandSessionMock: vi.fn(),
  openSandboxReadCommandOutputMock: vi.fn(),
  openSandboxReadCommandStatusMock: vi.fn(),
}));

vi.mock("./sandbox/opensandbox-command.js", () => ({
  openSandboxReadCommandOutput: (...args: unknown[]) => openSandboxReadCommandOutputMock(...args),
  openSandboxReadCommandStatus: (...args: unknown[]) => openSandboxReadCommandStatusMock(...args),
  openSandboxKillCommandSession: (...args: unknown[]) => openSandboxKillCommandSessionMock(...args),
}));

afterEach(() => {
  resetProcessRegistryForTests();
  openSandboxKillCommandSessionMock.mockReset();
  openSandboxReadCommandOutputMock.mockReset();
  openSandboxReadCommandStatusMock.mockReset();
});

function firstText(result: { content: Array<{ type: string; text?: string }> }) {
  const item = result.content.find((entry) => entry.type === "text");
  return item?.text ?? "";
}

test("process poll syncs opensandbox output and completion", async () => {
  const session = createProcessSessionFixture({
    id: "sess-os-1",
    command: "echo hello",
    backgrounded: true,
  });
  session.remote = {
    provider: "opensandbox",
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    commandSessionId: "remote-session-1",
    outputCursor: 0,
  };
  addSession(session);

  openSandboxReadCommandOutputMock.mockResolvedValue([{ fd: 1, msg: "hello\n" }]);
  openSandboxReadCommandStatusMock.mockResolvedValue({ running: false, exitCode: 0 });

  const processTool = createProcessTool();
  const result = await processTool.execute("toolcall", {
    action: "poll",
    sessionId: "sess-os-1",
  });

  expect(openSandboxReadCommandOutputMock).toHaveBeenCalledWith({
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    sessionId: "remote-session-1",
  });
  expect(openSandboxReadCommandStatusMock).toHaveBeenCalledWith({
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    sessionId: "remote-session-1",
  });
  expect(result.details).toMatchObject({
    status: "completed",
    sessionId: "sess-os-1",
  });
  expect((result.details as { aggregated?: string }).aggregated ?? "").toContain("hello");
  expect(firstText(result as { content: Array<{ type: string; text?: string }> })).toContain(
    "Process exited with code 0",
  );
  expect(getFinishedSession("sess-os-1")).toBeDefined();
});

test("process send-keys fails for opensandbox remote sessions", async () => {
  const session = createProcessSessionFixture({
    id: "sess-os-2",
    command: "bash",
    backgrounded: true,
  });
  session.remote = {
    provider: "opensandbox",
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    commandSessionId: "remote-session-2",
    outputCursor: 0,
  };
  addSession(session);

  const processTool = createProcessTool();
  const result = await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId: "sess-os-2",
    keys: ["Enter"],
  });

  expect(result.details).toMatchObject({ status: "failed" });
  expect(firstText(result as { content: Array<{ type: string; text?: string }> })).toContain(
    "send-keys is unavailable because execd does not expose a command-session stdin write endpoint",
  );
  expect(openSandboxReadCommandOutputMock).not.toHaveBeenCalled();
  expect(openSandboxReadCommandStatusMock).not.toHaveBeenCalled();
  expect(openSandboxKillCommandSessionMock).not.toHaveBeenCalled();
});

test("process remove keeps completed status for already-exited opensandbox session", async () => {
  const session = createProcessSessionFixture({
    id: "sess-os-3",
    command: "echo done",
    backgrounded: true,
  });
  session.remote = {
    provider: "opensandbox",
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    commandSessionId: "remote-session-3",
    outputCursor: 0,
  };
  session.exited = true;
  session.exitCode = 0;
  addSession(session);

  const processTool = createProcessTool();
  const result = await processTool.execute("toolcall", {
    action: "remove",
    sessionId: "sess-os-3",
  });

  expect(result.details).toMatchObject({ status: "completed" });
  expect(firstText(result as { content: Array<{ type: string; text?: string }> })).toContain(
    "Removed remote session sess-os-3.",
  );
  expect(openSandboxKillCommandSessionMock).not.toHaveBeenCalled();
  expect(getSession("sess-os-3")).toBeUndefined();
  expect(getFinishedSession("sess-os-3")).toBeUndefined();
});
