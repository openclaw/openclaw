import { webcrypto } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import type { AccessRequest, AgenticAutofillExtension } from "./autofill-contract.js";
import { decodeConnectionPath } from "./autofill-input.js";
import { AutofillError } from "./autofill-relay.js";
import {
  AutofillService,
  type AutofillConnection,
  type AutofillRequest,
} from "./autofill-service.js";
import { createAutofillTool } from "./autofill-tool.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";

const inlineView: OpenClawPluginApi["inlineView"] = (viewId, payload, options) => ({
  content: [{ type: "text", text: options.summary }],
  details: { pluginInlineView: { pluginId: "onepassword", viewId, payload, ...options } },
});

const key =
  "ops_" +
  Buffer.from(
    JSON.stringify({
      ver: 1,
      typ: "oauth_integration_key",
      key: "ab".repeat(32),
      path: "//api.1password.com/oauth-clients/client/accounts/account/users/user",
    }),
  ).toString("base64url");
const path = decodeConnectionPath(key).path;
const input = {
  version: 2 as const,
  goal: "Download an invoice",
  entries: [
    {
      type: "login" as const,
      parameters: { website: "https://example.com" },
      reason: "Download the invoice",
      keywords: ["work"],
    },
  ],
};
const request: AccessRequest = {
  ...input,
  id: "request",
  path: "accounts/account/credential-broker-access-requests/request",
  identity: "identity",
  state: "pending",
  createdAt: "2026-11-02T23:00:00Z",
  entries: [{ ...input.entries[0]!, id: "entry" }],
};
const tokens = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_in: 900,
  scope: "brokered-credentials:read",
  user_id: "user",
};
const authority = { assertCurrent: vi.fn() };

afterEach(() => vi.restoreAllMocks());

function setup() {
  let now = 0;
  let enabled = true;
  let sessionSequence = 0;
  let sleepHook: (() => Promise<void>) | undefined;
  const delays: number[] = [];
  const connections = new MemoryKeyedStore<AutofillConnection>(() => now);
  const requests = new MemoryKeyedStore<AutofillRequest>(() => now);
  const relay = {
    create: vi.fn(async () => {
      const sessionId = String(++sessionSequence).padStart(22, "s");
      return {
        sessionId,
        connectUrl: "https://connect.openclaw.ai/1password/start/" + sessionId,
        confirmationCode: "ABCD-1234",
        pickupToken: "private-pickup",
        expiresAt: new Date(now + 600_000).toISOString(),
        privateKey: (
          await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
            "deriveBits",
          ])
        ).privateKey,
      };
    }),
    pickup: vi.fn(async () => ({
      state: "connected" as const,
      tokens,
      integrationKey: key as string | null,
    })),
    refresh: vi.fn(async () => ({
      ...tokens,
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
    })),
    revoke: vi.fn(async () => {}),
  };
  const extension = {
    createAccessRequest: vi.fn<AgenticAutofillExtension["createAccessRequest"]>(async () => ({
      success: true,
      result: { accessRequest: request, appLink: "onepassword://synthetic-private-link" },
    })),
    getAccessRequestStatus: vi.fn<AgenticAutofillExtension["getAccessRequestStatus"]>(async () => ({
      success: true,
      result: {
        path: "status",
        state: "resolved",
        resolved: [{ entryId: "entry", reference: "synthetic-private-reference" }],
      },
    })),
    fillCredential: vi.fn<AgenticAutofillExtension["fillCredential"]>(async () => ({
      success: true,
      result: { status: "fill_submitted" },
    })),
  };
  const service = new AutofillService({
    stores: { connections, requests },
    relay,
    extension,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
        const hook = sleepHook;
        sleepHook = undefined;
        await hook?.();
      },
    },
    assertEnabled() {
      if (!enabled) {
        throw new AutofillError("autofillDisabled");
      }
    },
  });
  const connect = async () => {
    const session = await service.connect(authority);
    expect(session).not.toHaveProperty("pickupToken");
    await service.pickup(session.sessionId, authority);
  };
  return {
    service,
    connections,
    requests,
    relay,
    extension,
    connect,
    delays,
    advance(ms: number) {
      now += ms;
    },
    disable() {
      enabled = false;
    },
    onSleep(hook: () => Promise<void>) {
      sleepHook = hook;
    },
  };
}

it("keeps tokens, keys, links and references outside tool results through connect, approve and fill", async () => {
  const s = setup();
  const tool = createAutofillTool(
    s.service,
    {
      senderIsOwner: true,
      sessionKey: "chat",
      sessionId: "conversation",
      assertInvocationCurrent() {},
    },
    inlineView,
  );
  const execute = async (params: unknown) => JSON.stringify(await tool.execute("call", params));
  const start = JSON.parse(await execute({ action: "connect" })) as {
    details: { sessionId: string };
  };
  const outputs = [
    await execute({ action: "connect", sessionId: start.details.sessionId }),
    await execute({ action: "request_logins", requests: input }),
  ];
  expect(JSON.parse(outputs[1]!).details.pluginInlineView.payload).toEqual({
    requestId: "request",
  });
  expect(outputs[1]).not.toContain("appLink");
  outputs.push(await execute({ action: "check_status", requestId: "request" }));
  expect(s.extension.getAccessRequestStatus).not.toHaveBeenCalled();
  outputs.push(
    await execute({ action: "check_status", requestId: "request", approvalOpened: true }),
  );
  expect(s.delays).toEqual([5000]);
  outputs.push(
    await execute({ action: "check_status", requestId: "request", approvalOpened: true }),
  );
  expect(s.extension.getAccessRequestStatus).toHaveBeenCalledTimes(1);
  outputs.push(
    await execute({
      action: "fill",
      requestId: "request",
      entryId: "entry",
      tab: { targetId: "tab" },
    }),
  );
  expect(s.extension.fillCredential).toHaveBeenCalledWith({
    accessToken: tokens.access_token,
    integrationKey: key,
    resourcePath: "synthetic-private-reference",
    tab: { targetId: "tab" },
  });
  for (const secret of [
    tokens.access_token,
    tokens.refresh_token,
    key,
    "private-pickup",
    "onepassword://synthetic-private-link",
    "synthetic-private-reference",
  ]) {
    expect(outputs.join("\n")).not.toContain(secret);
  }
  expect(outputs.at(-1)).toContain("fill_submitted");
});

it("serializes refresh once and atomically retains the rotated token across a failed local publication", async () => {
  const s = setup();
  await s.connect();
  s.advance(850_000);
  const register = s.connections.register.bind(s.connections);
  vi.spyOn(s.connections, "register").mockRejectedValueOnce(new Error("synthetic storage failure"));
  await expect(s.service.requestLogins(input, "chat", authority)).rejects.toThrow(
    "synthetic storage failure",
  );
  expect(s.relay.refresh).toHaveBeenCalledTimes(1);
  s.connections.register = register;
  await Promise.all([
    s.service.requestLogins(input, "chat", authority),
    s.service.requestLogins(input, "chat", authority),
  ]);
  expect(s.relay.refresh).toHaveBeenCalledTimes(1);
  expect(await s.connections.lookup(path)).toMatchObject({
    refreshToken: "rotated-refresh",
    integrationKey: key,
  });
});

it("preserves the original key on null pickup and revokes when there is no uniquely matched key", async () => {
  const s = setup();
  await s.connect();
  s.relay.pickup.mockResolvedValue({ state: "connected", tokens, integrationKey: null });
  await s.connect();
  expect((await s.connections.lookup(path))?.integrationKey).toBe(key);
  await s.service.disconnect(authority);
  expect(await s.connections.entries()).toEqual([]);
  const session = await s.service.connect(authority);
  await expect(s.service.pickup(session.sessionId, authority)).rejects.toMatchObject({
    code: "integrationKeyMissingReconnect",
  });
  expect(s.relay.revoke).toHaveBeenCalledTimes(2);
});

it("clears grants on invalid_grant but preserves all state when revocation fails", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  s.relay.revoke.mockRejectedValueOnce(new AutofillError("revokeFailed"));
  await expect(s.service.disconnect(authority)).rejects.toMatchObject({ code: "revokeFailed" });
  expect(await s.connections.entries()).toHaveLength(1);
  expect(await s.requests.entries()).toHaveLength(1);
  s.advance(850_000);
  s.relay.refresh.mockRejectedValueOnce(new AutofillError("reconnectRequired"));
  await expect(s.service.disconnect(authority)).rejects.toMatchObject({
    code: "reconnectRequired",
  });
  expect(await s.connections.entries()).toEqual([]);
  expect(await s.requests.entries()).toEqual([]);
});

it("rejects nonowners, changed policy, unknown grants and cross-conversation requests before effects", async () => {
  const s = setup();
  await s.connect();
  const tool = createAutofillTool(
    s.service,
    {
      senderIsOwner: false,
      sessionKey: "chat",
      sessionId: "conversation",
      assertInvocationCurrent() {},
    },
    inlineView,
  );
  expect(
    (await tool.execute("call", { action: "request_logins", requests: input })).details,
  ).toMatchObject({ code: "gatewayOwnerRequired" });
  await s.service.requestLogins(input, "chat", authority);
  await expect(
    s.service.checkStatus("request", "other-chat", true, authority),
  ).rejects.toMatchObject({ code: "requestNotFound" });
  await expect(
    s.service.fill("request", "entry", { targetId: "tab" }, "chat", authority),
  ).rejects.toMatchObject({ code: "loginNotGranted" });
  s.disable();
  await expect(s.service.requestLogins(input, "chat", authority)).rejects.toMatchObject({
    code: "autofillDisabled",
  });
  expect(s.extension.fillCredential).not.toHaveBeenCalled();
});

it("stops on unknown final states, coalesces checkers, backs off rate limits and bounds the pending window", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  s.extension.getAccessRequestStatus.mockResolvedValue({
    success: true,
    result: { path: "status", state: "pending", resolved: [] },
  });
  s.extension.getAccessRequestStatus.mockResolvedValueOnce({
    success: false,
    error: { code: "rateLimitExceeded" },
  });
  const results = await Promise.all([
    s.service.checkStatus("request", "chat", true, authority),
    s.service.checkStatus("request", "chat", true, authority),
  ]);
  expect(results.some((result) => result.guidance.includes("already running"))).toBe(true);
  expect(s.delays.slice(0, 3)).toEqual([5000, 60000, 10000]);
  expect(s.delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(120000);
  s.advance(2000);
  s.extension.getAccessRequestStatus.mockResolvedValue({
    success: true,
    result: { path: "status", state: "futureFinalState", resolved: [] },
  });
  expect(await s.service.checkStatus("request", "chat", true, authority)).toMatchObject({
    state: "futureFinalState",
  });
  const count = s.extension.getAccessRequestStatus.mock.calls.length;
  await s.service.checkStatus("request", "chat", true, authority);
  expect(s.extension.getAccessRequestStatus).toHaveBeenCalledTimes(count);
});

it("retains one-use pickup and refresh responses when the initiating authority closes", async () => {
  const s = setup();
  let current = true;
  const changing = {
    assertCurrent() {
      if (!current) {
        throw new Error("synthetic closed invocation");
      }
    },
  };
  const session = await s.service.connect(changing);
  s.relay.pickup.mockImplementationOnce(async () => {
    current = false;
    return { state: "connected", tokens, integrationKey: key };
  });
  await expect(s.service.pickup(session.sessionId, changing)).rejects.toThrow("closed invocation");
  current = true;
  await s.service.pickup(session.sessionId, changing);
  expect(s.relay.pickup).toHaveBeenCalledTimes(1);
  s.advance(850_000);
  s.relay.refresh.mockImplementationOnce(async () => {
    current = false;
    return { ...tokens, access_token: "rotated-access", refresh_token: "rotated-refresh" };
  });
  await expect(s.service.requestLogins(input, "chat", changing)).rejects.toThrow(
    "closed invocation",
  );
  current = true;
  await s.service.requestLogins(input, "chat", changing);
  expect(s.relay.refresh).toHaveBeenCalledTimes(1);
  expect((await s.connections.lookup(path))?.refreshToken).toBe("rotated-refresh");
});

it("retains final statuses before fallible local writes and never rechecks them", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  vi.spyOn(s.connections, "register").mockRejectedValueOnce(
    new Error("synthetic cooldown write failure"),
  );
  await expect(s.service.checkStatus("request", "chat", true, authority)).rejects.toThrow(
    "cooldown write failure",
  );
  expect(await s.service.checkStatus("request", "chat", true, authority)).toMatchObject({
    state: "resolved",
  });
  expect(s.extension.getAccessRequestStatus).toHaveBeenCalledTimes(1);
  expect((await s.requests.lookup("request"))?.status.state).toBe("resolved");
});

it("disconnect cancels consent attempts even without stored credentials and refuses late pickup", async () => {
  const s = setup();
  const first = await s.service.connect(authority);
  expect(await s.service.disconnect(authority)).toMatchObject({ state: "disconnected" });
  await expect(s.service.pickup(first.sessionId, authority)).rejects.toMatchObject({
    code: "connectExpired",
  });
  expect(s.relay.pickup).not.toHaveBeenCalled();
  await s.connect();
  const pending = await s.service.connect(authority);
  await s.service.disconnect(authority);
  await expect(s.service.pickup(pending.sessionId, authority)).rejects.toMatchObject({
    code: "connectExpired",
  });
  expect(await s.connections.entries()).toEqual([]);
});

it.each([
  { ...input, goal: "x".repeat(141) },
  { ...input, entries: Array.from({ length: 6 }, () => input.entries[0]!) },
  { ...input, entries: [{ ...input.entries[0]!, reason: "x".repeat(101) }] },
  { ...input, entries: [{ ...input.entries[0]!, parameters: { website: "http://example.com" } }] },
  { ...input, entries: [{ ...input.entries[0]!, keywords: ["x".repeat(51)] }] },
])(
  "rejects out-of-contract request text and websites before reading credentials",
  async (invalid) => {
    const s = setup();
    await expect(s.service.requestLogins(invalid, "chat", authority)).rejects.toMatchObject({
      code: "invalidRequest",
    });
    expect(s.extension.createAccessRequest).not.toHaveBeenCalled();
  },
);

it("uses a conservative expiry for delayed pickup and refreshes expired canceled pickups before revoke", async () => {
  const s = setup();
  const session = await s.service.connect(authority);
  s.advance(500_000);
  await s.service.pickup(session.sessionId, authority);
  expect((await s.connections.lookup(path))?.expiresAt).toBe(900_000);
  s.advance(350_000);
  await s.service.requestLogins(input, "chat", authority);
  expect(s.relay.refresh).toHaveBeenCalledTimes(1);
  await s.service.disconnect(authority);
  const pending = await s.service.connect(authority);
  let current = true;
  const changing = {
    assertCurrent() {
      if (!current) {
        throw new Error("synthetic closed invocation");
      }
    },
  };
  s.relay.pickup.mockImplementationOnce(async () => {
    current = false;
    return { state: "connected", tokens, integrationKey: key };
  });
  await expect(s.service.pickup(pending.sessionId, changing)).rejects.toThrow("closed invocation");
  s.advance(850_000);
  current = true;
  await s.service.disconnect(changing);
  expect(s.relay.refresh).toHaveBeenCalledTimes(2);
  expect(s.relay.revoke).toHaveBeenLastCalledWith("rotated-access", undefined);
});

it("keeps completed pickup recovery across relay expiry, including when a new connect prunes pending sessions", async () => {
  const s = setup();
  for (const recover of [true, false]) {
    const session = await s.service.connect(authority);
    const interrupted = { assertCurrent: vi.fn() };
    s.relay.pickup.mockImplementationOnce(async () => {
      interrupted.assertCurrent.mockImplementation(() => {
        throw new Error("synthetic closed invocation");
      });
      return { state: "connected", tokens, integrationKey: key };
    });
    await expect(s.service.pickup(session.sessionId, interrupted)).rejects.toThrow(
      "closed invocation",
    );
    s.advance(600_001);
    await s.service.connect(authority);
    if (recover) {
      expect(await s.service.pickup(session.sessionId, authority)).toMatchObject({
        state: "connected",
      });
    }
    await s.service.disconnect(authority);
  }
  expect(s.relay.pickup).toHaveBeenCalledTimes(2);
  expect(s.relay.revoke).toHaveBeenCalledTimes(2);
});

it("does not resurrect a request after disconnect and reconnect during its polling wait", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  s.onSleep(async () => {
    await s.service.disconnect(authority);
    await s.connect();
  });
  await expect(s.service.checkStatus("request", "chat", true, authority)).rejects.toMatchObject({
    code: "requestNotFound",
  });
  expect(s.extension.getAccessRequestStatus).not.toHaveBeenCalled();
  expect(await s.requests.entries()).toEqual([]);
});

it("refuses references from a retired keyset if cleanup was interrupted before deleting requests", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  await s.service.checkStatus("request", "chat", true, authority);
  vi.spyOn(s.requests, "delete").mockRejectedValueOnce(new Error("synthetic interrupted cleanup"));
  await expect(s.service.disconnect(authority)).rejects.toThrow("interrupted cleanup");
  const replacement =
    "ops_" +
    Buffer.from(
      JSON.stringify({ ver: 1, typ: "oauth_integration_key", key: "cd".repeat(32), path }),
    ).toString("base64url");
  s.relay.pickup.mockResolvedValue({ state: "connected", tokens, integrationKey: replacement });
  await s.connect();
  await expect(
    s.service.fill("request", "entry", { targetId: "tab" }, "chat", authority),
  ).rejects.toMatchObject({ code: "requestNotFound" });
  expect(s.extension.fillCredential).not.toHaveBeenCalled();
});

it("settles multiple canceled consent responses when the first revocation ends the others", async () => {
  const s = setup();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await s.service.connect(authority);
    const interrupted = { assertCurrent: vi.fn() };
    s.relay.pickup.mockImplementationOnce(async () => {
      interrupted.assertCurrent.mockImplementation(() => {
        throw new Error("synthetic closed invocation");
      });
      return { state: "connected", tokens, integrationKey: key };
    });
    await expect(s.service.pickup(session.sessionId, interrupted)).rejects.toThrow(
      "closed invocation",
    );
  }
  s.relay.refresh.mockResolvedValueOnce({
    ...tokens,
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
  });
  s.relay.refresh.mockRejectedValueOnce(new AutofillError("reconnectRequired"));
  expect(await s.service.disconnect(authority)).toMatchObject({ state: "disconnected" });
  expect(s.relay.revoke).toHaveBeenCalledTimes(1);
});

it("finishes interrupted grant cleanup on a later disconnect without repeating revocation", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  vi.spyOn(s.requests, "delete").mockRejectedValueOnce(new Error("synthetic interrupted cleanup"));
  await expect(s.service.disconnect(authority)).rejects.toThrow("interrupted cleanup");
  expect(await s.connections.entries()).toEqual([]);
  expect(await s.service.disconnect(authority)).toMatchObject({ state: "disconnected" });
  expect(await s.requests.entries()).toEqual([]);
  expect(s.relay.revoke).toHaveBeenCalledTimes(1);
});

it("does not recreate a request from an initial lookup that completed after disconnect", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  const lookup = s.requests.lookup.bind(s.requests);
  vi.spyOn(s.requests, "lookup").mockImplementationOnce(async (id) => {
    const stale = await lookup(id);
    await s.service.disconnect(authority);
    return stale;
  });
  await expect(s.service.checkStatus("request", "chat", true, authority)).rejects.toMatchObject({
    code: "requestNotFound",
  });
  expect(await s.requests.entries()).toEqual([]);
  expect(s.extension.getAccessRequestStatus).not.toHaveBeenCalled();
});

it("does not overwrite a final state with a stale initiating lookup or poll it again", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  const lookup = s.requests.lookup.bind(s.requests);
  vi.spyOn(s.requests, "lookup").mockImplementationOnce(async (id) => {
    const stale = await lookup(id);
    await s.service.checkStatus("request", "chat", true, authority);
    return stale;
  });
  expect(await s.service.checkStatus("request", "chat", true, authority)).toMatchObject({
    state: "resolved",
  });
  expect(s.extension.getAccessRequestStatus).toHaveBeenCalledTimes(1);
  expect((await s.requests.lookup("request"))?.status.state).toBe("resolved");
});

it("hydrates a private link without polling, rejects other sessions, and expires it without storage", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  expect(await s.service.approval("request", "chat", authority)).toEqual({
    state: "pending",
    appLink: "onepassword://synthetic-private-link",
    expiresAt: 600_000,
    goal: "Download an invoice",
    entries: [{ domain: "example.com", reason: "Download the invoice", granted: false }],
  });
  expect(s.extension.getAccessRequestStatus).not.toHaveBeenCalled();
  expect(JSON.stringify(await s.requests.entries())).not.toContain("onepassword://");
  await expect(s.service.approval("request", "other-chat", authority)).rejects.toMatchObject({
    code: "requestNotFound",
  });
  s.advance(600_000);
  expect(await s.service.approval("request", "chat", authority)).toMatchObject({
    state: "unavailable",
  });
});

it("invalidates private views on reload, connection replacement, and authority loss", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  s.service.clearApprovalLinks();
  expect(await s.service.approval("request", "chat", authority)).toMatchObject({
    state: "unavailable",
  });
  await s.service.requestLogins(input, "chat", authority);
  await expect(
    s.service.approval("request", "chat", {
      assertCurrent() {
        throw new AutofillError("requesterChanged");
      },
    }),
  ).rejects.toMatchObject({ code: "requesterChanged" });
  await s.connections.delete(path);
  await expect(s.service.approval("request", "chat", authority)).rejects.toMatchObject({
    code: "requestNotFound",
  });
});

it("records the actual click before polling starts and schedules from that moment", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  s.advance(1000);
  await s.service.noteApprovalOpened("request", "chat", authority);
  expect((await s.requests.lookup("request"))?.openedAt).toBe(1000);
  expect(await s.service.approval("request", "chat", authority)).toMatchObject({
    appLink: "onepassword://synthetic-private-link",
    openedAt: 1000,
    deadline: 121_000,
  });
  expect((await s.service.checkStatus("request", "chat", false, authority)).guidance).toContain(
    "was opened",
  );
  expect(s.extension.getAccessRequestStatus).not.toHaveBeenCalled();
  s.advance(2000);
  await s.service.checkStatus("request", "chat", true, authority);
  expect(s.delays).toEqual([3000]);
  expect(await s.service.approval("request", "chat", authority)).toMatchObject({
    state: "resolved",
    entries: [{ domain: "example.com", granted: true }],
  });
});

it("makes a failed background checker unavailable instead of showing indefinite pending", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  await s.service.noteApprovalOpened("request", "chat", authority);
  s.service.forgetApprovalLink("request");
  expect(await s.service.approval("request", "chat", authority)).toMatchObject({
    state: "unavailable",
  });
});

it("keeps the real approval window open through its final check and joins that result without another checker", async () => {
  const s = setup();
  await s.connect();
  await s.service.requestLogins(input, "chat", authority);
  const boundary = Promise.withResolvers<void>();
  const final =
    Promise.withResolvers<
      Awaited<ReturnType<AgenticAutofillExtension["getAccessRequestStatus"]>>
    >();
  s.extension.getAccessRequestStatus.mockImplementation(async () => {
    if (s.delays.reduce((sum, delay) => sum + delay, 0) === 120_000) {
      boundary.resolve();
      return final.promise;
    }
    expect(await s.service.approval("request", "chat", authority)).toMatchObject({
      state: "pending",
      deadline: 120_000,
    });
    return { success: true, result: { path: "status", state: "pending", resolved: [] } };
  });
  const checker = s.service.checkStatus("request", "chat", true, authority);
  // Settle the signal even on the old early-exhaustion bug, so the regression fails
  // on the schedule assertion rather than hanging on a fabricated final response.
  void checker.then(() => boundary.resolve());
  await boundary.promise;
  const view = s.service.approval("request", "chat", authority);
  try {
    expect(s.delays.reduce((sum, delay) => sum + delay, 0)).toBe(120_000);
    expect(s.extension.getAccessRequestStatus).toHaveBeenCalledTimes(26);
  } finally {
    final.resolve({
      success: true,
      result: {
        path: "status",
        state: "resolved",
        resolved: [{ entryId: "entry", reference: "synthetic-final-reference" }],
      },
    });
  }
  await checker;
  expect(await view).toMatchObject({ state: "resolved", entries: [{ granted: true }] });
  expect(s.extension.getAccessRequestStatus).toHaveBeenCalledTimes(26);
});
