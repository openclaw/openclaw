// ACP client stream error tests — verify that createAcpClient registers
// error handlers on the spawned child process pipes. The tests call the
// production function and prove the handlers exist by emitting errors
// that would otherwise crash the process.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockChild = ReturnType<typeof createChild>;

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

let child: MockChild;

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => child),
  ensureOpenClawCliOnPath: vi.fn(),
  getActiveSkillEnvKeys: vi.fn(() => []),
  buildAcpClientStripKeys: vi.fn(() => []),
  resolveAcpClientSpawnEnv: vi.fn(() => ({ OPENCLAW_ACP: "1" })),
  resolveAcpClientSpawnInvocation: vi.fn(() => ({
    command: "/usr/bin/env",
    args: ["openclaw", "acp"],
    shell: false,
    windowsHide: true,
  })),
  shouldStripProviderAuthEnvVarsForAcpServer: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: mocks.ensureOpenClawCliOnPath }));
vi.mock("../skills/runtime/env-overrides.runtime.js", () => ({
  getActiveSkillEnvKeys: mocks.getActiveSkillEnvKeys,
}));
vi.mock("./client-helpers.js", () => ({
  buildAcpClientStripKeys: mocks.buildAcpClientStripKeys,
  resolveAcpClientSpawnEnv: mocks.resolveAcpClientSpawnEnv,
  resolveAcpClientSpawnInvocation: mocks.resolveAcpClientSpawnInvocation,
  shouldStripProviderAuthEnvVarsForAcpServer: mocks.shouldStripProviderAuthEnvVarsForAcpServer,
}));

let sdkInitReject: (e: Error) => void;

vi.mock("@agentclientprotocol/sdk", () => {
  function MockClientSideConnection() {
    return {
      initialize: vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            sdkInitResolve = resolve;
            sdkInitReject = reject;
          }),
      ),
      newSession: vi.fn(async () => ({ sessionId: "test" })),
    };
  }
  return {
    ClientSideConnection: MockClientSideConnection,
    PROTOCOL_VERSION: 1,
    ndJsonStream: vi.fn(() => ({})),
  };
});

type ClientModule = typeof import("./client.js");
let createAcpClient: ClientModule["testing"]["createAcpClient"];

describe("ACP client stream errors (production path)", () => {
  beforeAll(async () => {
    ({
      testing: { createAcpClient },
    } = await import("./client.js"));
  });

  beforeEach(() => {
    child = createChild();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up hanging promise
    try {
      sdkInitReject(new Error("cleanup"));
    } catch {}
    vi.clearAllMocks();
  });

  it("registers error handler on stdout through createAcpClient", async () => {
    const promise = createAcpClient({ cwd: "/tmp", serverCommand: "echo" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    // Production code registered agent.stdout.on("error", ...) — emitting must not crash.
    expect(() => {
      child.stdout.emit("error", new Error("stdout EPIPE"));
    }).not.toThrow();
    sdkInitReject(new Error("cleanup"));
    try {
      await promise;
    } catch {}
  });

  it("registers error handler on stdin through createAcpClient", async () => {
    const promise = createAcpClient({ cwd: "/tmp", serverCommand: "echo" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(() => {
      child.stdin.emit("error", new Error("stdin EPIPE"));
    }).not.toThrow();
    sdkInitReject(new Error("cleanup"));
    try {
      await promise;
    } catch {}
  });

  it("registers error handler on child process through createAcpClient", async () => {
    const promise = createAcpClient({ cwd: "/tmp", serverCommand: "echo" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(() => {
      child.emit("error", new Error("spawn ENOENT"));
    }).not.toThrow();
    sdkInitReject(new Error("cleanup"));
    try {
      await promise;
    } catch {}
  });

  it("handles simultaneous stdout+stdin errors through createAcpClient", async () => {
    const promise = createAcpClient({ cwd: "/tmp", serverCommand: "echo" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(() => {
      child.stdout.emit("error", new Error("stdout first"));
      child.stdin.emit("error", new Error("stdin second"));
    }).not.toThrow();
    sdkInitReject(new Error("cleanup"));
    try {
      await promise;
    } catch {}
  });

  // Negative control: without error listener, PassThrough throws.
  // Removing the production handlers would make this test pass —
  // but then createAcpClient would crash on a real EPIPE.
  it("negative control: PassThrough without error listener throws", () => {
    const raw = new PassThrough();
    expect(() => {
      raw.emit("error", new Error("unhandled EPIPE"));
    }).toThrow();
  });
});
