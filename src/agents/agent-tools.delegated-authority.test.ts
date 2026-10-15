import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { createCodingToolsGatewayCaller } from "./agent-tools.caller.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { writeHostFile } from "./host-file-write.js";
import type { AnyAgentTool } from "./tools/common.js";

const requester = "agent:intake:main";
const child = "agent:coder:dashboard:task";
function fixture(deny = ["write"]) {
  const config: OpenClawConfig = {
    agents: {
      entries: {
        intake: {
          tools: { deny },
          subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] },
        },
        coder: {},
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  const capabilityProfile = resolveConversationCapabilityProfile({
    config,
    agentId: "coder",
    sessionKey: child,
    preparedSessionCapabilityStore: {
      [child]: {
        sessionId: "child",
        spawnedBy: requester,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: deny,
        delegatedToolPolicy: {
          requesterSessionKey: requester,
          targetAgentId: "coder",
          deny: [],
          requesterDeny: deny,
        },
      },
    },
  });
  return {
    bind: createCodingToolsGatewayCaller({
      options: { config },
      agentId: "coder",
      sessionKey: child,
      capabilityProfile,
    }),
    revoke(this: void) {
      const revoked = structuredClone(config);
      revoked.agents!.entries!.intake!.subagents!.delegateToolsTo = [];
      setRuntimeConfigSnapshot(revoked);
    },
  };
}
const tool = (execute: AnyAgentTool["execute"]): AnyAgentTool => ({
  name: "write",
  label: "write",
  description: "fixture write",
  parameters: { type: "object", properties: {} },
  execute,
});

describe("delegated coding action authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
  });

  it("rejects a retained tool after its preparation wait without executing it", async () => {
    const { bind, revoke } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const source = tool(execute);
    source.prepareBeforeToolCallParams = async (params) => {
      entered.resolve();
      await release.promise;
      return params;
    };
    const bound = bind(wrapToolWithBeforeToolCallHook(source));
    const running = bound.execute("prepared-write", {});
    const rejected = expect(running).rejects.toThrow("authorization changed");
    await entered.promise;
    revoke();
    release.resolve();
    await rejected;
    expect(execute).not.toHaveBeenCalled();
  });

  it("rechecks inside a host write after its file-opening await", async () => {
    await withTestDir({ prefix: "openclaw-delegated-write-" }, async (dir) => {
      const file = path.join(dir, "original.txt");
      await fs.writeFile(file, "original");
      const { bind, revoke } = fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        entered.resolve();
        await release.promise;
        return handle;
      });
      const bound = bind(
        wrapToolWithBeforeToolCallHook(
          tool(async () => {
            await writeHostFile(file, "changed");
            return { content: [], details: {} };
          }),
        ),
      );
      const running = bound.execute("in-flight-write", {});
      const rejected = expect(running).rejects.toThrow(
        "tool invocation authority is no longer active",
      );
      await entered.promise;
      revoke();
      release.resolve();
      await rejected;
      expect(await fs.readFile(file, "utf8")).toBe("original");
    });
  });

  it.each([
    { deny: "group:plugins", name: "fixture_action", pluginId: "fixture-plugin" },
    { deny: "fixture-plugin", name: "fixture_action", pluginId: "fixture-plugin" },
    { deny: "canvas", name: "show_widget", pluginId: undefined },
  ])("rechecks retained tools covered by $deny", async ({ deny, name, pluginId }) => {
    const { bind, revoke } = fixture([deny]);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const source = { ...tool(execute), name };
    if (pluginId) {
      setPluginToolMeta(source, { pluginId, optional: false });
    }
    const bound = bind(wrapToolWithBeforeToolCallHook(source));
    await bound.execute("before-revoke", {});
    revoke();
    await expect(bound.execute("after-revoke", {})).rejects.toThrow("authorization changed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps tools that did not rely on the grant usable after revocation", async () => {
    const { bind, revoke } = fixture();
    const execute = vi.fn(async () => ({ content: [], details: { read: true } }));
    const reader = { ...tool(execute), name: "read" };
    const bound = bind(wrapToolWithBeforeToolCallHook(reader));
    revoke();
    await expect(bound.execute("read", {})).resolves.toMatchObject({ details: { read: true } });
    expect(execute).toHaveBeenCalledOnce();
  });
});
