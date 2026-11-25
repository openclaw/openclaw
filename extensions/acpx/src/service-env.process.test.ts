import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import type { OpenClawPluginServiceContext } from "../runtime-api.js";
import { createEmptyAcpxKeyedStore } from "./empty-keyed-store.test-support.js";
import { fixtureSession, ownerAgentScript } from "./runtime-process.test-support.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";
import { createAcpxRuntimeService } from "./service.js";

const HOST_SECRET = "OPENCLAW_GATEWAY_TOKEN";
const WATCHED = [HOST_SECRET, "OPENCLAW_ACPX_PROOF_KEPT", "TOKIO_WORKER_THREADS", "PATH"];

it.each([
  [{}, WATCHED],
  [{ agentProcessEnvBlock: [HOST_SECRET] }, WATCHED.slice(1)],
  [{ agentProcessEnvAllow: [HOST_SECRET], agentProcessEnvBlock: [HOST_SECRET] }, WATCHED.slice(2)],
])("ACP agents inherit only permitted Gateway env with %j", async (envConfig, expected) => {
  await withOpenClawTestState(
    {
      label: "acpx-service-env",
      env: {
        CODEX_HOME: undefined,
        OPENCLAW_SKIP_ACPX_RUNTIME: undefined,
        OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: undefined,
        OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "1",
        TOKIO_WORKER_THREADS: undefined,
        [HOST_SECRET]: ["fake", "gateway", randomUUID()].join("-"),
        OPENCLAW_ACPX_PROOF_KEPT: "1",
      },
    },
    async (state) => {
      const launches = path.join(state.root, "launches.jsonl");
      const adapter = path.join(state.root, "adapter.mjs");
      const peer = path.join(state.root, "peer");
      await fs.mkdir(peer);
      // Record names only, never values, then hand off to the real fixture agent.
      await fs.writeFile(
        adapter,
        `import fs from "node:fs/promises";
const watched = ${JSON.stringify(WATCHED)};
await fs.appendFile(${JSON.stringify(launches)}, JSON.stringify(watched.filter((name) => name in process.env)) + "\\n");
await import(${JSON.stringify(pathToFileURL(ownerAgentScript).href)});
`,
      );
      const ctx: OpenClawPluginServiceContext = {
        stateDir: state.stateDir,
        workspaceDir: state.root,
        config: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      };
      const publish =
        vi.fn<(backend: { runtime: CompleteAcpRuntime; healthy?: () => boolean }) => void>();
      const service = createAcpxRuntimeService({
        backendLifecycle: { publish, retract: vi.fn() },
        openKeyedStore: createEmptyAcpxKeyedStore,
        pluginConfig: {
          probeAgent: "fixture",
          agents: { fixture: { command: process.execPath, args: [adapter, peer] } },
          ...envConfig,
        },
      });
      try {
        await service.start(ctx);
        const backend = publish.mock.calls[0]?.[0];
        if (!backend) {
          throw new Error("ACPX backend was not published");
        }
        expect(backend.healthy?.()).toBe(true);
        const handle = await backend.runtime.ensureSession(fixtureSession("agent:main:acp:env"));
        await backend.runtime.close({ handle, reason: "test-complete" });
        const inherited = (await fs.readFile(launches, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        // Startup probe and session launch both use the configured policy.
        expect(inherited).toEqual([expected, expected]);
      } finally {
        await service.stop?.(ctx);
      }
    },
  );
});
