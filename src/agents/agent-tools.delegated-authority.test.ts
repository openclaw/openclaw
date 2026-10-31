import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const requester = "agent:intake:main";
const child = "agent:coder:dashboard:task";
function fixture(deny = ["write"]) {
  const intake = {
    tools: { deny },
    subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] },
  };
  const config: OpenClawConfig = { agents: { entries: { intake, coder: {} } } };
  setRuntimeConfigSnapshot(config);
  const identity = { agentId: "coder", sessionKey: child };
  const delegatedToolPolicy = {
    requesterSessionKey: requester,
    targetAgentId: "coder",
    deny: [],
    requesterDeny: deny,
  };
  const childEntry = {
    sessionId: "child",
    spawnedBy: requester,
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1 as const,
    inheritedToolDeny: deny,
    delegatedToolPolicy,
  };
  const capabilityProfile = resolveConversationCapabilityProfile({
    config,
    ...identity,
    preparedSessionCapabilityStore: { [child]: childEntry },
  });
  const bind = createCodingToolsGatewayCaller({
    options: { config },
    ...identity,
    capabilityProfile,
  });
  return {
    bind: (source: AnyAgentTool) => bind(wrapToolWithBeforeToolCallHook(source)),
    revoke(this: void) {
      const revoked = structuredClone(config);
      revoked.agents!.entries!.intake!.subagents!.delegateToolsTo = [];
      setRuntimeConfigSnapshot(revoked);
    },
  };
}
const tool = (execute: AnyAgentTool["execute"]): AnyAgentTool => ({
  ...createStubTool("write"),
  execute,
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it("rechecks authority after the preparation await", async () => {
  await withTestDir({ prefix: "openclaw-delegated-write-" }, async (dir) => {
    const file = path.join(dir, "original.txt");
    await fs.writeFile(file, "original");
    const { bind, revoke } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = vi.fn(async () => {
      await writeHostFile(file, "changed");
      return { content: [], details: {} };
    });
    const source = tool(execute);
    source.prepareBeforeToolCallParams = async (params) => {
      entered.resolve();
      await release.promise;
      return params;
    };
    const bound = bind(source);
    const running = bound.execute("in-flight-write", {});
    const rejected = expect(running).rejects.toThrow("authorization changed");
    await entered.promise;
    revoke();
    release.resolve();
    await rejected;
    expect(execute).not.toHaveBeenCalled();
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
  const bound = bind(source);
  await bound.execute("before-revoke", {});
  revoke();
  await expect(bound.execute("after-revoke", {})).rejects.toThrow("authorization changed");
  expect(execute).toHaveBeenCalledOnce();
});

it("keeps tools that did not rely on the grant usable after revocation", async () => {
  const { bind, revoke } = fixture();
  const execute = vi.fn(async () => ({ content: [], details: { read: true } }));
  const reader = { ...tool(execute), name: "read" };
  const bound = bind(reader);
  revoke();
  await expect(bound.execute("read", {})).resolves.toMatchObject({ details: { read: true } });
  expect(execute).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "awaits final file authority without invoking its raw guard (revoke=%s)",
  async (revoke) => {
    await withTestDir({ prefix: "openclaw-prepared-write-" }, async (dir) => {
      const file = path.join(dir, "original.txt");
      await fs.writeFile(file, "original");
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const release = vi.fn();
      let active = true;
      let preparations = 0;
      const raw = vi.fn(() => {
        throw new Error("unexpected synchronous source probe");
      });
      const receiptAuthority = Object.assign(raw, {
        prepareSessionSourceEffect: async () => {
          if (++preparations === 2) {
            entered.resolve();
            await resume.promise;
          }
          return {
            assertCurrent() {
              if (!active) {
                throw new Error("source retired");
              }
            },
            release,
          };
        },
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:prepared-file",
          receiptAuthority,
        },
        () => writeHostFile(file, "replacement"),
      ).catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("write settled before final authority preparation");
          }),
        ]);
        expect(await fs.readFile(file, "utf8")).toBe("original");
        active = !revoke;
      } finally {
        resume.resolve();
      }
      const outcome = await pending;
      if (revoke) {
        expect(outcome).toMatchObject({ message: "source retired" });
      } else {
        expect(outcome).toBeUndefined();
      }
      expect(await fs.readFile(file, "utf8")).toBe(revoke ? "original" : "replacement");
      expect(raw).not.toHaveBeenCalled();
      expect(preparations).toBe(2);
      expect(release).toHaveBeenCalledTimes(2);
    });
  },
);
