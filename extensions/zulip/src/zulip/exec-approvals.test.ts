import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions.js";
import type { ZulipExecApprovalConfig } from "../types.js";
import type { ZulipUser } from "./client.js";
import {
  buildZulipExecApprovalCallbackData,
  parseZulipExecApprovalCallbackData,
  ZulipExecApprovalHandler,
  type ZulipExecApprovalCallbackResult,
} from "./exec-approvals.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-zulip-exec-approvals-test.json");

const mockState = vi.hoisted(() => ({
  sendZulipComponentMessage: vi.fn(async () => ({ messageId: "42", target: "dm:123" })),
  sendMessageZulip: vi.fn(async () => ({ messageId: "43", target: "dm:123" })),
  fetchZulipUsers: vi.fn<() => Promise<ZulipUser[]>>(async () => []),
  updateZulipMessage: vi.fn(async () => ({ result: "success" })),
  removeZulipComponentMessageEntries: vi.fn(async () => 0),
  buildGatewayConnectionDetails: vi.fn(() => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
  })),
  resolveGatewayConnectionAuth: vi.fn(async () => ({
    token: "gateway-token",
    password: undefined,
  })),
  gatewayClientStarts: vi.fn(),
  gatewayClientStops: vi.fn(),
  gatewayClientRequests: vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
  })),
  gatewayClientCtorParams: [] as Array<Record<string, unknown>>,
}));

vi.mock("./send-components.js", () => ({
  sendZulipComponentMessage: mockState.sendZulipComponentMessage,
}));

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageZulip: mockState.sendMessageZulip,
  };
});

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchZulipUsers: mockState.fetchZulipUsers,
    updateZulipMessage: mockState.updateZulipMessage,
  };
});

vi.mock("./components-registry.js", () => ({
  removeZulipComponentMessageEntries: mockState.removeZulipComponentMessageEntries,
}));

vi.mock("../../../../src/gateway/call.js", () => ({
  buildGatewayConnectionDetails: mockState.buildGatewayConnectionDetails,
}));

vi.mock("../../../../src/gateway/connection-auth.js", () => ({
  resolveGatewayConnectionAuth: mockState.resolveGatewayConnectionAuth,
}));

vi.mock("../../../../src/gateway/client.js", () => ({
  GatewayClient: class {
    constructor(params: Record<string, unknown>) {
      mockState.gatewayClientCtorParams.push(params);
    }
    start() {
      mockState.gatewayClientStarts();
    }
    stop() {
      mockState.gatewayClientStops();
    }
    async request(method: string, params: Record<string, unknown>) {
      return mockState.gatewayClientRequests(method, params);
    }
  },
}));

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

function pendingApprovalsPath(accountId = "default") {
  return path.join(stateDir, "zulip", `exec-approvals-${accountId}.json`);
}

function createRequest(
  overrides: Partial<{
    command: string;
    agentId: string | null;
    sessionKey: string | null;
    turnSourceChannel: string | null;
    turnSourceTo: string | null;
    turnSourceAccountId: string | null;
  }> = {},
) {
  return {
    id: "approval-1",
    request: {
      command: overrides.command ?? "echo hello",
      cwd: "/tmp/project",
      host: "gateway",
      agentId: overrides.agentId ?? "archie",
      sessionKey: overrides.sessionKey ?? "agent:archie:zulip:stream:ops:topic:deploy",
      turnSourceChannel: overrides.turnSourceChannel,
      turnSourceTo: overrides.turnSourceTo,
      turnSourceAccountId: overrides.turnSourceAccountId,
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

function createHandler(
  config: ZulipExecApprovalConfig,
  opts: {
    accountId?: string;
    widgetsEnabled?: boolean;
  } = {},
) {
  return new ZulipExecApprovalHandler({
    client: {
      baseUrl: "https://zulip.example.com",
      botEmail: "bot@example.com",
      botApiKey: "bot-key",
      authHeader: "Basic abc",
      request: vi.fn(),
      requestForm: vi.fn(),
    },
    accountId: opts.accountId ?? "default",
    config,
    cfg: { session: { store: STORE_PATH } },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    widgetsEnabled: opts.widgetsEnabled ?? true,
  });
}

type HandlerInternals = {
  pending: Map<
    string,
    {
      request: ReturnType<typeof createRequest>;
      messages: Array<{ messageId: number; target: string }>;
      timeoutId: NodeJS.Timeout;
    }
  >;
  handleApprovalRequested: (request: ReturnType<typeof createRequest>) => Promise<void>;
  handleApprovalResolved: (resolved: {
    id: string;
    decision: "allow-once" | "allow-always" | "deny";
    resolvedBy?: string | null;
    ts: number;
  }) => Promise<void>;
  handleApprovalTimeout: (approvalId: string) => Promise<void>;
};

function getInternals(handler: ZulipExecApprovalHandler): HandlerInternals {
  return handler as unknown as HandlerInternals;
}

function clearPendingTimeouts(handler: ZulipExecApprovalHandler) {
  const internals = getInternals(handler);
  for (const pending of internals.pending.values()) {
    clearTimeout(pending.timeoutId);
  }
  internals.pending.clear();
}

let stateDir: string;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-zulip-approvals-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  writeStore({});
  vi.clearAllMocks();
  mockState.sendZulipComponentMessage.mockResolvedValue({ messageId: "42", target: "dm:123" });
  mockState.sendMessageZulip.mockResolvedValue({ messageId: "43", target: "dm:123" });
  mockState.fetchZulipUsers.mockResolvedValue([]);
  mockState.updateZulipMessage.mockResolvedValue({ result: "success" });
  mockState.removeZulipComponentMessageEntries.mockResolvedValue(0);
  mockState.buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
  });
  mockState.resolveGatewayConnectionAuth.mockResolvedValue({
    token: "gateway-token",
    password: undefined,
  });
  mockState.gatewayClientCtorParams.length = 0;
  mockState.gatewayClientRequests.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (originalStateDir == null) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("zulip exec approval callback data", () => {
  it("round-trips callback data", () => {
    const callbackData = buildZulipExecApprovalCallbackData("approval:1/2", "allow-always");
    expect(parseZulipExecApprovalCallbackData(callbackData)).toEqual({
      approvalId: "approval:1/2",
      action: "allow-always",
    });
  });

  it("rejects invalid callback payloads", () => {
    expect(parseZulipExecApprovalCallbackData("model:fast")).toBeNull();
    expect(parseZulipExecApprovalCallbackData("exec_approval:abc:later")).toBeNull();
  });
});

describe("ZulipExecApprovalHandler", () => {
  it("sends widget approval prompts to approver DMs", async () => {
    const handler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    const request = createRequest();

    await getInternals(handler).handleApprovalRequested(request);

    expect(mockState.sendZulipComponentMessage).toHaveBeenCalledWith(
      "dm:123",
      expect.stringContaining("Exec approval required"),
      expect.objectContaining({
        heading: "Exec Approval Required",
        buttons: expect.arrayContaining([
          expect.objectContaining({ label: "Allow once", allowedUsers: [123] }),
          expect.objectContaining({ label: "Always allow", allowedUsers: [123] }),
          expect.objectContaining({ label: "Deny", allowedUsers: [123] }),
        ]),
      }),
      expect.objectContaining({ accountId: "default", agentId: "archie" }),
    );

    clearPendingTimeouts(handler);
  });

  it("sends session-target prompts to the originating Zulip target with shared approver allowlist", async () => {
    const handler = createHandler({ enabled: true, approvers: [123], target: "session" });
    const request = createRequest({
      turnSourceChannel: "zulip",
      turnSourceTo: "stream:ops:topic:deploy",
      turnSourceAccountId: "default",
    });

    await getInternals(handler).handleApprovalRequested(request);

    expect(mockState.sendZulipComponentMessage).toHaveBeenCalledWith(
      "stream:ops:topic:deploy",
      expect.any(String),
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ label: "Allow once", allowedUsers: [123] }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );

    clearPendingTimeouts(handler);
  });

  it("sends shared approval prompts to a configured approval stream", async () => {
    const handler = createHandler({
      enabled: true,
      approvers: [123, 456],
      target: "stream",
      stream: "ops-approvals",
      topic: "exec-review",
    });

    await getInternals(handler).handleApprovalRequested(createRequest());

    expect(mockState.sendZulipComponentMessage).toHaveBeenCalledWith(
      "stream:ops-approvals:topic:exec-review",
      expect.any(String),
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ label: "Allow once", allowedUsers: [123, 456] }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );

    clearPendingTimeouts(handler);
  });

  it("falls back to text instructions when widgets are disabled", async () => {
    const handler = createHandler(
      { enabled: true, approvers: [123], target: "dm" },
      { widgetsEnabled: false },
    );

    await getInternals(handler).handleApprovalRequested(createRequest());

    expect(mockState.sendZulipComponentMessage).not.toHaveBeenCalled();
    expect(mockState.sendMessageZulip).toHaveBeenCalledWith(
      "dm:123",
      expect.stringContaining("Reply with: `/approve <id> allow-once|allow-always|deny`"),
      expect.objectContaining({ accountId: "default" }),
    );

    clearPendingTimeouts(handler);
  });

  it("resolves email approvers during start", async () => {
    mockState.fetchZulipUsers.mockResolvedValue([
      {
        user_id: 123,
        email: "owner@example.com",
        full_name: "Owner",
        is_bot: false,
      },
    ] satisfies ZulipUser[]);
    const handler = createHandler({
      enabled: true,
      approvers: ["owner@example.com"],
      target: "dm",
    });

    await handler.start();

    expect(handler.getApproverUserIds()).toEqual([123]);

    await handler.stop();
  });

  it("resolves approval callbacks through the gateway client for authorized users", async () => {
    const handler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    await handler.start();

    const result = await handler.handleCallback({
      callbackData: buildZulipExecApprovalCallbackData("approval-1", "allow-once"),
      senderId: 123,
    });

    expect(result satisfies ZulipExecApprovalCallbackResult).toEqual({
      handled: true,
      consume: true,
    });
    expect(mockState.gatewayClientRequests).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });

    await handler.stop();
  });

  it("persists pending approvals and reloads them on restart", async () => {
    const request = createRequest();
    const firstHandler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    await getInternals(firstHandler).handleApprovalRequested(request);
    clearPendingTimeouts(firstHandler);

    const persisted = JSON.parse(fs.readFileSync(pendingApprovalsPath(), "utf8")) as {
      approvals: Record<string, unknown>;
    };
    expect(Object.keys(persisted.approvals)).toContain(request.id);

    const secondHandler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    await secondHandler.start();

    expect(getInternals(secondHandler).pending.has(request.id)).toBe(true);

    await getInternals(secondHandler).handleApprovalResolved({
      id: request.id,
      decision: "allow-once",
      resolvedBy: "restart-test",
      ts: Date.now(),
    });

    expect(mockState.updateZulipMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ messageId: 42, content: expect.stringContaining("Allowed (once)") }),
    );
    expect(mockState.removeZulipComponentMessageEntries).toHaveBeenCalledWith({
      accountId: "default",
      messageId: 42,
    });
    expect(getInternals(secondHandler).pending.has(request.id)).toBe(false);

    await secondHandler.stop();
    clearPendingTimeouts(secondHandler);
  });

  it("expires persisted stale approvals on startup", async () => {
    const request = createRequest();
    fs.mkdirSync(path.dirname(pendingApprovalsPath()), { recursive: true });
    fs.writeFileSync(
      pendingApprovalsPath(),
      `${JSON.stringify(
        {
          version: 1,
          approvals: {
            [request.id]: {
              id: request.id,
              request: { ...request, expiresAtMs: Date.now() - 1_000 },
              messages: [{ messageId: 42, target: "dm:123" }],
              expiresAtMs: Date.now() - 1_000,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const handler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    await handler.start();

    expect(mockState.updateZulipMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ messageId: 42, content: expect.stringContaining("expired") }),
    );
    expect(mockState.removeZulipComponentMessageEntries).toHaveBeenCalledWith({
      accountId: "default",
      messageId: 42,
    });
    expect(getInternals(handler).pending.has(request.id)).toBe(false);

    await handler.stop();
  });

  it("rejects unauthorized approval callbacks without consuming the button", async () => {
    const handler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    await handler.start();

    const result = await handler.handleCallback({
      callbackData: buildZulipExecApprovalCallbackData("approval-1", "deny"),
      senderId: 999,
    });

    expect(result).toEqual({ handled: true, consume: false });
    expect(mockState.gatewayClientRequests).not.toHaveBeenCalled();

    await handler.stop();
  });

  it("finalizes approval messages on resolve", async () => {
    const handler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    const request = createRequest();
    await getInternals(handler).handleApprovalRequested(request);

    await getInternals(handler).handleApprovalResolved({
      id: request.id,
      decision: "allow-always",
      resolvedBy: "Zulip Exec Approvals",
      ts: Date.now(),
    });

    expect(mockState.updateZulipMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        messageId: 42,
        content: expect.stringContaining("Allowed (always)"),
      }),
    );
    expect(mockState.removeZulipComponentMessageEntries).toHaveBeenCalledWith({
      accountId: "default",
      messageId: 42,
    });
  });

  it("finalizes approval messages on timeout", async () => {
    const handler = createHandler({ enabled: true, approvers: [123], target: "dm" });
    const request = createRequest();
    await getInternals(handler).handleApprovalRequested(request);

    await getInternals(handler).handleApprovalTimeout(request.id);

    expect(mockState.updateZulipMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        messageId: 42,
        content: expect.stringContaining("expired"),
      }),
    );
    expect(mockState.removeZulipComponentMessageEntries).toHaveBeenCalledWith({
      accountId: "default",
      messageId: 42,
    });
  });

  it("filters requests to the configured Zulip account when turn-source account is present", () => {
    const handler = createHandler(
      { enabled: true, approvers: [123], target: "dm" },
      { accountId: "ops" },
    );
    const request = createRequest({
      turnSourceChannel: "zulip",
      turnSourceTo: "stream:ops:topic:deploy",
      turnSourceAccountId: "other",
    });

    expect(handler.shouldHandle(request)).toBe(false);
  });
});
