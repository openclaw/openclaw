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

it("probes without a default workspace and launches sessions in their requested cwd", async () => {
  await withOpenClawTestState(
    {
      label: "acpx-service-cwd",
      env: {
        CODEX_HOME: undefined,
        OPENCLAW_SKIP_ACPX_RUNTIME: undefined,
        OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: undefined,
        OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "1",
      },
    },
    async (state) => {
      const workspace = path.join(state.root, "explicit-workspace");
      const defaultWorkspace = path.join(state.stateDir, "workspace");
      const peer = path.join(state.root, "peer");
      const launches = path.join(state.root, "launches.jsonl");
      const adapter = path.join(state.root, "adapter.mjs");
      await fs.mkdir(workspace);
      await fs.mkdir(peer);
      await fs.writeFile(
        adapter,
        `import fs from "node:fs/promises";
await fs.appendFile(${JSON.stringify(launches)}, JSON.stringify(process.cwd()) + "\\n");
await import(${JSON.stringify(pathToFileURL(ownerAgentScript).href)});
`,
      );
      const ctx: OpenClawPluginServiceContext = {
        stateDir: state.stateDir,
        workspaceDir: defaultWorkspace,
        config: { agents: { entries: { main: { workspace } } } },
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
        },
      });
      await expect(fs.stat(defaultWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
      try {
        await service.start(ctx);
        const backend = publish.mock.calls[0]?.[0];
        expect(backend).toBeDefined();
        expect(ctx.logger.warn).not.toHaveBeenCalled();
        expect(backend?.healthy?.()).toBe(true);
        if (!backend) {
          throw new Error("ACPX backend was not published");
        }
        const handle = await backend.runtime.ensureSession({
          ...fixtureSession("agent:main:acp:cwd"),
          cwd: workspace,
        });
        try {
          const workingDirectories = (await fs.readFile(launches, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(workingDirectories).toEqual([path.join(state.stateDir, "acpx"), workspace]);
          await expect(fs.stat(defaultWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await backend.runtime.close({ handle, reason: "test-complete" });
        }
      } finally {
        await service.stop?.(ctx);
      }
    },
  );
});
