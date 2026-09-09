import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import { browserControlAuthoritySignal } from "../browser/control-authority.js";
import { registerHumanInterventionGatewayMethods } from "./gateway.js";

type RegisteredHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type RegisteredHandlerParams = Parameters<RegisteredHandler>[0];

function setup(options: { enabled?: boolean } = {}) {
  const handlers = new Map<string, RegisteredHandler>();
  const scopes = new Map<string, string>();
  const api = createTestPluginApi({
    registerGatewayMethod(method, handler, registrationOptions) {
      handlers.set(method, handler);
      scopes.set(method, registrationOptions?.scope ?? "");
    },
  });
  const record = {
    id: "handoff-1",
    state: "control",
    generation: 2,
    reason: "Human verification required",
    hostname: "example.com",
    expiresAtMs: 10_000,
    browser: { target: "host", profile: "openclaw", targetId: "tab-1" },
  };
  const authoritySignal = new AbortController().signal;
  const coordinator = {
    get: vi.fn(async () => record),
    claim: vi.fn(async (_input: unknown, _assertCurrentAuthority?: () => void) => record),
    renew: vi.fn(async (_input: unknown, _assertCurrentAuthority?: () => void) => record),
    runBrowserOperation: vi.fn(
      async (
        _input: unknown,
        operation: (value: typeof record, signal: AbortSignal) => Promise<unknown>,
      ) => await operation(record, authoritySignal),
    ),
    leave: vi.fn(async (_input: unknown, _assertCurrentAuthority?: () => void) => ({
      ...record,
      state: "waiting",
      generation: 3,
    })),
    complete: vi.fn(async (_input: unknown, _assertCurrentAuthority?: () => void) => ({
      ...record,
      state: "resumed",
      generation: 3,
    })),
    cancel: vi.fn(async (_id: string, _assertCurrentAuthority?: () => void) => ({
      ...record,
      state: "cancelled",
      generation: 3,
    })),
  };
  const forwardBrowserRequest = vi.fn(async ({ respond }: RegisteredHandlerParams) => {
    respond(true, { ok: true, wsPath: "/browser/screencast?token=one" });
  });
  registerHumanInterventionGatewayMethods({
    api,
    coordinator: coordinator as never,
    forwardBrowserRequest: forwardBrowserRequest as never,
    isEnabled: () => options.enabled !== false,
  });
  return { handlers, scopes, coordinator, forwardBrowserRequest, authoritySignal };
}

async function call(
  handler: RegisteredHandler | undefined,
  params: Record<string, unknown>,
  hasCurrentClientAuthority: () => boolean = () => true,
): Promise<{ ok: boolean; payload: unknown; error: unknown }> {
  if (!handler) {
    throw new Error("handler not registered");
  }
  let response = { ok: false, payload: undefined as unknown, error: undefined as unknown };
  await handler({
    req: { type: "req", id: "test-request", method: "browser.handoff.test", params },
    params,
    respond(ok, payload, error) {
      response = { ok, payload, error };
    },
    context: {} as never,
    client: {} as never,
    isWebchatConnect: () => false,
    hasCurrentClientAuthority,
  });
  return response;
}

describe("human intervention gateway", () => {
  it("rejects stale handoff links after the feature is disabled", async () => {
    const { handlers, coordinator } = setup({ enabled: false });

    const response = await call(handlers.get("browser.handoff.get"), { id: "handoff-1" });

    expect(response.ok).toBe(false);
    expect(coordinator.get).not.toHaveBeenCalled();
  });

  it("requires administrator authority for observation and control", () => {
    const { scopes } = setup();
    expect(scopes.get("browser.handoff.get")).toBe("operator.admin");
    for (const method of [
      "browser.handoff.claim",
      "browser.handoff.renew",
      "browser.handoff.leave",
      "browser.handoff.complete",
      "browser.handoff.cancel",
      "browser.handoff.browser",
    ]) {
      expect(scopes.get(method)).toBe("operator.admin");
    }
  });

  it("rechecks feature enablement at the durable mutation boundary", async () => {
    const options = { enabled: true };
    const { handlers, coordinator } = setup(options);
    coordinator.claim.mockImplementationOnce(async (_input, guard) => {
      options.enabled = false;
      guard?.();
      throw new Error("mutation reached after disablement");
    });
    const response = await call(handlers.get("browser.handoff.claim"), {
      id: "handoff-1",
      controllerId: "phone-a",
    });
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ message: "Human browser intervention is disabled" });
  });

  it("does not disclose a status read after client authority is revoked", async () => {
    const { handlers } = setup();
    let checks = 0;
    const response = await call(
      handlers.get("browser.handoff.get"),
      { id: "handoff-1" },
      () => ++checks === 1,
    );
    expect(response.ok).toBe(false);
    expect(response.payload).toBeUndefined();
  });

  it("redacts session and owner identity from status responses", async () => {
    const { handlers } = setup();
    const response = await call(handlers.get("browser.handoff.get"), { id: "handoff-1" });
    expect(response).toMatchObject({
      ok: true,
      payload: {
        handoff: {
          id: "handoff-1",
          state: "control",
          browser: { targetId: "tab-1" },
        },
      },
    });
    expect(response.payload).not.toHaveProperty("handoff.sessionKey");
    expect(response.payload).not.toHaveProperty("handoff.owner");
  });

  it("rechecks current Gateway authority at the durable mutation boundary", async () => {
    const { handlers, coordinator } = setup();
    coordinator.claim.mockImplementationOnce(async (_input, assertCurrentAuthority) => {
      if (!assertCurrentAuthority) {
        throw new Error("authority guard is required");
      }
      assertCurrentAuthority();
      return {
        id: "handoff-1",
        state: "control",
        generation: 2,
        reason: "Human verification required",
        hostname: "example.com",
        expiresAtMs: 10_000,
        browser: { target: "host", profile: "openclaw", targetId: "tab-1" },
      };
    });
    let authorityChecks = 0;

    const response = await call(
      handlers.get("browser.handoff.claim"),
      { id: "handoff-1", controllerId: "phone-a" },
      () => ++authorityChecks === 1,
    );

    expect(response.ok).toBe(false);
    expect(authorityChecks).toBe(2);
  });

  it("authorizes current control before forwarding a scoped screencast request", async () => {
    const { handlers, coordinator, forwardBrowserRequest, authoritySignal } = setup();
    const response = await call(handlers.get("browser.handoff.browser"), {
      id: "handoff-1",
      controllerId: "phone-a",
      generation: 2,
      operation: "screencast",
      maxWidth: 800,
      maxHeight: 1200,
    });
    expect(response.ok).toBe(true);
    expect(coordinator.runBrowserOperation).toHaveBeenCalledWith(
      { id: "handoff-1", controllerId: "phone-a", generation: 2 },
      expect.any(Function),
    );
    expect(forwardBrowserRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          target: "host",
          method: "POST",
          path: "/screencast",
          query: { profile: "openclaw" },
          body: {
            targetId: "tab-1",
            maxWidth: 800,
            maxHeight: 1200,
            [browserControlAuthoritySignal]: authoritySignal,
          },
        },
      }),
    );
  });

  it("rejects browser actions outside the human-input allowlist", async () => {
    const { handlers, forwardBrowserRequest } = setup();
    const response = await call(handlers.get("browser.handoff.browser"), {
      id: "handoff-1",
      controllerId: "phone-a",
      generation: 2,
      operation: "act",
      action: { kind: "evaluate", fn: "document.cookie" },
    });
    expect(response.ok).toBe(false);
    expect(forwardBrowserRequest).not.toHaveBeenCalled();
  });

  it("allows a coordinate drag only on the handoff-bound tab and authority lease", async () => {
    const { handlers, forwardBrowserRequest, authoritySignal } = setup();
    const response = await call(handlers.get("browser.handoff.browser"), {
      id: "handoff-1",
      controllerId: "phone-a",
      generation: 2,
      operation: "act",
      action: { kind: "dragCoords", x: 12, y: 24, endX: 120, endY: 240, targetId: "other" },
    });
    expect(response.ok).toBe(true);
    expect(forwardBrowserRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/act",
          body: {
            kind: "dragCoords",
            targetId: "tab-1",
            x: 12,
            y: 24,
            endX: 120,
            endY: 240,
            [browserControlAuthoritySignal]: authoritySignal,
          },
        }),
      }),
    );
  });
});
