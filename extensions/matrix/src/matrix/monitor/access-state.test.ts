import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import {
  resolveMatrixMonitorAccessState,
  resolveMatrixMonitorCommandAccess,
} from "./access-state.js";

beforeEach(() => setMatrixRuntime(createPluginRuntimeMock()));
const alice = "@alice:example.org";
type AccessInput = Partial<Parameters<typeof resolveMatrixMonitorAccessState>[0]>;

function resolveAccess(overrides: AccessInput) {
  return resolveMatrixMonitorAccessState({
    allowFrom: [],
    storeAllowFrom: [],
    groupAllowFrom: [],
    roomUsers: [],
    senderId: alice,
    isRoom: true,
    ...overrides,
  });
}

async function expectBlockedCommand(state: Awaited<ReturnType<typeof resolveAccess>>) {
  const access = await resolveMatrixMonitorCommandAccess(state, {
    allowTextCommands: true,
    hasControlCommand: true,
  });
  expect(access).toMatchObject({ authorized: false, shouldBlockControlCommand: true });
}

describe("resolveMatrixMonitorAccessState", () => {
  it("normalizes group allowlists and uses shared ingress matching", async () => {
    const state = await resolveAccess({
      groupAllowFrom: ["@Carol:Example.org"],
      roomUsers: ["user:@Dana:Example.org"],
      senderId: "@Dana:Example.org",
      groupPolicy: "allowlist",
    });

    expect(state.messageIngress.ingress.decision).toBe("allow");
  });

  it.each([
    { isRoom: false, allowFrom: ["@\u212A:example.org"], groupAllowFrom: [] },
    { isRoom: true, allowFrom: [], groupAllowFrom: ["@\u212A:example.org"] },
  ])("rejects case-folding collisions at ingress and command gates", async (params) => {
    const state = await resolveAccess({
      ...params,
      senderId: "@k:example.org",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
    });

    expect(state.messageIngress.ingress.decision).toBe("block");
    await expectBlockedCommand(state);
  });

  it("does not let pairing-store entries authorize open DMs without wildcard", async () => {
    const state = await resolveAccess({
      storeAllowFrom: [alice],
      dmPolicy: "open",
      isRoom: false,
    });

    expect(state.messageIngress).toMatchObject({
      senderAccess: { effectiveAllowFrom: [], decision: "block" },
      ingress: { reasonCode: "dm_policy_not_allowlisted" },
    });
  });

  it.each<[string, AccessInput]>([
    ["group", { groupAllowFrom: ["Alice"], groupPolicy: "allowlist" }],
    ["room users", { roomUsers: ["Alice"], groupPolicy: "open" }],
  ])("denies ingress and commands for unresolved %s", async (_source, entries) => {
    const state = await resolveAccess(entries);
    expect(state.messageIngress.ingress).toMatchObject({
      decision: "block",
      reasonCode: "group_policy_not_allowlisted",
    });
    await expectBlockedCommand(state);
  });

  it("keeps room-user allowlists out of dm traffic", async () => {
    const state = await resolveAccess({
      groupAllowFrom: ["@carol:example.org"],
      roomUsers: ["@dana:example.org"],
      senderId: "@dana:example.org",
      isRoom: false,
    });

    expect(state.messageIngress.senderAccess.decision).toBe("pairing");
    await expectBlockedCommand(state);
  });
});
