import { describe, expect, it } from "vitest";
import { resolveMatrixSessionKey } from "./handler.js";

describe("resolveMatrixSessionKey", () => {
  it("keeps per-room session key when sessionScope is room", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      parentSessionKey: undefined,
    });
  });

  it("defaults to per-room session key when sessionScope is not set", () => {
    const resolved = resolveMatrixSessionKey({
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      parentSessionKey: undefined,
    });
  });

  it("uses shared agent matrix session when sessionScope is agent", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "Main-Agent",
        sessionKey: "agent:main-agent:matrix:channel:!room:example.org",
      },
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main-agent:matrix:main",
      parentSessionKey: undefined,
    });
  });

  it("creates thread-scoped session key for room thread messages", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
      threadRootId: "$ThreadRoot:Example.Org",
      isDirectMessage: false,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:channel:!room:example.org:thread:$threadroot:example.org",
      parentSessionKey: "agent:main:matrix:channel:!room:example.org",
    });
  });

  it("does not create thread session for direct messages", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:direct:@alice:example.org",
      },
      threadRootId: "$ThreadRoot:Example.Org",
      isDirectMessage: true,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:direct:@alice:example.org",
      parentSessionKey: undefined,
    });
  });
});
