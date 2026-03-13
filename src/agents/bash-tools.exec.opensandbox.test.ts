import { afterEach, expect, test, vi } from "vitest";
import {
  getFinishedSession,
  getSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

const {
  openSandboxReadCommandOutputMock,
  openSandboxReadCommandStatusMock,
  openSandboxStartCommandSessionMock,
} = vi.hoisted(() => ({
  openSandboxReadCommandOutputMock: vi.fn(),
  openSandboxReadCommandStatusMock: vi.fn(),
  openSandboxStartCommandSessionMock: vi.fn(),
}));

vi.mock("./sandbox/opensandbox-command.js", () => ({
  openSandboxReadCommandOutput: (...args: unknown[]) => openSandboxReadCommandOutputMock(...args),
  openSandboxReadCommandStatus: (...args: unknown[]) => openSandboxReadCommandStatusMock(...args),
  openSandboxStartCommandSession: (...args: unknown[]) =>
    openSandboxStartCommandSessionMock(...args),
}));

afterEach(() => {
  resetProcessRegistryForTests();
  openSandboxReadCommandOutputMock.mockReset();
  openSandboxReadCommandStatusMock.mockReset();
  openSandboxStartCommandSessionMock.mockReset();
});

function firstText(result: { content: Array<{ type: string; text?: string }> }) {
  const item = result.content.find((entry) => entry.type === "text");
  return item?.text ?? "";
}

test("opensandbox background exec creates remote process session", async () => {
  openSandboxStartCommandSessionMock.mockResolvedValue("remote-session-1");

  const execTool = createExecTool({
    host: "sandbox",
    security: "full",
    ask: "off",
    allowBackground: true,
    sandbox: {
      backendKind: "opensandbox",
      opensandboxBaseUrl: "https://sandbox.example.test/execd",
      opensandboxAccessToken: "token-1",
      opensandboxTimeoutSec: 300,
      containerName: "unused",
      workspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
    },
  });

  const result = await execTool.execute("toolcall", {
    command: "echo hello",
    background: true,
    timeout: 12,
  });

  expect(result.details).toMatchObject({
    status: "running",
  });
  const sessionId = (result.details as { sessionId: string }).sessionId;
  const session = getSession(sessionId);
  expect(session).toBeDefined();
  expect(session?.remote).toMatchObject({
    provider: "opensandbox",
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    commandSessionId: "remote-session-1",
    outputCursor: 0,
  });
  expect(openSandboxStartCommandSessionMock).toHaveBeenCalledWith({
    baseUrl: "https://sandbox.example.test/execd",
    accessToken: "token-1",
    command: "echo hello",
    workdir: "/workspace",
    timeoutSec: 12,
  });
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect(firstText(result as { content: Array<{ type: string; text?: string }> })).toContain(
    "process write/send-keys/submit/paste are unavailable",
  );
});

test("opensandbox yield waits for completion within yield window", async () => {
  openSandboxStartCommandSessionMock.mockResolvedValue("remote-session-2");
  openSandboxReadCommandOutputMock.mockResolvedValue([{ fd: 1, msg: "done\n" }]);
  openSandboxReadCommandStatusMock.mockResolvedValue({ running: false, exitCode: 0 });

  const execTool = createExecTool({
    host: "sandbox",
    security: "full",
    ask: "off",
    allowBackground: true,
    sandbox: {
      backendKind: "opensandbox",
      opensandboxBaseUrl: "https://sandbox.example.test/execd",
      opensandboxAccessToken: "token-1",
      opensandboxTimeoutSec: 300,
      containerName: "unused",
      workspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
    },
  });

  const result = await execTool.execute("toolcall", {
    command: "echo done",
    yieldMs: 200,
    timeout: 12,
  });

  expect(result.details).toMatchObject({
    status: "completed",
    exitCode: 0,
  });
  expect(firstText(result as { content: Array<{ type: string; text?: string }> })).toContain(
    "done",
  );
  expect(openSandboxReadCommandStatusMock).toHaveBeenCalled();
  const sessionId = "sessionId" in result.details ? result.details.sessionId : undefined;
  if (sessionId) {
    expect(getSession(sessionId)).toBeUndefined();
    expect(getFinishedSession(sessionId)).toBeUndefined();
  }
});

test("opensandbox default yield backgrounds through remote session path", async () => {
  openSandboxStartCommandSessionMock.mockResolvedValue("remote-session-3");
  openSandboxReadCommandOutputMock.mockResolvedValue([]);
  openSandboxReadCommandStatusMock.mockResolvedValue({ running: true });

  const execTool = createExecTool({
    host: "sandbox",
    security: "full",
    ask: "off",
    allowBackground: true,
    backgroundMs: 10,
    sandbox: {
      backendKind: "opensandbox",
      opensandboxBaseUrl: "https://sandbox.example.test/execd",
      opensandboxAccessToken: "token-1",
      opensandboxTimeoutSec: 300,
      containerName: "unused",
      workspaceDir: process.cwd(),
      containerWorkdir: "/workspace",
    },
  });

  const result = await execTool.execute("toolcall", {
    command: "sleep 999",
  });

  expect(result.details).toMatchObject({
    status: "running",
  });
  const sessionId = (result.details as { sessionId: string }).sessionId;
  const session = getSession(sessionId);
  expect(session?.remote).toMatchObject({
    provider: "opensandbox",
    commandSessionId: "remote-session-3",
  });
  expect(openSandboxReadCommandStatusMock).toHaveBeenCalled();
  expect(firstText(result as { content: Array<{ type: string; text?: string }> })).toContain(
    "Command still running",
  );
});
