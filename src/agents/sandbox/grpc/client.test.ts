import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to create mocks that are available in vi.mock factories
const {
  mockSandboxClient,
  mockExecClient,
  mockHealthClient,
  mockChannel,
  mockCreate,
  mockUse,
  mockCreateClientFactory,
  mockCreateClient,
} = vi.hoisted(() => {
  const mockSandboxClient = {
    createSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    sandboxStatus: vi.fn(),
    listSandboxes: vi.fn(),
  };
  const mockExecClient = {
    exec: vi.fn(),
  };
  const mockHealthClient = { check: vi.fn() };
  const mockChannel = { close: vi.fn() };
  const mockCreate = vi.fn(() => mockSandboxClient);
  const mockUse = vi.fn(() => ({ use: mockUse, create: mockCreate })) as any;
  const mockCreateClientFactory = vi.fn(() => ({ use: mockUse }));
  const mockFileClient = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listDir: vi.fn(),
    stat: vi.fn(),
    makeDir: vi.fn(),
    remove: vi.fn(),
  };
  const mockCreateClient = vi.fn((def: any) => {
    if (def.name === "ExecService") return mockExecClient;
    if (def.name === "FileService") return mockFileClient;
    return mockHealthClient;
  });

  return {
    mockSandboxClient,
    mockExecClient,
    mockHealthClient,
    mockFileClient,
    mockChannel,
    mockCreate,
    mockUse,
    mockCreateClientFactory,
    mockCreateClient,
  };
});

vi.mock("nice-grpc", () => ({
  createClientFactory: mockCreateClientFactory,
  createClient: mockCreateClient,
  createChannel: vi.fn(() => mockChannel),
}));

vi.mock("nice-grpc-client-middleware-retry", () => ({
  retryMiddleware: "RETRY_MIDDLEWARE",
}));

vi.mock("nice-grpc-client-middleware-deadline", () => ({
  deadlineMiddleware: "DEADLINE_MIDDLEWARE",
}));

vi.mock("./channel.js", () => ({
  getOrCreateChannel: vi.fn(() => mockChannel),
  VM_RUNNER_SOCKET: "/var/run/openclaw-vm-runner.sock",
}));

import {
  createSandboxClient,
  createExecClient,
  createFileClient,
  createHealthClient,
} from "./client.js";
import type { FileClient } from "./client.js";

describe("createSandboxClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the chained mock return
    mockUse.mockReturnValue({ use: mockUse, create: mockCreate });
  });

  it("returns a nice-grpc client wrapping the SandboxService definition", () => {
    const client = createSandboxClient();
    expect(client).toBeDefined();
    expect(mockCreateClientFactory).toHaveBeenCalled();
  });

  it("uses retry middleware", () => {
    createSandboxClient();
    const allUseArgs = mockUse.mock.calls.flat();
    expect(allUseArgs).toContain("RETRY_MIDDLEWARE");
  });

  it("uses deadline middleware", () => {
    createSandboxClient();
    const allUseArgs = mockUse.mock.calls.flat();
    expect(allUseArgs).toContain("DEADLINE_MIDDLEWARE");
  });

  it("creates client with the SandboxService definition and channel", () => {
    createSandboxClient();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockCreate.mock.calls[0] as any[];
    expect(createArgs[0]).toHaveProperty("name", "SandboxService");
    expect(createArgs[1]).toBe(mockChannel);
  });
});

describe("createExecClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a gRPC client for ExecService", () => {
    const client = createExecClient();
    expect(client).toBeDefined();
    expect(mockCreateClient).toHaveBeenCalled();
    const createArgs = mockCreateClient.mock.calls[0] as any[];
    expect(createArgs[0]).toHaveProperty("name", "ExecService");
  });

  it("uses plain createClient without retry middleware", () => {
    createExecClient();
    // Should NOT use createClientFactory (that's for retry/deadline middleware)
    expect(mockCreateClientFactory).not.toHaveBeenCalled();
  });
});

describe("createHealthClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a gRPC health check client", () => {
    const client = createHealthClient();
    expect(client).toBeDefined();
    expect(mockCreateClient).toHaveBeenCalled();
  });
});

describe("createFileClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a gRPC client for FileService", () => {
    const client = createFileClient();
    expect(client).toBeDefined();
    expect(mockCreateClient).toHaveBeenCalled();
    const createArgs = mockCreateClient.mock.calls[0] as any[];
    expect(createArgs[0]).toHaveProperty("name", "FileService");
  });

  it("uses plain createClient without retry middleware (streaming RPCs)", () => {
    createFileClient();
    // Should NOT use createClientFactory (that's for retry/deadline middleware)
    expect(mockCreateClientFactory).not.toHaveBeenCalled();
  });

  it("passes the channel from getOrCreateChannel", () => {
    createFileClient();
    const createArgs = mockCreateClient.mock.calls[0] as any[];
    expect(createArgs[1]).toBe(mockChannel);
  });

  it("FileClient type alias is usable (compile-time check)", () => {
    const client: FileClient = createFileClient();
    expect(client).toBeDefined();
  });
});
