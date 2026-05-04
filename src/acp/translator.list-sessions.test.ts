import type { ListSessionsRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

/**
 * Regression coverage for the `session/list` JSON-RPC route across ACP
 * TypeScript SDK v0.16.0+ (see [Github #48279]).
 *
 * SDK v0.16.0 renamed `unstable_listSessions` to `listSessions`. The SDK
 * dispatcher routes `session/list` by looking up `listSessions` on the
 * agent handler, so an agent that only implements `unstable_listSessions`
 * silently produces `"Method not found": session/list` for every call
 * under SDK ≥ 0.16.0 (OpenClaw is pinned at `0.21.0`).
 *
 * These tests pin both the new canonical name and the legacy alias so a
 * future SDK rename, or an accidental drop of the alias before all
 * downstream callers migrate, fails in this file rather than silently in
 * production.
 */

type GatewayRequest = GatewayClient["request"];

function createListSessionsRequest(
  overrides: Partial<ListSessionsRequest> = {},
): ListSessionsRequest {
  return {
    cwd: "/tmp/openclaw-test",
    ...overrides,
  } as ListSessionsRequest;
}

function buildAgent(request: GatewayRequest): AcpGatewayAgent {
  const sessionStore = createInMemorySessionStore();
  return new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
}

function createGatewayStub(
  sessions: Array<{
    key: string;
    displayName?: string;
    label?: string;
    kind?: string;
    channel?: string;
    updatedAt?: number;
  }>,
): { request: GatewayRequest; calls: Parameters<GatewayRequest>[] } {
  const calls: Parameters<GatewayRequest>[] = [];
  const request = (async (...args: Parameters<GatewayRequest>) => {
    calls.push(args);
    if (args[0] === "sessions.list") {
      return { sessions };
    }
    return { ok: true };
  }) as GatewayRequest;
  return { request, calls };
}

describe("AcpGatewayAgent listSessions (#48279)", () => {
  it("exposes `listSessions` as a method (SDK v0.16+ dispatcher contract)", () => {
    // The SDK v0.16+ dispatcher routes `session/list` by looking up the
    // method name `listSessions` on the agent handler. If a future
    // refactor accidentally removes or renames the public method, this
    // assertion fails here rather than producing
    // `"Method not found": session/list` in production.
    const agent = buildAgent(createGatewayStub([]).request);
    expect(typeof (agent as unknown as { listSessions?: unknown }).listSessions).toBe("function");
  });

  it("preserves `unstable_listSessions` as a backward-compat alias", () => {
    // SDK versions `< 0.16.0` dispatched to `unstable_listSessions`. The
    // alias is intentionally kept so embedded consumers still on the
    // older SDK keep working without a parallel implementation drifting
    // out of sync.
    const agent = buildAgent(createGatewayStub([]).request);
    expect(
      typeof (agent as unknown as { unstable_listSessions?: unknown }).unstable_listSessions,
    ).toBe("function");
  });

  it("returns the gateway-supplied sessions mapped to ACP shape via the new name", async () => {
    const { request, calls } = createGatewayStub([
      {
        key: "agent:main:telegram:direct:user-1",
        displayName: "User One",
        kind: "direct",
        channel: "telegram",
        updatedAt: 1_700_000_000_000,
      },
      {
        key: "agent:main:slack:dm:user-2",
        label: "User Two",
        kind: "dm",
        channel: "slack",
      },
      {
        key: "agent:main:headless",
        kind: "headless",
      },
    ]);
    const agent = buildAgent(request);

    const response = await agent.listSessions(createListSessionsRequest());

    expect(calls).toEqual([["sessions.list", { limit: 100 }]]);
    expect(response.nextCursor).toBeNull();
    expect(response.sessions).toEqual([
      {
        sessionId: "agent:main:telegram:direct:user-1",
        cwd: "/tmp/openclaw-test",
        title: "User One",
        updatedAt: new Date(1_700_000_000_000).toISOString(),
        _meta: {
          sessionKey: "agent:main:telegram:direct:user-1",
          kind: "direct",
          channel: "telegram",
        },
      },
      {
        sessionId: "agent:main:slack:dm:user-2",
        cwd: "/tmp/openclaw-test",
        title: "User Two",
        updatedAt: undefined,
        _meta: {
          sessionKey: "agent:main:slack:dm:user-2",
          kind: "dm",
          channel: "slack",
        },
      },
      {
        // No displayName / label → falls back to the session key for the title.
        sessionId: "agent:main:headless",
        cwd: "/tmp/openclaw-test",
        title: "agent:main:headless",
        updatedAt: undefined,
        _meta: {
          sessionKey: "agent:main:headless",
          kind: "headless",
          channel: undefined,
        },
      },
    ]);
  });

  it("the alias and the canonical method return identical responses for the same input", async () => {
    const fixture = [
      {
        key: "agent:main:webchat",
        displayName: "Web",
        kind: "webchat",
        channel: "webchat",
        updatedAt: 1_710_000_000_000,
      },
    ];
    const stub1 = createGatewayStub(fixture);
    const agent1 = buildAgent(stub1.request);
    const viaCanonical = await agent1.listSessions(createListSessionsRequest());

    const stub2 = createGatewayStub(fixture);
    const agent2 = buildAgent(stub2.request);
    const viaAlias = await agent2.unstable_listSessions(createListSessionsRequest());

    expect(viaAlias).toEqual(viaCanonical);
    expect(stub1.calls).toEqual(stub2.calls);
  });

  it("honors a custom limit passed in `_meta.limit`", async () => {
    const { request, calls } = createGatewayStub([]);
    const agent = buildAgent(request);

    await agent.listSessions(
      createListSessionsRequest({
        _meta: { limit: 25 },
      } as Partial<ListSessionsRequest>),
    );

    expect(calls).toEqual([["sessions.list", { limit: 25 }]]);
  });

  it("defaults the limit to 100 when `_meta.limit` is missing", async () => {
    const { request, calls } = createGatewayStub([]);
    const agent = buildAgent(request);

    await agent.listSessions(createListSessionsRequest());

    expect(calls).toEqual([["sessions.list", { limit: 100 }]]);
  });

  it("falls back to `process.cwd()` when the request omits cwd", async () => {
    const { request } = createGatewayStub([{ key: "agent:main:webchat", kind: "webchat" }]);
    const agent = buildAgent(request);

    const response = await agent.listSessions({
      // SDK schema marks cwd as required, but defensive runtime callers
      // can omit it. The implementation uses `process.cwd()` as the
      // fallback so the response always has a cwd field.
    } as ListSessionsRequest);

    expect(response.sessions[0]?.cwd).toBe(process.cwd());
  });

  it("returns an empty session list with `nextCursor: null` when the gateway has no sessions", async () => {
    const { request } = createGatewayStub([]);
    const agent = buildAgent(request);

    const response = await agent.listSessions(createListSessionsRequest());

    expect(response).toEqual({ sessions: [], nextCursor: null });
  });
});
