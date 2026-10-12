import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
} from "acpx/runtime";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  testing,
  readAcpSessionEntry,
  readAcpSessionEntryAsync,
} from "openclaw/plugin-sdk/acp-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, expect, it, type TestContext } from "vitest";
import { AcpxRuntime } from "./runtime.js";

const harness = "owner-fixture";
const script = fileURLToPath(
  new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url),
);
const fixtureRuns = new WeakMap<TestContext, Promise<void>>();

it.for([true, false])(
  "runs the first cold oneshot turn (load support: %s)",
  async (loadSession, context) => {
    const run = withOpenClawTestState({ label: "acpx-cold-oneshot-process" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {}, work: {}, helper: {} } },
        acp: { backend: "acpx" },
      };
      await state.writeConfig(cfg);
      const peerDirectory = path.join(state.root, "peer");
      await fs.mkdir(peerDirectory);
      const store = createFileSessionStore({ stateDir: state.root });
      const createRuntime = () =>
        new AcpxRuntime({
          cwd: state.root,
          sessionStore: store,
          agentRegistry: createAgentRegistry({
            overrides: {
              [harness]: [
                process.execPath,
                script,
                peerDirectory,
                ...(!loadSession ? ["--no-session-load"] : []),
              ],
            },
          }),
          permissionMode: "deny-all",
          timeoutMs: 5_000,
        });
      let runtime = createRuntime();
      registerAcpRuntimeBackend({ id: "acpx", runtime });
      testing.resetAcpSessionManagerForTests();
      let manager = getAcpSessionManager();
      const target = { cfg, sessionKey: "agent:main:acp:cold-first-turn", agentId: "main" };
      try {
        const { handle } = await manager.initializeSession({
          ...target,
          agent: harness,
          mode: "oneshot",
        });
        expect(handle.backendSessionId).toBeTruthy();
        const peerPath = path.join(peerDirectory, `${handle.backendSessionId}.json`);
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
        await runtime.shutdown();
        testing.resetAcpSessionManagerForTests();
        runtime = createRuntime();
        registerAcpRuntimeBackend({ id: "acpx", runtime });
        manager = getAcpSessionManager();
        expect(await readPeer()).toMatchObject({ history: [] });
        expect((await readAcpSessionEntryAsync(target))?.acp?.identity).toMatchObject({
          acpxRecordId: handle.acpxRecordId,
        });
        expect((await store.load(handle.acpxRecordId!))?.lastPromptAt).toBeUndefined();
        const text = "cold-oneshot-first-prompt";
        const admission = await createAdmittedHostCapabilityTestFixture({
          config: cfg,
          runId: text,
          agentId: target.agentId,
          sessionId: "cold-oneshot-core-session",
          sessionKey: target.sessionKey,
          workspaceDir: state.workspaceDir,
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
            requestId: text,
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
        const reply = JSON.parse(chunks.join(""));
        expect(reply).toMatchObject({ history: [text] });
        if (loadSession) {
          expect(reply.sessionId).toBe(handle.backendSessionId);
        } else {
          expect(reply.sessionId).not.toBe(handle.backendSessionId);
        }
        expect((await fs.readdir(peerDirectory)).toSorted()).toEqual(
          [...new Set([handle.backendSessionId, reply.sessionId])]
            .map((id) => `${id}.json`)
            .toSorted(),
        );
        expect(await readPeer()).toMatchObject({ history: loadSession ? [text] : [] });
      } finally {
        try {
          await manager.closeSession({
            ...target,
            reason: "test-cleanup",
            requireAcpSession: false,
            discardPersistentState: true,
            clearMeta: true,
          });
        } finally {
          testing.resetAcpSessionManagerForTests();
          unregisterAcpRuntimeBackend("acpx");
          await runtime.shutdown();
        }
      }
    });
    fixtureRuns.set(context, run);
    await run;
  },
);

beforeAll(async () => {
  // Load the lazy host-test runtime before any case registers its ACP backend.
  const admission = await createAdmittedHostCapabilityTestFixture({ runId: "acpx-owner-setup" });
  admission.closeHost();
  admission.closeAdmission();
});

afterEach(async (context) => {
  // Join timed-out cases before shared afterEach hooks reset plugin state.
  // The test body reports failures; let the remaining cleanup hooks run.
  const run = fixtureRuns.get(context);
  fixtureRuns.delete(context);
  await run?.catch(() => {});
});

it.for(["global", "shared-project"])(
  "isolates real ACPX histories for two owners of %s across restart and controls",
  async (sessionKey, context) => {
    const run = withOpenClawTestState({ label: "acpx-owner-process" }, async (state) => {
      const directory = state.root;
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
        session: { scope: "global" as const },
        acp: { backend: "acpx" },
      };
      await state.writeConfig(cfg);
      const peerDirectory = path.join(directory, "peer");
      await fs.mkdir(peerDirectory);
      await fs.mkdir(path.join(directory, "sessions"));
      const store = createFileSessionStore({ stateDir: directory });
      const createRuntime = async () =>
        new AcpxRuntime({
          cwd: directory,
          sessionStore: store,
          openclawLegacyBareSessionKeys: new Set(
            (await fs.readdir(path.join(directory, "sessions")))
              .filter((name) => name.endsWith(".json"))
              .map((name) => decodeURIComponent(name.slice(0, -5))),
          ),
          agentRegistry: createAgentRegistry({
            overrides: { [harness]: [process.execPath, script, peerDirectory] },
          }),
          pluginToolsMcpBridgeEnabled: true,
          openclawToolsMcpBridgeEnabled: true,
          mcpServers: ["openclaw-plugin-tools", "openclaw-tools", "user-server"].map((name) => ({
            name,
            command: process.execPath,
            args: ["server.mjs"],
            env: [],
          })),
          permissionMode: "deny-all",
          timeoutMs: 5_000,
        });
      let runtime = await createRuntime();
      registerAcpRuntimeBackend({ id: "acpx", runtime });
      testing.resetAcpSessionManagerForTests();
      let manager = getAcpSessionManager();
      const handles: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>[] = [];
      const target = (agentId?: string) => ({ cfg, sessionKey, agentId });
      const turn = async (
        handle: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>,
        text: string,
      ) => {
        const chunks: string[] = [];
        const admission = await createAdmittedHostCapabilityTestFixture({
          config: cfg,
          runId: text,
          agentId: handle.agentId,
          sessionId: `${handle.agentId}-session`,
          sessionKey: handle.sessionKey,
          workspaceDir: state.workspaceDir,
          abortSignal: new AbortController().signal,
        });
        try {
          await manager.runTurn({
            ...target(handle.agentId),
            admittedRunContext: admission.admittedRunContext,
            provenance: "human",
            text,
            mode: "prompt",
            requestId: text,
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
      };
      try {
        for (const agentId of ["main", "work"]) {
          const { handle } = await manager.initializeSession({
            ...target(agentId),
            agent: harness,
            mode: "persistent",
          });
          handles.push(handle);
          const expectedSessionKey =
            sessionKey === "global" ? sessionKey : `agent:${agentId}:${sessionKey}`;
          expect(handle.sessionKey).toBe(expectedSessionKey);
          expect(handle.agentId).toBe(agentId);
          expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.name).toBe(
            handle.acpxRecordId,
          );
          const first = await turn(handle, `${agentId}-first`);
          expect(first).toMatchObject({ history: [`${agentId}-first`] });
          expect(first.mcpServers).toEqual([
            ...["openclaw-plugin-tools", "openclaw-tools"].map((name) => ({
              name,
              command: process.execPath,
              args: ["server.mjs", "--openclaw-agent-id", agentId],
              env: [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: expectedSessionKey }],
            })),
            { name: "user-server", command: process.execPath, args: ["server.mjs"], env: [] },
          ]);
          await manager.setSessionRuntimeMode({ ...target(agentId), runtimeMode: "review" });
          await manager.setSessionConfigOption({ ...target(agentId), key: "tone", value: "brief" });
          const beforeCancel = await store.load(handle.acpxRecordId!);
          await manager.cancelSession(target(agentId));
          expect((await store.load(handle.acpxRecordId!))?.pid).toBe(beforeCancel?.pid);
          expect(() => process.kill(beforeCancel!.pid!, 0)).not.toThrow();
          await manager.getSessionStatus(target(agentId));
          await manager.closeSession({ ...target(agentId), reason: "restart" });
        }
        expect(handles[0]!.acpxRecordId).not.toBe(handles[1]!.acpxRecordId);
        expect(handles[0]!.backendSessionId).not.toBe(handles[1]!.backendSessionId);
        await runtime.shutdown();
        runtime = await createRuntime();
        registerAcpRuntimeBackend({ id: "acpx", runtime });
        testing.resetAcpSessionManagerForTests();
        manager = getAcpSessionManager();
        const readWorkState = async (): Promise<unknown> =>
          JSON.parse(
            await fs.readFile(
              path.join(peerDirectory, `${handles[1]!.backendSessionId}.json`),
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
          const { handle: fresh } = await manager.initializeSession({
            ...target(handle.agentId),
            agent: harness,
            mode: "persistent",
          });
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
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend("acpx");
        await runtime.shutdown();
      }
    });
    fixtureRuns.set(context, run);
    await run;
  },
);

it("closes a completed oneshot without mixing its replacement record identity", async (context) => {
  const run = withOpenClawTestState({ label: "acpx-oneshot-owner-process" }, async (state) => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {} } },
      acp: { backend: "acpx" },
    };
    await state.writeConfig(cfg);
    const peerDirectory = path.join(state.root, "peer");
    await fs.mkdir(peerDirectory);
    const store = createFileSessionStore({ stateDir: state.root });
    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: { [harness]: [process.execPath, script, peerDirectory] },
      }),
      permissionMode: "deny-all",
      timeoutMs: 5_000,
    });
    registerAcpRuntimeBackend({ id: "acpx", runtime });
    testing.resetAcpSessionManagerForTests();
    const manager = getAcpSessionManager();
    const target = { cfg, sessionKey: "agent:main:acp:oneshot-record", agentId: "main" };
    try {
      const { handle } = await manager.initializeSession({
        ...target,
        agent: harness,
        mode: "oneshot",
      });
      const admission = await createAdmittedHostCapabilityTestFixture({
        config: cfg,
        runId: "oneshot-record",
        agentId: target.agentId,
        sessionId: "oneshot-core-session",
        sessionKey: target.sessionKey,
        workspaceDir: state.workspaceDir,
        abortSignal: new AbortController().signal,
      });
      const chunks: string[] = [];
      try {
        await manager.runTurn({
          ...target,
          admittedRunContext: admission.admittedRunContext,
          provenance: "human",
          text: "oneshot-owned-history",
          mode: "prompt",
          requestId: "oneshot-record",
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
      expect(JSON.parse(chunks.join(""))).toMatchObject({ history: ["oneshot-owned-history"] });
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
    } finally {
      testing.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("acpx");
      await runtime.shutdown();
    }
  });
  fixtureRuns.set(context, run);
  await run;
});
