import { describe, expect, it } from "vitest";
import { contextTypeFromSessionKey, scopeFromSessionKey } from "./scope.js";

describe("scopeFromSessionKey", () => {
  it("classifies the canonical owner-DM key", () => {
    expect(scopeFromSessionKey("agent:main:main")).toBe("owner_dm");
  });

  it("classifies public visitor sessions by prefix", () => {
    expect(scopeFromSessionKey("agent:main:public:visitor-abc")).toBe("public_dm");
  });

  it("classifies group sessions when key contains :group:", () => {
    expect(scopeFromSessionKey("agent:main:whatsapp:group:1234@g.us")).toBe("group");
  });

  it("classifies contact-DM sessions for both :dm: and :direct: markers", () => {
    expect(scopeFromSessionKey("agent:main:telegram:dm:user-123")).toBe("contact_dm");
    expect(scopeFromSessionKey("agent:main:slack:direct:user-456")).toBe("contact_dm");
  });

  it("returns 'unknown' for empty / null input (fail-closed)", () => {
    expect(scopeFromSessionKey(undefined)).toBe("unknown");
    expect(scopeFromSessionKey(null)).toBe("unknown");
    expect(scopeFromSessionKey("")).toBe("unknown");
  });

  it("returns 'unknown' for keys that don't match any rule", () => {
    expect(scopeFromSessionKey("foo")).toBe("unknown");
    expect(scopeFromSessionKey("agent:main:misc:weird")).toBe("unknown");
  });

  // Group classification must take priority over the generic :dm: marker so a
  // hypothetical "...:group:dm:..." key doesn't get mis-scoped — guards against
  // a foot-gun if a channel ever encodes dm-in-group routing.
  it("prefers group over dm/direct markers when both appear", () => {
    expect(scopeFromSessionKey("agent:main:foo:group:bar:dm:baz")).toBe("group");
  });
});

describe("contextTypeFromSessionKey", () => {
  it("returns group only for group-scoped session keys", () => {
    expect(contextTypeFromSessionKey("agent:main:whatsapp:group:1@g")).toBe("group");
  });

  it("returns dm for owner_dm, contact_dm, public_dm, and unknown", () => {
    expect(contextTypeFromSessionKey("agent:main:main")).toBe("dm");
    expect(contextTypeFromSessionKey("agent:main:telegram:dm:u")).toBe("dm");
    expect(contextTypeFromSessionKey("agent:main:public:v")).toBe("dm");
    expect(contextTypeFromSessionKey(undefined)).toBe("dm");
  });
});
