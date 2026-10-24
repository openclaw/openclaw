import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startMcpLifecycleServer } from "./agent-bundle-mcp-lifecycle.test-support.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  peekSessionMcpRuntime,
  reloadSessionMcpRuntimes,
  retireSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "./agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "./agent-bundle-mcp-manager-cleanup.js";
import { getSessionMcpRuntimeTestManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { prepareCliBundleMcpConfig } from "./cli-runner/bundle-mcp.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createEnteredGate } from "./entered-gate.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const emptyConfig: OpenClawConfig = { plugins: { enabled: false }, mcp: { servers: {} } };

async function createFixture(workspaceDir: string) {
  const releases: Array<() => void> = [];
  const hooks: {
    onDelete?: (url: string) => Promise<void>;
    onList?: (url: string) => Promise<void>;
  } = {};
  const server = await startMcpLifecycleServer({
    toolName: "read",
    onDelete: (endpoint) => hooks.onDelete?.(endpoint) ?? Promise.resolve(),
    onList: (endpoint) => hooks.onList?.(endpoint) ?? Promise.resolve(),
    text: (endpoint) => endpoint,
  });
  return {
    input: (sessionId: string, endpoint: string, sessionKey = `agent:main:${sessionId}`) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        mcp: {
          servers: { probe: { transport: "streamable-http", url: `${server.url}${endpoint}` } },
        },
      };
      return { workspaceDir, sessionId, sessionKey, cfg };
    },
    hooks,
    hold: () => {
      const gate = createEnteredGate();
      releases.push(gate.release);
      return gate;
    },
    releaseAll: () => releases.forEach((release) => release()),
    close: server.close,
  };
}

async function withMcpFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const workspaceDir = tempDirs.make("mcp-retirement-boundary-");
  const fixture = await createFixture(workspaceDir);
  await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
    await disposeAllSessionMcpRuntimes();
    const scheduler = createTestGatewayScheduler();
    await setSessionMcpRuntimeScheduler(scheduler);
    try {
      await run(fixture);
    } finally {
      fixture.releaseAll();
      await disposeAllSessionMcpRuntimes();
      await scheduler.stop();
      await fixture.close();
    }
  });
}

it("retains an empty runtime until its live materialized handle releases", async () => {
  await withMcpFixture(async ({ input }) => {
    const params = input("retained-empty", "/old");
    const { sessionKey } = params;
    const acquired = await acquireSessionMcpRuntime(params);
    const handle = await materializeBundleMcpToolsForRun(acquired);
    try {
      await expect(handle.tools[0]!.execute("before-removal", {})).resolves.toMatchObject({
        content: [{ text: "/old" }],
      });
      await reloadSessionMcpRuntimes({ cfg: emptyConfig });
      expect(acquired.runtime.activeLeases).toBe(1);
      await expect(acquired.runtime.getCatalog()).resolves.toMatchObject({ tools: [] });
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(acquired.runtime);
      await reloadSessionMcpRuntimes({ cfg: emptyConfig });
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(acquired.runtime);
    } finally {
      await handle.dispose();
    }
    expect(peekSessionMcpRuntime({ sessionKey })).toBeUndefined();
    expect(getSessionMcpRuntimeTestManager().listRuntimeKeys()).toEqual([]);
  });
});

it("preserves a newer session binding while old empty cleanup drains", async () => {
  await withMcpFixture(async ({ input, hooks, hold }) => {
    const sessionKey = "agent:main:rebound";
    const previous = await acquireSessionMcpRuntime(input("old-binding", "/old", sessionKey));
    await previous.runtime.getCatalog();
    await releaseSessionMcpRuntime(previous);
    const deletion = hold();
    hooks.onDelete = async (url) => {
      if (url === "/old") {
        await deletion.wait();
      }
    };
    const reloading = reloadSessionMcpRuntimes({ cfg: emptyConfig });
    await deletion.entered;
    const retiring = retireSessionMcpRuntime({ sessionId: "old-binding", reason: "boundary-test" });
    const next = await acquireSessionMcpRuntime(input("new-binding", "/new", sessionKey));
    try {
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(next.runtime);
      await expect(next.runtime.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "/new" }],
      });
      deletion.release();
      await Promise.all([reloading, retiring]);
      expect(getSessionMcpRuntimeTestManager().resolveSessionId(sessionKey)).toBe("new-binding");
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(next.runtime);
      expect(peekSessionMcpRuntime({ sessionId: "old-binding" })).toBeUndefined();
      await expect(next.runtime.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "/new" }],
      });
    } finally {
      deletion.release();
      await releaseSessionMcpRuntime(next);
      await Promise.all([reloading, retiring]);
    }
  });
});

it("preserves the runtime admitted by an in-flight static native preflight", async () => {
  await withMcpFixture(async ({ input, hooks, hold }) => {
    const params = input("native-preflight", "/native");
    const { sessionId, sessionKey, workspaceDir, cfg } = params;
    const original = await acquireSessionMcpRuntime(params);
    const listing = hold();
    hooks.onList = listing.wait;
    let prepared = false;
    const preflight = prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: [] },
      workspaceDir,
      config: cfg,
      nativeMcpPolicy: {
        sessionId,
        sessionKey,
        capabilityProfile: resolveConversationCapabilityProfile({
          ...params,
          config: cfg,
          agentId: "main",
        }),
      },
    }).then((result) => {
      prepared = true;
      return result;
    });
    try {
      await listing.entered;
      const admitted = expectDefined(
        peekSessionMcpRuntime({ sessionKey }),
        "in-flight native runtime",
      );
      await releaseSessionMcpRuntime(original, new Set());
      expect(prepared).toBe(false);
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(admitted);
      expect(admitted.activeLeases).toBe(1);
      listing.release();
      const result = await preflight;
      expect(result.backend.args).toContain("--mcp-config");
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(admitted);
      await expect(admitted.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "/native" }],
      });
    } finally {
      listing.release();
      await releaseSessionMcpRuntime(original);
      await (await preflight).cleanup?.();
    }
  });
});
