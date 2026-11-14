import assert from "node:assert/strict";
import {
  AcpxRuntime as BaseAcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAcpxPluginConfig } from "./config.js";
import { readAcpxProcessLeaseIdentity } from "./process-lease.js";
import {
  createTestGate,
  fixtureSession,
  ownerAgentScript as script,
  promptJson,
  prepareTestWrappers,
  testProcessLeases,
  withProcessRuntime,
} from "./runtime-process.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginStateStoreForTests();
});

it.skipIf(process.platform === "win32").each([false, true])(
  "keeps a live successor wrapper after delayed close (snapshot has PID=%s)",
  async (keepPid) => {
    let leases: Awaited<ReturnType<typeof testProcessLeases>>;
    await withProcessRuntime(
      "acpx-close-lease-overlap",
      async ({ runtime, store }) => {
        const target = { ...fixtureSession("leased-reset"), agentId: "main", agent: "codex" };
        const gate = createTestGate();
        let closing: Promise<void> | undefined;
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
          const fresh = await runtime.ensureSession(target);
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
        }
      },
      async (state) => {
        const config = await prepareTestWrappers(
          state.root,
          resolveAcpxPluginConfig({
            rawConfig: {
              agents: { codex: { command: process.execPath, args: [script, state.path("peer")] } },
            },
            workspaceDir: state.root,
          }),
        );
        leases = await testProcessLeases(state);
        return {
          sessionStore: createFileSessionStore({ stateDir: config.stateDir }),
          agentRegistry: createAgentRegistry({ overrides: config.agents }),
          openclawWrapperRoot: state.path("acpx"),
          openclawGatewayInstanceId: "close-overlap",
          openclawProcessLeaseStore: leases,
        };
      },
    );
  },
);
