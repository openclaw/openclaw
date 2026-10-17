import fs from "node:fs/promises";
import path from "node:path";
import { decodeAcpxRuntimeHandleState } from "acpx/runtime";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  testing,
  readAcpSessionEntry,
  readAcpSessionEntryAsync,
} from "openclaw/plugin-sdk/acp-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, expect, it, type TestContext } from "vitest";
import {
  mcpServers,
  withProcessRuntime,
  type RuntimeHandle,
  type OwnerRuntimeOptions,
} from "./runtime-process.test-support.js";

const harness = "owner-fixture";
const fixtureRuns = new WeakMap<TestContext, Promise<void>>();
type Manager = ReturnType<typeof getAcpSessionManager>;
type Target = Pick<Parameters<Manager["runTurn"]>[0], "cfg" | "sessionKey" | "agentId">;
type ProcessFixture = Parameters<Parameters<typeof withProcessRuntime>[1]>[0];
const ownerConfig = (global = false, cold = false) => ({
  agents: {
    ownership: "explicit" as const,
    entries: {
      main: {},
      ...(global || cold ? { work: {} } : {}),
      ...(cold ? { helper: {} } : {}),
    },
  },
  ...(global ? { session: { scope: "global" as const } } : {}),
  acp: { backend: "acpx" },
});

const initialize = async (manager: Manager, target: Target, mode: "persistent" | "oneshot") =>
  (await manager.initializeSession({ ...target, agent: harness, mode })).handle;

function withOwner(
  context: TestContext,
  label: string,
  run: (
    fixture: ProcessFixture & {
      cfg: ReturnType<typeof ownerConfig>;
      manager: Manager;
      restart: () => Promise<Manager>;
    },
  ) => Promise<void>,
  options: (state: OpenClawTestState) => Promise<OwnerRuntimeOptions> = async () => ({}),
  cfg = ownerConfig(),
) {
  const runPromise = withProcessRuntime(
    label,
    async (fixture) => {
      let runtime = fixture.runtime;
      const register = () => {
        registerAcpRuntimeBackend({ id: "acpx", runtime });
        testing.resetAcpSessionManagerForTests();
        return getAcpSessionManager();
      };
      const restart = async () => {
        await runtime.shutdown();
        runtime = fixture.create(await options(fixture.state));
        return register();
      };
      try {
        await run({ ...fixture, cfg, manager: register(), restart });
      } finally {
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend("acpx");
      }
    },
    async (state) => {
      await state.writeConfig(cfg);
      return { agent: harness, ...(await options(state)) };
    },
  );
  fixtureRuns.set(context, runPromise);
  return runPromise;
}

async function prompt(
  manager: Manager,
  target: Target,
  workspaceDir: string,
  text: string,
  sessionId: string,
  requestId = text,
  admissionSessionKey = target.sessionKey,
) {
  const admission = await createAdmittedHostCapabilityTestFixture({
    config: target.cfg,
    runId: requestId,
    agentId: target.agentId,
    sessionId,
    sessionKey: admissionSessionKey,
    workspaceDir,
    abortSignal: new AbortController().signal,
  });
  const chunks: string[] = [];
  try {
    await manager.runTurn({
      ...target,
      admittedRunContext: admission.admittedRunContext,
      provenance: "human",
      text,
      mode: "prompt",
      requestId,
      onEvent(event) {
        if (event.type === "text_delta") {
          chunks.push(event.text);
        }
      },
    });
  } finally {
    admission.closeHost();
    admission.closeAdmission();
  }
  return JSON.parse(chunks.join(""));
}

it.for([true, false])(
  "runs the first cold oneshot turn (load support: %s)",
  async (loadSession, context) => {
    await withOwner(
      context,
      "acpx-cold-oneshot-process",
      async ({ state, cfg, directory, store, restart, manager: initialManager }) => {
        let manager = initialManager;
        const target = { cfg, sessionKey: "agent:main:acp:cold-first-turn", agentId: "main" };
        try {
          const handle = await initialize(manager, target, "oneshot");
          expect(handle.backendSessionId).toBeTruthy();
          const peerPath = path.join(directory, `${handle.backendSessionId}.json`);
          const readPeer = async () => JSON.parse(await fs.readFile(peerPath, "utf8"));
          expect(await readPeer()).toMatchObject({ history: [] });
          const before = await readAcpSessionEntryAsync(target);
          expect(before?.acp?.identity).toMatchObject({
            acpxRecordId: handle.acpxRecordId,
          });
          expect((await store.load(handle.acpxRecordId!))?.lastPromptAt).toBeUndefined();
          await expect(
            manager.closeSession({
              ...target,
              reason: "test-restart",
              discardPersistentState: false,
              clearMeta: false,
            }),
          ).resolves.toMatchObject({ runtimeClosed: true, metaCleared: false });
          expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
          manager = await restart();
          expect(await readPeer()).toMatchObject({ history: [] });
          expect((await readAcpSessionEntryAsync(target))?.acp?.identity).toMatchObject({
            acpxRecordId: handle.acpxRecordId,
          });
          expect((await store.load(handle.acpxRecordId!))?.lastPromptAt).toBeUndefined();
          const text = "cold-oneshot-first-prompt";
          const reply = await prompt(
            manager,
            target,
            state.workspaceDir,
            text,
            "cold-oneshot-core-session",
          );
          expect(reply).toMatchObject({ history: [text] });
          if (loadSession) {
            expect(reply.sessionId).toBe(handle.backendSessionId);
          } else {
            expect(reply.sessionId).not.toBe(handle.backendSessionId);
          }
          expect((await fs.readdir(directory)).toSorted()).toEqual(
            [...new Set([handle.backendSessionId, reply.sessionId])]
              .map((id) => `${id}.json`)
              .toSorted(),
          );
          expect(await readPeer()).toMatchObject({ history: loadSession ? [text] : [] });
        } finally {
          await manager.closeSession({
            ...target,
            reason: "test-cleanup",
            requireAcpSession: false,
            discardPersistentState: true,
            clearMeta: true,
          });
        }
      },
      async () => ({ args: !loadSession ? ["--no-session-load"] : [] }),
      ownerConfig(false, true),
    );
  },
);

beforeAll(async () => {
  // Load the lazy host-test runtime before any case registers its ACP backend.
  const admission = await createAdmittedHostCapabilityTestFixture({ runId: "acpx-owner-setup" });
  admission.closeHost();
  admission.closeAdmission();
});

afterEach(async (context) => {
  // Join timed-out cases before shared hooks reset plugin state, preserving the test failure.
  const run = fixtureRuns.get(context);
  fixtureRuns.delete(context);
  await run?.catch(() => {});
});

it.for(["global", "shared-project"])(
  "isolates real ACPX histories for two owners of %s across restart and controls",
  async (sessionKey, context) => {
    await withOwner(
      context,
      "acpx-owner-process",
      async ({ state, cfg, directory, store, restart, manager: initialManager }) => {
        let manager = initialManager;
        const handles: RuntimeHandle[] = [];
        const target = (agentId?: string) => ({ cfg, sessionKey, agentId });
        const turn = (handle: RuntimeHandle, text: string) =>
          prompt(
            manager,
            target(handle.agentId),
            state.workspaceDir,
            text,
            `${handle.agentId}-session`,
            text,
            handle.sessionKey,
          );
        try {
          for (const agentId of ["main", "work"]) {
            const handle = await initialize(manager, target(agentId), "persistent");
            handles.push(handle);
            const expectedSessionKey =
              sessionKey === "global" ? sessionKey : `agent:${agentId}:${sessionKey}`;
            expect(handle).toMatchObject({ sessionKey: expectedSessionKey, agentId });
            expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.name).toBe(
              handle.acpxRecordId,
            );
            const first = await turn(handle, `${agentId}-first`);
            expect(first).toMatchObject({ history: [`${agentId}-first`] });
            expect(first.mcpServers).toEqual(mcpServers(agentId, expectedSessionKey));
            await manager.setSessionRuntimeMode({ ...target(agentId), runtimeMode: "review" });
            await manager.setSessionConfigOption({
              ...target(agentId),
              key: "tone",
              value: "brief",
            });
            const beforeCancel = await store.load(handle.acpxRecordId!);
            await manager.cancelSession(target(agentId));
            expect((await store.load(handle.acpxRecordId!))?.pid).toBe(beforeCancel?.pid);
            expect(() => process.kill(beforeCancel!.pid!, 0)).not.toThrow();
            await manager.getSessionStatus(target(agentId));
            await manager.closeSession({ ...target(agentId), reason: "restart" });
          }
          expect(handles[0]!.acpxRecordId).not.toBe(handles[1]!.acpxRecordId);
          expect(handles[0]!.backendSessionId).not.toBe(handles[1]!.backendSessionId);
          manager = await restart();
          const readWorkState = async (): Promise<unknown> =>
            JSON.parse(
              await fs.readFile(
                path.join(directory, `${handles[1]!.backendSessionId}.json`),
                "utf8",
              ),
            );
          const workState = await readWorkState();
          for (const previous of handles) {
            const resumed = await manager.getSessionStatus(target(previous.agentId));
            expect(resumed).toMatchObject({
              agentId: previous.agentId,
              sessionKey: previous.sessionKey,
              identity: { acpxRecordId: previous.acpxRecordId },
            });
            const handle = previous;
            expect(readAcpSessionEntry(target(handle.agentId))?.storeSessionKey).toBe(
              handle.sessionKey,
            );
            const result = await turn(handle, `${handle.agentId}-second`);
            expect(result).toMatchObject({
              history: [`${handle.agentId}-first`, `${handle.agentId}-second`],
              tone: "brief",
              mode: "review",
            });
            expect((await store.load(handle.acpxRecordId!))?.messages.length).toBeGreaterThan(0);
            if (handle.agentId === "main") {
              expect(await readWorkState()).toEqual(workState);
            }
            await manager.closeSession({
              ...target(handle.agentId),
              reason: "reset",
              discardPersistentState: true,
              clearMeta: true,
            });
            const fresh = await initialize(manager, target(handle.agentId), "persistent");
            expect(await turn(fresh, "fresh")).toMatchObject({ history: ["fresh"] });
            await manager.closeSession({ ...target(fresh.agentId), reason: "test-complete" });
            if (handle.agentId === "main") {
              expect(await readWorkState()).toEqual(workState);
            }
          }
        } finally {
          for (const handle of handles) {
            await manager
              .closeSession({
                ...target(handle.agentId),
                reason: "test-cleanup",
                requireAcpSession: false,
              })
              .catch(() => {});
          }
        }
      },
      async ({ root }) => {
        const sessions = path.join(root, "sessions");
        await fs.mkdir(sessions, { recursive: true });
        return {
          openclawLegacyBareSessionKeys: new Set(
            (await fs.readdir(sessions))
              .filter((name) => name.endsWith(".json"))
              .map((name) => decodeURIComponent(name.slice(0, -5))),
          ),
          pluginToolsMcpBridgeEnabled: true,
          openclawToolsMcpBridgeEnabled: true,
          mcpServers: mcpServers(),
        };
      },
      ownerConfig(true),
    );
  },
);

it("closes a completed oneshot without mixing its replacement record identity", async (context) => {
  await withOwner(
    context,
    "acpx-oneshot-owner-process",
    async ({ state, cfg, runtime, manager }) => {
      const target = { cfg, sessionKey: "agent:main:acp:oneshot-record", agentId: "main" };
      const handle = await initialize(manager, target, "oneshot");
      expect(
        await prompt(
          manager,
          target,
          state.workspaceDir,
          "oneshot-owned-history",
          "oneshot-core-session",
          "oneshot-record",
        ),
      ).toMatchObject({ history: ["oneshot-owned-history"] });
      expect(readAcpSessionEntry(target)?.acp?.identity).toMatchObject({
        state: "resolved",
        acpxRecordId: handle.acpxRecordId,
      });
      expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
      const replacement = await runtime.ensureSession({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        agent: harness,
        mode: "oneshot",
        persistedHandle: handle,
      });
      try {
        expect(replacement.backendSessionId).not.toBe(handle.backendSessionId);
      } finally {
        await runtime.close({
          handle: replacement,
          reason: "completed-oneshot-replacement",
          discardPersistentState: true,
        });
      }
      await expect(
        manager.closeSession({
          ...target,
          reason: "oneshot-delete",
          discardPersistentState: true,
          clearMeta: true,
        }),
      ).resolves.toMatchObject({ runtimeClosed: true, metaCleared: true });
      expect(readAcpSessionEntry(target)?.acp).toBeUndefined();
    },
  );
});
