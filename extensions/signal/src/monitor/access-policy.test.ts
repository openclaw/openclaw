import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { AccessGroupsConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSignalSender } from "../identity.js";
import { setSignalRuntime } from "../runtime.js";
import { resolveSignalAccessState } from "./access-policy.js";

beforeEach(() => {
  setSignalRuntime(createPluginRuntimeMock());
});

const SIGNAL_GROUP_ID = "signal-group-id";
const OTHER_SIGNAL_GROUP_ID = "other-signal-group-id";
const SIGNAL_SENDER = { kind: "phone" as const, e164: "+15551230000", raw: "+15551230000" };
const SIGNAL_UUID = "f4d0fe67-3b38-446d-828e-317c285ffa75";
const accessGroups: AccessGroupsConfig = {
  operators: { type: "message.senders", members: { signal: [SIGNAL_SENDER.e164] } },
};

function resolveAliasedSignalSender() {
  return expectDefined(
    resolveSignalSender({ sourceNumber: SIGNAL_SENDER.e164, sourceUuid: SIGNAL_UUID }),
    "Signal sender",
  );
}

async function resolveGroupAccess(params: Partial<Parameters<typeof resolveSignalAccessState>[0]>) {
  return (
    await resolveAccess({
      groupId: SIGNAL_GROUP_ID,
      readStoreAllowFrom: async () => [],
      ...params,
      isGroup: true,
    })
  ).senderAccess;
}

function resolveAccess(params: Partial<Parameters<typeof resolveSignalAccessState>[0]>) {
  return resolveSignalAccessState({
    accountId: "default",
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: [],
    groupAllowFrom: [],
    sender: SIGNAL_SENDER,
    isGroup: false,
    ...params,
  });
}

describe("resolveSignalAccessState", () => {
  it("allows Signal group target forms in groupAllowFrom", async () => {
    const groupTargetDecision = await resolveGroupAccess({
      groupAllowFrom: [`group:${SIGNAL_GROUP_ID}`],
    });
    const signalGroupTargetDecision = await resolveGroupAccess({
      groupAllowFrom: [`signal:group:${SIGNAL_GROUP_ID}`],
    });

    expect(groupTargetDecision.decision).toBe("allow");
    expect(signalGroupTargetDecision.decision).toBe("allow");
  });

  it("falls back to allowFrom for group sender access when groupAllowFrom is unset", async () => {
    const groupDecision = await resolveGroupAccess({ allowFrom: [SIGNAL_SENDER.e164] });

    expect(groupDecision.decision).toBe("allow");
  });

  it("does not match group ids against direct-message allowFrom entries", async () => {
    const { senderAccess } = await resolveAccess({
      allowFrom: [SIGNAL_GROUP_ID],
      groupId: SIGNAL_GROUP_ID,
    });

    expect(senderAccess.decision).toBe("block");
  });

  it("allows direct messages through static message sender access groups", async () => {
    const { senderAccess } = await resolveAccess({
      allowFrom: ["accessGroup:operators"],
      cfg: { accessGroups },
    });

    expect(senderAccess.decision).toBe("allow");
  });

  it("preserves matched Signal senders in effective group allowlists", async () => {
    const groupDecision = await resolveGroupAccess({
      groupAllowFrom: ["accessGroup:operators"],
      cfg: { accessGroups },
    });

    expect(groupDecision.decision).toBe("allow");
    expect(groupDecision.effectiveGroupAllowFrom).toContain(SIGNAL_SENDER.e164);
  });

  it("allows paired direct senders from the pairing store", async () => {
    const { senderAccess } = await resolveAccess({
      dmPolicy: "pairing",
      readStoreAllowFrom: async () => [SIGNAL_SENDER.e164],
    });

    expect(senderAccess.decision).toBe("allow");
    expect(senderAccess.effectiveAllowFrom).toEqual([SIGNAL_SENDER.e164]);
  });

  it("keeps a UUID-paired sender allowed after signal-cli learns its phone alias", async () => {
    const { senderAccess } = await resolveAccess({
      dmPolicy: "pairing",
      sender: resolveAliasedSignalSender(),
      readStoreAllowFrom: async () => [`uuid:${SIGNAL_UUID}`],
    });

    expect(senderAccess.decision).toBe("allow");
    expect(senderAccess.effectiveAllowFrom).toContain(`uuid:${SIGNAL_UUID}`);
  });

  it("does not authorize an aliased sender through an unrelated UUID", async () => {
    const { senderAccess } = await resolveAccess({
      allowFrom: ["uuid:00000000-0000-0000-0000-000000000000"],
      sender: resolveAliasedSignalSender(),
    });

    expect(senderAccess.decision).toBe("block");
  });

  it("does not let pairing-store senders satisfy group access", async () => {
    const groupDecision = await resolveGroupAccess({
      groupAllowFrom: [],
      readStoreAllowFrom: async () => [SIGNAL_SENDER.e164],
    });

    expect(groupDecision.decision).toBe("block");
  });

  it("does not let group ids in allowFrom satisfy an explicit groupAllowFrom mismatch", async () => {
    const groupDecision = await resolveGroupAccess({
      allowFrom: [SIGNAL_GROUP_ID],
      groupAllowFrom: [OTHER_SIGNAL_GROUP_ID],
    });

    expect(groupDecision.decision).toBe("block");
  });

  it.each<[string, "open" | "allowlist", string[], boolean, boolean]>([
    ["blocks unauthorized open-group commands", "open", [], false, false],
    ["authorizes a listed sender", "allowlist", [SIGNAL_SENDER.e164], false, true],
    ["authorizes a sender UUID alias", "allowlist", [`uuid:${SIGNAL_UUID}`], true, true],
  ])("%s", async (_name, groupPolicy, groupAllowFrom, aliased, authorized) => {
    const access = await resolveAccess({
      groupPolicy,
      groupAllowFrom,
      sender: aliased ? resolveAliasedSignalSender() : SIGNAL_SENDER,
      groupId: SIGNAL_GROUP_ID,
      isGroup: true,
      hasControlCommand: true,
    });
    expect(access.senderAccess.decision).toBe("allow");
    expect(access.commandAccess).toMatchObject({
      authorized,
      shouldBlockControlCommand: !authorized,
    });
  });
});
