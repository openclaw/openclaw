import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  AcpxRuntime as BaseAcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";
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
import {
  createTestGate,
  fixtureSession,
  ownerAgentScript as script,
  ownerRuntimeOptions,
  promptJson,
} from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginStateStoreForTests();
});

it.skipIf(process.platform === "win32").each([false, true])(
  "keeps a live successor wrapper after delayed close (snapshot has PID=%s)",
  async (keepPid) => {
    await withOpenClawTestState({ label: "acpx-close-lease-overlap" }, async (state) => {
      const peerDirectory = state.path("peer");
      const codexHome = state.path("empty-codex-home");
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
      const runtime = new AcpxRuntime(
        ownerRuntimeOptions(state.root, {
          sessionStore: store,
          agentRegistry: createAgentRegistry({ overrides: config.agents }),
          openclawWrapperRoot: state.path("acpx"),
          openclawGatewayInstanceId: "close-overlap",
          openclawProcessLeaseStore: leases,
        }),
      );
      const target = { ...fixtureSession("leased-reset"), agentId: "main", agent: "codex" };
      const gate = createTestGate();
      let closing: Promise<void> | undefined;
      let fresh: Awaited<ReturnType<AcpxRuntime["ensureSession"]>> | undefined;
      try {
        const first = await runtime.ensureSession(target);
        assert.ok(first.acpxRecordId, "Initial physical record ID is missing");
        const oldRecord = await store.load(first.acpxRecordId);
        assert.ok(oldRecord, "Initial leased session record is missing");
        const oldIdentity = readAcpxProcessLeaseIdentity(oldRecord.agentArgv);
        expect(oldIdentity?.gatewayInstanceId).toBe("close-overlap");
        if (!keepPid) {
          // A stopped ACPX record can retain its physical lease without its PID.
          await store.save({ ...oldRecord, pid: undefined });
        }
        const close = vi.spyOn(BaseAcpxRuntime.prototype, "close");
        close.mockImplementation(async function (this: BaseAcpxRuntime, input) {
          if (input.handle.backendSessionId === first.backendSessionId) {
            await gate.hold();
          }
          close.mockRestore();
          return await BaseAcpxRuntime.prototype.close.call(this, input);
        });
        closing = runtime.close({ handle: first, reason: "reset", discardPersistentState: true });
        void closing.catch(() => {});
        await gate.entered;
        await runtime.prepareFreshSession(target);
        fresh = await runtime.ensureSession(target);
        assert.ok(fresh.acpxRecordId, "Successor physical record ID is missing");
        const freshRecord = await store.load(fresh.acpxRecordId);
        const identity = readAcpxProcessLeaseIdentity(freshRecord?.agentArgv);
        assert.ok(identity && freshRecord?.pid, "Successor leased wrapper is missing");
        const freshPid = freshRecord.pid;
        expect(identity.leaseId).not.toBe(oldIdentity?.leaseId);
        expect(() => process.kill(freshPid, 0)).not.toThrow();

        gate.release();
        await closing;

        expect(() => process.kill(freshPid, 0)).not.toThrow();
        expect(await leases.load(identity.leaseId)).toMatchObject({
          rootPid: freshRecord.pid,
          state: "open",
        });
        expect(await promptJson(runtime, fresh, "survived")).toMatchObject({
          sessionId: fresh.backendSessionId,
          history: ["survived"],
        });
      } finally {
        await gate.settle(closing);
        vi.restoreAllMocks();
        if (fresh) {
          await runtime.close({ handle: fresh, reason: "test-complete" }).catch(() => {});
        }
        await runtime.shutdown();
      }
    });
  },
);
