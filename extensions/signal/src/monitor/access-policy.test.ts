import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { AccessGroupsConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it } from "vitest";
import { resolveSignalSender } from "../identity.js";
import { setSignalRuntime } from "../runtime.js";
import { resolveSignalAccessState } from "./access-policy.js";

beforeEach(() => setSignalRuntime(createPluginRuntimeMock()));

const groupId = "signal-group-id";
const phone = { kind: "phone" as const, e164: "+15551230000", raw: "+15551230000" };
const uuid = "f4d0fe67-3b38-446d-828e-317c285ffa75";
const accessGroups: AccessGroupsConfig = {
  operators: { type: "message.senders", members: { signal: [phone.e164] } },
};

const aliasedSender = expectDefined(
  resolveSignalSender({ sourceNumber: phone.e164, sourceUuid: uuid }),
  "Signal sender",
);
type AccessParams = Partial<Parameters<typeof resolveSignalAccessState>[0]>;
const store =
  (...entries: string[]) =>
  async () => [...entries];

function resolveAccess(params: AccessParams) {
  return resolveSignalAccessState({
    accountId: "default",
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: [],
    groupAllowFrom: [],
    sender: phone,
    groupId,
    isGroup: false,
    ...(params.isGroup ? { readStoreAllowFrom: store() } : {}),
    ...params,
  });
}

type ExpectedAccess = Partial<Awaited<ReturnType<typeof resolveAccess>>["senderAccess"]>;
it.each<[string, AccessParams, "allow" | "block", ExpectedAccess?]>([
  ["group target", { isGroup: true, groupAllowFrom: [`group:${groupId}`] }, "allow"],
  ["prefixed group", { isGroup: true, groupAllowFrom: [`signal:group:${groupId}`] }, "allow"],
  ["group sender fallback", { isGroup: true, allowFrom: [phone.e164] }, "allow"],
  ["no DM group-id match", { allowFrom: [groupId] }, "block"],
  ["DM access group", { allowFrom: ["accessGroup:operators"], cfg: { accessGroups } }, "allow"],
  [
    "unrelated UUID",
    { allowFrom: ["uuid:00000000-0000-0000-0000-000000000000"], sender: aliasedSender },
    "block",
  ],
  ["groups reject pairing", { isGroup: true, readStoreAllowFrom: store(phone.e164) }, "block"],
  [
    "explicit group mismatch",
    { isGroup: true, allowFrom: [groupId], groupAllowFrom: ["other-group"] },
    "block",
  ],
  [
    "preserves matched group senders",
    { isGroup: true, groupAllowFrom: ["accessGroup:operators"], cfg: { accessGroups } },
    "allow",
    { effectiveGroupAllowFrom: expect.arrayContaining([phone.e164]) },
  ],
  [
    "allows paired direct senders",
    { dmPolicy: "pairing", readStoreAllowFrom: store(phone.e164) },
    "allow",
    { effectiveAllowFrom: [phone.e164] },
  ],
  [
    "preserves UUID pairing after learning the phone alias",
    { dmPolicy: "pairing", sender: aliasedSender, readStoreAllowFrom: store(`uuid:${uuid}`) },
    "allow",
    { effectiveAllowFrom: expect.arrayContaining([`uuid:${uuid}`]) },
  ],
])("%s", async (_name, params, decision, effectiveAllowlist) => {
  const { senderAccess } = await resolveAccess(params);
  expect(senderAccess).toMatchObject({ decision, ...effectiveAllowlist });
});

it.each<[string, "open" | "allowlist", string[], boolean, boolean]>([
  ["blocks unauthorized open-group commands", "open", [], false, false],
  ["authorizes a listed sender", "allowlist", [phone.e164], false, true],
  ["authorizes a sender UUID alias", "allowlist", [`uuid:${uuid}`], true, true],
])("%s", async (_name, groupPolicy, groupAllowFrom, aliased, authorized) => {
  const access = await resolveAccess({
    groupPolicy,
    groupAllowFrom,
    sender: aliased ? aliasedSender : phone,
    isGroup: true,
    hasControlCommand: true,
  });
  expect(access).toMatchObject({
    senderAccess: { decision: "allow" },
    commandAccess: { authorized, shouldBlockControlCommand: !authorized },
  });
});
