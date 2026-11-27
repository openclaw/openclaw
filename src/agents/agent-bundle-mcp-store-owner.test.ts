import { describe, expect, it } from "vitest";
import {
  bindSessionMcpStoreOwner,
  inheritSessionMcpStoreOwner,
  readSessionMcpStoreOwner,
} from "../config/sessions/session-mcp-store-admission.js";
import { createSessionMcpStoreClaims } from "./agent-bundle-mcp-store-owner.js";

const target = { agentId: "agent", sessionId: "id", sessionKey: "agent:agent:key" };
const source = { agentId: target.agentId, databaseIdentity: "physical", databaseBirthtime: "1" };

function setup() {
  const admission = {};
  bindSessionMcpStoreOwner(admission, { ...source, ...target });
  const key = readSessionMcpStoreOwner(admission, target)!;
  return { admission, claims: createSessionMcpStoreClaims(2), key };
}

describe("MCP session store admission", () => {
  it("accepts the bound capability only for its committed session and agent", () => {
    const { admission, key } = setup();
    const host = {};
    inheritSessionMcpStoreOwner(admission, host);
    expect(readSessionMcpStoreOwner(host, target)).toBe(key);
    expect(readSessionMcpStoreOwner(host, { ...target, sessionId: "other" })).toBeUndefined();
    expect(readSessionMcpStoreOwner(host, { ...target, agentId: "other" })).toBeUndefined();
    expect(readSessionMcpStoreOwner({}, target)).toBeUndefined();
    inheritSessionMcpStoreOwner(undefined, host);
    expect(readSessionMcpStoreOwner(host, target)).toBeUndefined();
  });

  it("lets a later admission survive a deletion even when the earlier requester installs last", () => {
    const { claims, key } = setup();
    const first = claims.begin(target.sessionId, key);
    const release = claims.capture(target.sessionId)!;
    claims.begin(target.sessionId, key)(true);
    first(true);
    expect(release(source)).toBe(false);
    expect(claims.ready(target.sessionId)).toBeUndefined();
    expect(claims.capture(target.sessionId)!(source)).toBe(true);
    expect(claims.ready(target.sessionId)?.()).toBe(true);
  });

  it("releases a captured pending owner only after its installation settles", () => {
    const { claims, key } = setup();
    const finish = claims.begin(target.sessionId, key);
    expect(claims.capture(target.sessionId)!(source)).toBe(true);
    expect(claims.ready(target.sessionId)).toBeUndefined();
    finish(true);
    const ready = claims.ready(target.sessionId)!;
    expect(ready()).toBe(true);
    const unrelated = claims.begin(target.sessionId, undefined);
    expect(ready()).toBe(false);
    unrelated(false);
    expect(ready()).toBe(true);
    claims.prune(new Set(), new Set());
    expect(ready()).toBe(false);
  });

  it("invalidates a captured store when closing but preserves its pending install", () => {
    const { claims, key } = setup();
    const installed = claims.begin(target.sessionId, key);
    const previous = claims.capture(target.sessionId)!;
    claims.forget(target.sessionId);
    installed(true);
    expect(previous(source)).toBe(false);
    expect(claims.capture(target.sessionId)!(source)).toBe(true);
    expect(claims.ready(target.sessionId)?.()).toBe(true);
  });

  it("discards a failed acquisition without poisoning later store ownership", () => {
    const { claims, key } = setup();
    claims.begin(target.sessionId, undefined)(false);
    expect(claims.capture(target.sessionId)).toBeUndefined();
    claims.begin(target.sessionId, key)(true);
    expect(claims.capture(target.sessionId)!(source)).toBe(true);
    expect(claims.ready(target.sessionId)?.()).toBe(true);
  });
});
