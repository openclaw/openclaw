import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpxRuntime as BaseAcpxRuntime } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { resolveAcpxPluginConfig } from "./config.js";
import {
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const script = fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginStateStoreForTests();
});

it.skipIf(process.platform === "win32").each([false, true])(
  "keeps a live successor wrapper after delayed close (snapshot has PID=%s)",
  async (keepPid) => {
    await withOpenClawTestState({ label: "acpx-close-lease-overlap" }, async (state) => {
      const peerDirectory = path.join(state.root, "peer");
      const codexHome = path.join(state.root, "empty-codex-home");
      await fs.mkdir(peerDirectory);
      await fs.mkdir(codexHome);
      vi.stubEnv("CODEX_HOME", codexHome);
      const config = await prepareAcpxCodexAuthConfig({
        pluginConfig: resolveAcpxPluginConfig({
          rawConfig: {
            agents: { codex: { command: process.execPath, args: [script, peerDirectory] } },
          },
          workspaceDir: state.root,
        }),
        stateDir: state.root,
        resolveInstalledCodexAcpBinPath: async () => script,
        resolveInstalledClaudeAcpBinPath: async () => script,
      });
      const store = createFileSessionStore({ stateDir: config.stateDir });
      const leases = createAcpxProcessLeaseStore({
        store: openAcpxProcessLeaseStateStore((options) =>
          createPluginStateKeyedStoreForTests("acpx", { ...options, env: state.env }),
        ),
      });
      const runtime = new AcpxRuntime({
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({ overrides: config.agents }),
        permissionMode: "deny-all",
        timeoutMs: 5_000,
        openclawWrapperRoot: path.join(state.root, "acpx"),
        openclawGatewayInstanceId: "close-overlap",
        openclawProcessLeaseStore: leases,
      });
      const target = {
        sessionKey: "leased-reset",
        agentId: "main",
        agent: "codex",
        mode: "persistent" as const,
      };
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      let closing: Promise<void> | undefined;
      let fresh: Awaited<ReturnType<AcpxRuntime["ensureSession"]>> | undefined;
      try {
        const first = await runtime.ensureSession(target);
        if (!first.acpxRecordId) {
          throw new Error("Initial physical record ID is missing");
        }
        const oldRecord = await store.load(first.acpxRecordId);
        if (!oldRecord) {
          throw new Error("Initial leased session record is missing");
        }
        const oldIdentity = readAcpxProcessLeaseIdentity(oldRecord.agentArgv);
        expect(oldIdentity?.gatewayInstanceId).toBe("close-overlap");
        if (!keepPid) {
          // A stopped ACPX record can retain its physical lease without its PID.
          await store.save({ ...oldRecord, pid: undefined });
        }
        const close = vi.spyOn(BaseAcpxRuntime.prototype, "close");
        close.mockImplementation(async function (this: BaseAcpxRuntime, input) {
          if (input.handle.backendSessionId === first.backendSessionId) {
            started.resolve();
            await release.promise;
          }
          close.mockRestore();
          return await BaseAcpxRuntime.prototype.close.call(this, input);
        });
        closing = runtime.close({ handle: first, reason: "reset", discardPersistentState: true });
        void closing.catch(() => {});
        await started.promise;
        await runtime.prepareFreshSession(target);
        fresh = await runtime.ensureSession(target);
        if (!fresh.acpxRecordId) {
          throw new Error("Successor physical record ID is missing");
        }
        const freshRecord = await store.load(fresh.acpxRecordId);
        const identity = readAcpxProcessLeaseIdentity(freshRecord?.agentArgv);
        if (!identity || !freshRecord?.pid) {
          throw new Error("Successor leased wrapper is missing");
        }
        const freshPid = freshRecord.pid;
        expect(identity.leaseId).not.toBe(oldIdentity?.leaseId);
        expect(() => process.kill(freshPid, 0)).not.toThrow();

        release.resolve();
        await closing;

        expect(() => process.kill(freshPid, 0)).not.toThrow();
        expect(await leases.load(identity.leaseId)).toMatchObject({
          rootPid: freshRecord.pid,
          state: "open",
        });
        const turn = runtime.startTurn({
          handle: fresh,
          text: "survived",
          mode: "prompt",
          requestId: "survived",
        });
        const text: string[] = [];
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            text.push(event.text);
          }
        }
        expect(await turn.result).toMatchObject({ status: "completed" });
        expect(JSON.parse(text.join(""))).toMatchObject({
          sessionId: fresh.backendSessionId,
          history: ["survived"],
        });
      } finally {
        release.resolve();
        await Promise.allSettled(closing ? [closing] : []);
        vi.restoreAllMocks();
        if (fresh) {
          await runtime.close({ handle: fresh, reason: "test-complete" }).catch(() => {});
        }
        await runtime.shutdown();
      }
    });
  },
);
