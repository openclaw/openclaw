import { beforeEach, expect, it } from "vitest";
import { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
import type { ChannelConfiguredBindingProvider } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveAcpAgentWorkspaceProvisioningForTurn as resolve } from "./acp-workspace-provisioning.js";

const bindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const normalized = conversationId.trim();
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({ compiledBinding, conversationId }) =>
    compiledBinding.conversationId === conversationId ? { conversationId, matchPriority: 2 } : null,
};
beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: { ...createChannelTestPluginBase({ id: "discord" }), bindings },
        source: "test",
      },
    ]),
  );
});

const cfg: OpenClawConfig = {
  agents: {
    defaults: { workspace: "/shared-ws" },
    entries: {
      main: {},
      codex: { runtime: { type: "acp" } },
      work: { runtime: { type: "embedded" } },
      pinned: { workspace: "/explicit-ws", runtime: { type: "acp" } },
      global: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } },
    },
  },
};
const acp = (cwd?: string): SessionAcpMeta => ({
  backend: "acpx",
  agent: "codex",
  runtimeSessionName: "rs",
  mode: "persistent",
  ...(cwd ? { cwd } : {}),
  state: "idle",
  lastActivityAt: 0,
});
function expectMode(
  overrides: Partial<Parameters<typeof resolve>[0]>,
  expected: "standard" | "runtime-managed-implicit",
) {
  return expect(resolve({ cfg, agentId: "codex", ...overrides })).resolves.toBe(expected);
}
function binding(conversationId: string, cwd?: string) {
  return {
    type: "acp",
    agentId: "codex",
    match: { channel: "discord", peer: { kind: "channel", id: conversationId } },
    ...(cwd ? { acp: { cwd } } : {}),
  } satisfies NonNullable<OpenClawConfig["bindings"]>[number];
}

// #92015: a sibling binding must not inherit the cwd-bearing turn's decision.
it("scopes provisioning to the concrete ACP binding", async () => {
  const mixed = { ...cfg, bindings: [binding("111", "/projects/app"), binding("222")] };
  const key = (conversationId: string) =>
    resolveConfiguredAcpBindingRecord({
      cfg: mixed,
      channel: "discord",
      accountId: "default",
      conversationId,
    })?.record.targetSessionKey ?? "";
  const withCwd = key("111");
  const withoutCwd = key("222");
  expect(withCwd).not.toBe(withoutCwd);
  await expectMode({ cfg: mixed, sessionKey: withCwd }, "runtime-managed-implicit");
  await expectMode({ cfg: mixed, sessionKey: withoutCwd }, "standard");
});

it.each([
  ["codex", "/projects/app", "runtime-managed-implicit"],
  ["codex", undefined, "standard"],
  ["work", "/projects/app", "standard"],
  ["pinned", "/projects/app", "standard"],
  ["global", undefined, "runtime-managed-implicit"],
] as const)("provisions %s with session cwd %s as %s", async (agentId, cwd, expected) => {
  await expectMode(
    { agentId, sessionEntry: agentId === "global" ? undefined : { acp: acp(cwd) } },
    expected,
  );
});
