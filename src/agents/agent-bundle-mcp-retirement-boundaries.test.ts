import { randomUUID } from "node:crypto";
import http from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  getSessionMcpRuntimeManagerForTesting,
  peekSessionMcpRuntime,
  releaseSessionMcpRuntime,
  reloadSessionMcpRuntimes,
  retireSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { prepareCliBundleMcpConfig } from "./cli-runner/bundle-mcp.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const emptyConfig: OpenClawConfig = { plugins: { enabled: false }, mcp: { servers: {} } };

async function withMcpFixture(
  run: (fixture: {
    workspaceDir: string;
    config: (endpoint: string) => OpenClawConfig;
    hold: () => {
      entered: ReturnType<typeof createDeferred<void>>;
      release: ReturnType<typeof createDeferred<void>>;
    };
    hooks: { onDelete?: (url: string) => Promise<void>; onList?: (url: string) => Promise<void> };
  }) => Promise<void>,
) {
  const workspaceDir = tempDirs.make("mcp-retirement-boundary-");
  const releases: Array<() => void> = [];
  const hooks: {
    onDelete?: (url: string) => Promise<void>;
    onList?: (url: string) => Promise<void>;
  } = {};
  const server = http.createServer((request, response) => {
    void (async () => {
      const endpoint = request.url ?? "/";
      if (request.method === "DELETE") {
        await hooks.onDelete?.(endpoint);
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      let result;
      if (message.method === "initialize") {
        response.setHeader("mcp-session-id", randomUUID());
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "retirement-proof", version: "1" },
        };
      } else if (message.method === "tools/list") {
        await hooks.onList?.(endpoint);
        result = { tools: [{ name: "read", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: endpoint }] };
      }
      if (!result) {
        response.writeHead(202).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP fixture did not bind");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
    await disposeAllSessionMcpRuntimes();
    try {
      await run({
        workspaceDir,
        config: (endpoint) => ({
          plugins: { enabled: false },
          mcp: {
            servers: { probe: { transport: "streamable-http", url: `${baseUrl}${endpoint}` } },
          },
        }),
        hooks,
        hold: () => {
          const entered = createDeferred();
          const release = createDeferred();
          releases.push(() => release.resolve());
          return { entered, release };
        },
      });
    } finally {
      for (const release of releases) {
        release();
      }
      await disposeAllSessionMcpRuntimes();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

it("retains an empty runtime until its live materialized handle releases", async () => {
  await withMcpFixture(async ({ workspaceDir, config }) => {
    const sessionId = "retained-empty";
    const sessionKey = `agent:main:${sessionId}`;
    const acquired = await acquireSessionMcpRuntime({
      sessionId,
      sessionKey,
      workspaceDir,
      cfg: config("/old"),
    });
    const handle = await materializeBundleMcpToolsForRun(acquired);
    try {
      await expect(handle.tools[0]!.execute("before-removal", {})).resolves.toMatchObject({
        content: [{ text: "/old" }],
      });
      await reloadSessionMcpRuntimes({ cfg: emptyConfig });
      expect(acquired.runtime.activeLeases).toBe(1);
      // Removed server authority stays revoked; the retained facade remains readable.
      await expect(acquired.runtime.getCatalog()).resolves.toMatchObject({ tools: [] });
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(acquired.runtime);
      await reloadSessionMcpRuntimes({ cfg: emptyConfig });
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(acquired.runtime);
    } finally {
      await handle.dispose();
    }
    expect(peekSessionMcpRuntime({ sessionKey })).toBeUndefined();
    expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
  });
});

it("preserves a newer session binding while old empty cleanup drains", async () => {
  await withMcpFixture(async ({ workspaceDir, config, hooks, hold }) => {
    const sessionKey = "agent:main:rebound";
    const previous = await acquireSessionMcpRuntime({
      sessionId: "old-binding",
      sessionKey,
      workspaceDir,
      cfg: config("/old"),
    });
    await previous.runtime.getCatalog();
    await releaseSessionMcpRuntime(previous);
    const deletion = hold();
    hooks.onDelete = async (url) => {
      if (url === "/old") {
        deletion.entered.resolve();
        await deletion.release.promise;
      }
    };
    const reloading = reloadSessionMcpRuntimes({ cfg: emptyConfig });
    await deletion.entered.promise;
    const retiring = retireSessionMcpRuntime({ sessionId: "old-binding", reason: "boundary-test" });
    const next = await acquireSessionMcpRuntime({
      sessionId: "new-binding",
      sessionKey,
      workspaceDir,
      cfg: config("/new"),
    });
    try {
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(next.runtime);
      await expect(next.runtime.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "/new" }],
      });
      deletion.release.resolve();
      await Promise.all([reloading, retiring]);
      expect(getSessionMcpRuntimeManagerForTesting().resolveSessionId(sessionKey)).toBe(
        "new-binding",
      );
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(next.runtime);
      expect(peekSessionMcpRuntime({ sessionId: "old-binding" })).toBeUndefined();
      await expect(next.runtime.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "/new" }],
      });
    } finally {
      deletion.release.resolve();
      await releaseSessionMcpRuntime(next);
      await Promise.all([reloading, retiring]);
    }
  });
});

it("preserves the runtime admitted by an in-flight static native preflight", async () => {
  await withMcpFixture(async ({ workspaceDir, config, hooks, hold }) => {
    const sessionId = "native-preflight";
    const sessionKey = `agent:main:${sessionId}`;
    const cfg = config("/native");
    const original = await acquireSessionMcpRuntime({ sessionId, sessionKey, workspaceDir, cfg });
    const listing = hold();
    hooks.onList = async () => {
      listing.entered.resolve();
      await listing.release.promise;
    };
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
          config: cfg,
          agentId: "main",
          sessionId,
          sessionKey,
          workspaceDir,
        }),
      },
    }).then((result) => {
      prepared = true;
      return result;
    });
    try {
      await listing.entered.promise;
      const admitted = expectDefined(
        peekSessionMcpRuntime({ sessionKey }),
        "in-flight native runtime",
      );
      await releaseSessionMcpRuntime(original, new Set());
      expect(prepared).toBe(false);
      expect(peekSessionMcpRuntime({ sessionKey })).toBe(admitted);
      expect(admitted.activeLeases).toBe(1);
      listing.release.resolve();
      const result = await preflight;
      expect(result.backend.args).toContain("--mcp-config");
      const current = expectDefined(peekSessionMcpRuntime({ sessionKey }), "prepared runtime");
      expect(current).toBe(admitted);
      await expect(current.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "/native" }],
      });
    } finally {
      listing.release.resolve();
      await releaseSessionMcpRuntime(original);
      await (await preflight).cleanup?.();
    }
  });
});
