import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/cloud-sandbox-registry.js", () => ({
  resolveCloudSandboxProvider: vi.fn(),
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: vi.fn().mockReturnValue({
    approvals: {},
    hostSecurity: "allowlist",
    hostAsk: "on-miss",
    askFallback: undefined,
  }),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  emitExecSystemEvent: vi.fn(),
}));

vi.mock("./bash-process-registry.js", () => ({
  addSession: vi.fn(),
  appendOutput: vi.fn(),
  createSessionSlug: vi.fn().mockReturnValue("slug-fallback-1"),
  markBackgrounded: vi.fn(),
  markExited: vi.fn(),
}));

import type { CloudSandboxProvider } from "../infra/cloud-sandbox-provider.js";
import { addSession, markBackgrounded } from "./bash-process-registry.js";
import { executeCloudHostCommand } from "./bash-tools.exec-host-cloud.js";

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item.type === "text" && typeof item.text === "string") {
    return item.text;
  }
  throw new Error(`Expected text content, got ${item.type}`);
}

function createMockProvider(overrides?: Partial<CloudSandboxProvider>): CloudSandboxProvider {
  return {
    id: "test-cloud",
    exec: vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
    }),
    execBackground: vi.fn<CloudSandboxProvider["execBackground"]>().mockResolvedValue({
      sessionId: "bg-session-1",
      initialOutput: "starting...",
    }),
    readSessionLog: vi.fn().mockResolvedValue({ done: true, output: "", exitCode: 0 }),
    killSession: vi.fn(),
    ensureReady: vi.fn<CloudSandboxProvider["ensureReady"]>().mockResolvedValue(undefined),
    dispose: vi.fn(),
    isReady: () => true,
    ...overrides,
  };
}

const baseParams = {
  command: "echo hello",
  workdir: "/tmp",
  env: {},
  defaultTimeoutSec: 120,
  security: "allowlist" as const,
  ask: "on-miss" as const,
  warnings: [],
};

describe("executeCloudHostCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when no provider is available", async () => {
    await expect(executeCloudHostCommand({ ...baseParams, provider: null })).rejects.toThrow(
      "exec host=cloud requires a cloud sandbox plugin",
    );
  });

  it("calls ensureReady before exec", async () => {
    const ensureReadyMock = vi
      .fn<CloudSandboxProvider["ensureReady"]>()
      .mockResolvedValue(undefined);
    const execMock = vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
    });
    const provider = createMockProvider({ ensureReady: ensureReadyMock, exec: execMock });
    await executeCloudHostCommand({ ...baseParams, provider });
    expect(ensureReadyMock).toHaveBeenCalledOnce();
    expect(execMock).toHaveBeenCalledOnce();
    const execCall = execMock.mock.calls[0][0];
    expect(execCall.command).toBe("echo hello");
    expect(execCall.cwd).toBe("/tmp");
  });

  it("returns formatted result for successful sync exec", async () => {
    const provider = createMockProvider();
    const result = await executeCloudHostCommand({ ...baseParams, provider });
    expect(getTextContent(result)).toBe("hello world");
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
  });

  it("returns failed status for non-zero exit code", async () => {
    const provider = createMockProvider({
      exec: vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "command not found",
        timedOut: false,
      }),
    });
    const result = await executeCloudHostCommand({ ...baseParams, provider });
    expect(getTextContent(result)).toBe("[stderr]\ncommand not found");
    expect(result.details).toMatchObject({
      status: "failed",
      exitCode: 1,
    });
  });

  it("includes timeout indicator when command times out", async () => {
    const provider = createMockProvider({
      exec: vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
        exitCode: 137,
        stdout: "partial",
        stderr: "",
        timedOut: true,
      }),
    });
    const result = await executeCloudHostCommand({
      ...baseParams,
      provider,
      timeoutSec: 30,
    });
    expect(getTextContent(result)).toContain("[timed out after 30000ms]");
    expect(result.details).toMatchObject({
      status: "failed",
    });
  });

  it("passes timeout to provider", async () => {
    const execMock = vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
    });
    const provider = createMockProvider({ exec: execMock });
    await executeCloudHostCommand({
      ...baseParams,
      provider,
      timeoutSec: 60,
    });
    const execCall = execMock.mock.calls[0][0];
    expect(execCall.timeoutMs).toBe(60_000);
  });

  it("uses defaultTimeoutSec when no explicit timeout", async () => {
    const execMock = vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
    });
    const provider = createMockProvider({ exec: execMock });
    await executeCloudHostCommand({
      ...baseParams,
      provider,
      defaultTimeoutSec: 90,
    });
    const execCall = execMock.mock.calls[0][0];
    expect(execCall.timeoutMs).toBe(90_000);
  });

  it("handles background execution", async () => {
    const execMock = vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    const execBackgroundMock = vi.fn<CloudSandboxProvider["execBackground"]>().mockResolvedValue({
      sessionId: "bg-session-1",
      initialOutput: "starting...",
    });
    const provider = createMockProvider({
      exec: execMock,
      execBackground: execBackgroundMock,
    });
    const result = await executeCloudHostCommand({
      ...baseParams,
      provider,
      backgroundMs: 0,
    });
    expect(execBackgroundMock).toHaveBeenCalledOnce();
    expect(execMock).not.toHaveBeenCalled();
    expect(getTextContent(result)).toContain("cloud sandbox");
    expect(getTextContent(result)).toContain("bg-session-1");
    expect(result.details).toMatchObject({
      status: "running",
      sessionId: "bg-session-1",
    });
    // Verify proxy session is registered in the process registry
    expect(addSession).toHaveBeenCalledOnce();
    expect(markBackgrounded).toHaveBeenCalledOnce();
  });

  it("includes initial output in background result", async () => {
    const provider = createMockProvider();
    const result = await executeCloudHostCommand({
      ...baseParams,
      provider,
      backgroundMs: 0,
    });
    expect(getTextContent(result)).toContain("starting...");
  });

  it("wraps provider exec errors with provider id", async () => {
    const provider = createMockProvider({
      exec: vi.fn().mockRejectedValue(new Error("network timeout")),
    });
    await expect(executeCloudHostCommand({ ...baseParams, provider })).rejects.toThrow(
      "Cloud sandbox exec failed (provider=test-cloud): network timeout",
    );
  });

  it("returns (no output) when stdout and stderr are empty", async () => {
    const provider = createMockProvider({
      exec: vi.fn<CloudSandboxProvider["exec"]>().mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    const result = await executeCloudHostCommand({ ...baseParams, provider });
    expect(getTextContent(result)).toBe("(no output)");
  });

  it("prepends warnings to output", async () => {
    const provider = createMockProvider();
    const result = await executeCloudHostCommand({
      ...baseParams,
      provider,
      warnings: ["Warning: pathPrepend ignored"],
    });
    expect(getTextContent(result)).toContain("Warning: pathPrepend ignored");
    expect(getTextContent(result)).toContain("hello world");
  });

  it("sets onKill on proxy session that delegates to provider.killSession", async () => {
    const killSessionMock = vi
      .fn<CloudSandboxProvider["killSession"]>()
      .mockResolvedValue(undefined);
    const provider = createMockProvider({ killSession: killSessionMock });
    await executeCloudHostCommand({
      ...baseParams,
      provider,
      backgroundMs: 0,
    });
    // Extract the proxy session passed to addSession
    const addSessionMock = vi.mocked(addSession);
    expect(addSessionMock).toHaveBeenCalledOnce();
    const proxySession = addSessionMock.mock.calls[0][0];
    expect(proxySession.onKill).toBeTypeOf("function");
    // Invoke onKill and verify it delegates to provider.killSession
    await proxySession.onKill!();
    expect(killSessionMock).toHaveBeenCalledWith("bg-session-1");
  });
});
