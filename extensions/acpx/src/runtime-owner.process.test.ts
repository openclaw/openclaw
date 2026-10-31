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
const ownerConfig = (owners = ["main"], global = false) => ({
  agents: {
    ownership: "explicit" as const,
    entries: Object.fromEntries(owners.map((owner) => [owner, {}] as const)),
  },
  ...(global ? { session: { scope: "global" as const } } : {}),
  acp: { backend: "acpx" },
});

const initialize = async (manager: Manager, target: Target, mode: "persistent" | "oneshot") =>
  (await manager.initializeSession({ ...target, agent: harness, mode })).handle;
const discard = (manager: Manager, target: Target, reason: string, requireAcpSession?: boolean) =>
  manager.closeSession({
    ...target,
    reason,
    requireAcpSession,
    discardPersistentState: true,
    clearMeta: true,
  });
const readPeer = async (directory: string, sessionId: string) =>
  JSON.parse(await fs.readFile(path.join(directory, `${sessionId}.json`), "utf8"));

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
        const target = { cfg, sessionKey: "agent:main:acp:cold", agentId: "main" };
        try {
          const handle = await initialize(manager, target, "oneshot");
          const readOriginal = () => readPeer(directory, handle.backendSessionId!);
          const expectUnprompted = async () => {
            expect(await readOriginal()).toMatchObject({ history: [] });
            expect((await readAcpSessionEntryAsync(target))?.acp?.identity).toMatchObject({
              acpxRecordId: handle.acpxRecordId,
            });
            expect((await store.load(handle.acpxRecordId!))?.lastPromptAt).toBeUndefined();
          };
          await expectUnprompted();
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
          await expectUnprompted();
          const reply = await prompt(manager, target, state.workspaceDir, "first", "cold");
          expect(reply).toMatchObject({ history: ["first"] });
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
          expect(await readOriginal()).toMatchObject({ history: loadSession ? ["first"] : [] });
        } finally {
          await discard(manager, target, "test-cleanup", false);
        }
      },
      async () => ({ args: !loadSession ? ["--no-session-load"] : [] }),
      ownerConfig(["main", "work", "helper"]),
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
          const readWorkState = () => readPeer(directory, handles[1]!.backendSessionId!);
          const workState = await readWorkState();
          for (const handle of handles) {
            expect(await manager.getSessionStatus(target(handle.agentId))).toMatchObject({
              agentId: handle.agentId,
              sessionKey: handle.sessionKey,
              identity: { acpxRecordId: handle.acpxRecordId },
            });
            expect(readAcpSessionEntry(target(handle.agentId))?.storeSessionKey).toBe(
              handle.sessionKey,
            );
            expect(await turn(handle, `${handle.agentId}-second`)).toMatchObject({
              history: [`${handle.agentId}-first`, `${handle.agentId}-second`],
              tone: "brief",
              mode: "review",
            });
            expect((await store.load(handle.acpxRecordId!))?.messages.length).toBeGreaterThan(0);
            if (handle.agentId === "main") {
              expect(await readWorkState()).toEqual(workState);
            }
            await discard(manager, target(handle.agentId), "reset");
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
      ownerConfig(["main", "work"], true),
    );
  },
);

it("continues a completed oneshot in the same conversation after restart", async (context) => {
  await withOwner(
    context,
    "acpx-completed-oneshot-process",
    async ({ state, cfg, restart, manager: initialManager }) => {
      let manager = initialManager;
      const target = { cfg, sessionKey: "agent:main:acp:continued", agentId: "main" };
      await initialize(manager, target, "oneshot");
      try {
        const first = await prompt(manager, target, state.workspaceDir, "first", "continued");
        expect(first.history).toEqual(["first"]);
        expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
        manager = await restart();
        const second = await prompt(manager, target, state.workspaceDir, "second", "continued");
        expect(second).toMatchObject({
          sessionId: first.sessionId,
          history: ["first", "second"],
        });
        expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
      } finally {
        await expect(discard(manager, target, "test-cleanup", false)).resolves.toMatchObject({
          runtimeClosed: true,
          metaCleared: true,
        });
      }
      expect((await readAcpSessionEntryAsync(target))?.acp).toBeUndefined();
    },
  );
});
