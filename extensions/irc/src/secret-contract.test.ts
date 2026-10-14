import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

const sharedRef = { source: "env", provider: "default", id: "IRC_SHARED_NS" } as const;
const workRef = { source: "env", provider: "default", id: "IRC_WORK_NS" } as const;

describe("IRC secret contract", () => {
  it.each([
    { label: "no nickserv block", nickserv: {}, owners: ["irc:work"] },
    { label: "a service-only nickserv", nickserv: { service: "NickServ" }, owners: ["irc:work"] },
    { label: "its own nickserv password", nickserv: { password: workRef }, owners: [] },
    { label: "nickserv disabled", nickserv: { enabled: false }, owners: [] },
  ])("inherits the top-level nickserv password for $label", ({ nickserv, owners }) => {
    const account = { host: "irc.example.com", nick: "clawwork" };
    const sourceConfig = {
      channels: {
        irc: {
          nickserv: { password: sharedRef },
          accounts: {
            work: Object.keys(nickserv).length > 0 ? { ...account, nickserv } : account,
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({ config: structuredClone(sourceConfig), context });

    expect(
      context.assignments
        .filter(({ path }) => path === "channels.irc.nickserv.password")
        .map(({ ownerId }) => ownerId),
    ).toEqual(owners);
  });
});
