/** Tests per-request MCP header providers on one retained OpenClaw-owned HTTP transport. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { McpServerRequestContext } from "../plugins/types.mcp-connection.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { startRequestHeaderMcpProofServer } from "./agent-bundle-mcp-request-headers.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { bindMcpRequestRun, runWithMcpRequestContext } from "./mcp-request-context.js";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

describe("per-request MCP headers", () => {
  it.each(["streamable-http", "sse"] as const)(
    "keeps overlapping turn headers isolated on one retained %s transport",
    async (transport) => {
      const registry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(registry.registry, async () => {
        const proof = await startRequestHeaderMcpProofServer(transport);
        const discoveryStarted = createDeferred();
        const releaseDiscovery = createDeferred();
        const secondAcquired = createDeferred();
        const callStarted = { first: createDeferred(), second: createDeferred() };
        const releaseCall = { first: createDeferred(), second: createDeferred() };
        let holdDiscovery = true;
        let holdCalls = false;
        const provider = vi.fn(async (context: McpServerRequestContext) => {
          if (holdDiscovery) {
            holdDiscovery = false;
            discoveryStarted.resolve();
            await releaseDiscovery.promise;
          }
          if (holdCalls) {
            const turn = context.runId === "first" ? "first" : "second";
            callStarted[turn].resolve();
            await releaseCall[turn].promise;
          }
          return {
            traceparent: context.metadata?.traceparent ?? "missing",
            "x-turn-credential": context.metadata?.credential ?? "missing",
            Authorization: "Bearer must-not-replace-static-auth",
          };
        });
        registry.apiFor("test-plugin").registerMcpServerRequestHeaderProvider({
          serverName: "proof",
          resolve: provider,
        });
        const manager = createSessionMcpRuntimeManager();
        const params = {
          sessionId: `request-headers-${transport}`,
          sessionKey: "agent:test:request-headers",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                proof: {
                  transport,
                  url: proof.url,
                  headers: { Authorization: "Bearer stable-auth" },
                  supportsParallelToolCalls: true,
                },
              },
            },
          },
        };
        const context = (runId: string) => ({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId,
          metadata: { traceparent: `trace-${runId}`, credential: `credential-${runId}` },
        });
        const runtimes: SessionMcpRuntime[] = [];
        const materialized: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>[] = [];
        type Tools = Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>;
        // Each turn stays admitted until released, as a host run spans acquisition and execution.
        const turns = new Map<string, { release: () => void; settled: Promise<unknown> }>();
        const acquire = (runId?: string) =>
          new Promise<Tools>((resolveTools, rejectTools) => {
            const release = createDeferred();
            const body = async () => {
              const lease = await manager.acquire(params);
              runtimes.push(lease.runtime);
              if (runId === "second") {
                secondAcquired.resolve();
              }
              const tools = await materializeBundleMcpToolsForRun(lease);
              materialized.push(tools);
              resolveTools(tools);
              await release.promise;
            };
            const settled = (
              runId
                ? bindMcpRequestRun(context(runId), body)
                : runWithMcpRequestContext(undefined, body)
            ).catch(rejectTools);
            turns.set(runId ?? "empty", { release: () => release.resolve(), settled });
          });
        const settleTurn = async (runId: string) => {
          const turn = expectDefined(turns.get(runId), `turn ${runId}`);
          turn.release();
          await turn.settled;
        };
        try {
          const firstPending = acquire("first");
          await discoveryStarted.promise;
          const secondPending = acquire("second");
          await secondAcquired.promise;
          releaseDiscovery.resolve();
          const [first, second] = await Promise.all([firstPending, secondPending]);
          const empty = await acquire();
          expect(runtimes[1]).toBe(runtimes[0]);
          expect(runtimes[2]).toBe(runtimes[0]);
          expect(new Set(runtimes.map((runtime) => runtime.configFingerprint)).size).toBe(1);
          expect(runtimes[0]?.configFingerprint).toMatch(SHA256_HEX_PATTERN);
          const discovery = proof.requests.filter(
            (request) => request.method === "initialize" || request.method === "tools/list",
          );
          expect(discovery.map((request) => request.method)).toEqual(["initialize", "tools/list"]);
          for (const request of discovery) {
            expect(request.headers.traceparent).toBe("trace-first");
            expect(request.headers["x-turn-credential"]).toBe("credential-first");
          }
          if (transport === "sse") {
            expect(proof.requests[0]?.headers.traceparent).toBe("trace-first");
          }

          holdCalls = true;
          const execute = (tools: typeof first, id: string) =>
            expectDefined(
              tools.tools.find((tool) => tool.name.endsWith("probe")),
              "probe tool",
            ).execute(id, {});
          // These executors outlive their materialization scopes. A concurrent caller's
          // ambient context must not replace their captured attribution.
          const firstCall = bindMcpRequestRun(context("unrelated"), () => execute(first, "one"));
          await callStarted.first.promise;
          const secondCall = execute(second, "two");
          await callStarted.second.promise;
          releaseCall.second.resolve();
          await secondCall;
          releaseCall.first.resolve();
          await firstCall;
          holdCalls = false;
          const providerCalls = provider.mock.calls.length;
          await bindMcpRequestRun(context("unrelated"), () => execute(empty, "empty"));
          expect(provider).toHaveBeenCalledTimes(providerCalls);
          // A settled run's executors lose their attribution instead of signing for it later.
          await settleTurn("first");
          await bindMcpRequestRun(context("unrelated"), () => execute(first, "late"));
          expect(provider).toHaveBeenCalledTimes(providerCalls);
          const calls = proof.requests.filter((request) => request.method === "tools/call");
          expect(calls.map((request) => request.headers.traceparent)).toEqual([
            "trace-second",
            "trace-first",
            undefined,
            undefined,
          ]);
          expect(calls.map((request) => request.headers["x-turn-credential"])).toEqual([
            "credential-second",
            "credential-first",
            undefined,
            undefined,
          ]);
          expect(calls.map((request) => request.headers.authorization)).toEqual([
            "Bearer stable-auth",
            "Bearer stable-auth",
            "Bearer stable-auth",
            "Bearer stable-auth",
          ]);
          expect(proof.requests.filter((request) => request.method === "initialize")).toHaveLength(
            1,
          );
          expect(proof.requests.filter((request) => request.method === "tools/list")).toHaveLength(
            1,
          );
        } finally {
          releaseDiscovery.resolve();
          releaseCall.first.resolve();
          releaseCall.second.resolve();
          for (const turn of turns.values()) {
            turn.release();
          }
          await Promise.allSettled([...turns.values()].map((turn) => turn.settled));
          await Promise.allSettled(materialized.map((tools) => tools.dispose()));
          await manager.disposeAll();
          await proof.close();
        }
      });
    },
  );
});
