import { beforeEach, expect, it } from "vitest";
import { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
import type { ChannelConfiguredBindingProvider } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveAcpAgentWorkspaceProvisioningForTurn as resolve } from "./acp-workspace-provisioning.js";

const bindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => ({ conversationId }),
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

function config(entries: NonNullable<OpenClawConfig["agents"]>["entries"]): OpenClawConfig {
  return { agents: { defaults: { workspace: "/shared-ws" }, entries } };
}
const cfg = config({ main: {}, codex: { runtime: { type: "acp" } } });
function acp(cwd?: string): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "rs",
    mode: "persistent",
    ...(cwd ? { cwd } : {}),
    state: "idle",
    lastActivityAt: 0,
  };
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
  await expect(resolve({ cfg: mixed, agentId: "codex", sessionKey: withCwd })).resolves.toBe(
    "runtime-managed-implicit",
  );
  await expect(resolve({ cfg: mixed, agentId: "codex", sessionKey: withoutCwd })).resolves.toBe(
    "standard",
  );
});

it.each([
  ["/projects/app", "runtime-managed-implicit"],
  [undefined, "standard"],
])("uses the live ACP session cwd %s", async (cwd, expected) => {
  await expect(resolve({ cfg, agentId: "codex", sessionEntry: { acp: acp(cwd) } })).resolves.toBe(
    expected,
  );
});

it.each(["work", "pinned"])("keeps standard provisioning for %s", async (agentId) => {
  await expect(
    resolve({
      cfg: config({
        work: { runtime: { type: "embedded" } },
        pinned: { workspace: "/explicit-ws", runtime: { type: "acp" } },
      }),
      agentId,
      sessionEntry: { acp: acp("/projects/app") },
    }),
  ).resolves.toBe("standard");
});

it("falls back to the agent-global ACP cwd", async () => {
  await expect(
    resolve({
      cfg: config({ codex: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } } }),
      agentId: "codex",
    }),
  ).resolves.toBe("runtime-managed-implicit");
});
