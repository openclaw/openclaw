import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpxRuntime as BaseAcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { AcpxRuntime } from "./runtime.js";

const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));

it.each([
  "session",
  "bridge",
  "catalog",
  "openclaw-direct",
  ...(process.platform === "win32" ? [] : ["env-bridge"]),
])("scopes MCP at the real ACP boundary across reconnect (%s)", async (scenario) => {
  const bridge = scenario === "bridge" || scenario === "env-bridge";
  const catalog = scenario === "catalog";
  const agent = scenario === "openclaw-direct" ? "openclaw" : "fixture";
  await withOpenClawTestState({ label: "acpx-mcp-process" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const wrapper = path.join(state.root, "openclaw.mjs");
    await fs.writeFile(
      wrapper,
      `process.argv.splice(2, 1); await import(${JSON.stringify(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url).href)});`,
    );
    const directCommand = [process.execPath, peer, directory];
    const bridgeCommand = [process.execPath, wrapper, "acp", directory];
    const command =
      scenario === "env-bridge"
        ? ["env", "OPENCLAW_HIDE_BANNER=1", ...bridgeCommand]
        : bridge
          ? bridgeCommand
          : directCommand;
    const servers = ["openclaw-plugin-tools", "openclaw-tools", "user-server"].map((name) => ({
      name,
      command: process.execPath,
      args: ["server.mjs"],
      env: [],
    }));
    const store = createFileSessionStore({ stateDir: state.root });
    const createRuntime = (configuredCommand = command) =>
      new AcpxRuntime({
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({ overrides: { [agent]: configuredCommand } }),
        pluginToolsMcpBridgeEnabled: true,
        openclawToolsMcpBridgeEnabled: true,
        mcpServers: servers,
        permissionMode: "deny-all",
        timeoutMs: 5000,
      });
    let runtime = createRuntime();
    const handles: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>[] = [];
    try {
      for (const agentId of ["main", "work"]) {
        const handle = await runtime.ensureSession({
          sessionKey: "shared",
          agentId,
          agent,
          mode: catalog ? "oneshot" : "persistent",
          bridgeSession: catalog ? null : undefined,
        });
        handles.push(handle);
      }
      const prompt = async (handle: (typeof handles)[number]) => {
        const turn = runtime.startTurn({
          handle,
          text: "show context",
          mode: "prompt",
          requestId: handle.agentId!,
        });
        let text = "";
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            text += event.text;
          }
        }
        expect(await turn.result).toMatchObject({ status: "completed" });
        return JSON.parse(text);
      };
      const verify = async (reconnected = false) => {
        const results = await Promise.all(handles.map(prompt));
        for (const [index, result] of results.entries()) {
          expect(reconnected ? result.loadedMcpServers : result.mcpServers).toEqual(
            bridge || catalog
              ? []
              : servers.map((server) =>
                  server.name === "user-server"
                    ? server
                    : Object.assign({}, server, {
                        args: [...server.args, "--openclaw-agent-id", handles[index]!.agentId],
                        env: [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: "shared" }],
                      }),
                ),
          );
        }
      };
      await verify();
      for (const handle of handles) {
        await runtime.close({ handle, reason: "restart" });
      }
      runtime = createRuntime(bridge ? directCommand : bridgeCommand);
      for (const handle of handles) {
        await runtime.setMode({ handle, mode: "review" });
        await runtime.setConfigOption({ handle, key: "tone", value: "brief" });
      }
      await verify(true);
    } finally {
      for (const handle of handles) {
        await runtime.close({ handle, reason: "test-complete", discardPersistentState: true });
      }
    }
  });
});

it("finishes an admitted discard after reset retires its pending snapshot", async () => {
  await withOpenClawTestState({ label: "acpx-discard-snapshot" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const store = createFileSessionStore({ stateDir: state.root });
    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer, directory] },
      }),
      permissionMode: "deny-all",
      timeoutMs: 5000,
    });
    const target = { sessionKey: "discard-snapshot", agentId: "main" };
    await runtime.prepareFreshSession(target);
    const handle = await runtime.ensureSession({ ...target, agent: "fixture", mode: "persistent" });
    const shutdown = vi.spyOn(BaseAcpxRuntime.prototype, "shutdown");
    const snapshotStarted = createDeferred<void>();
    const releaseSnapshot = createDeferred<void>();
    const load = store.load.bind(store);
    const loadSpy = vi.spyOn(store, "load").mockImplementationOnce(async (key) => {
      snapshotStarted.resolve();
      await releaseSnapshot.promise;
      return load(key);
    });
    const closing = runtime.close({ handle, reason: "discard", discardPersistentState: true });
    void closing.catch(() => {});
    try {
      await snapshotStarted.promise;
      await runtime.prepareFreshSession(target);
      expect(shutdown).not.toHaveBeenCalled();
      releaseSnapshot.resolve();
      await closing;
      const persisted = await load(handle.acpxRecordId!);
      expect(persisted?.closed).toBe(true);
      expect(persisted?.acpx?.reset_on_next_ensure).toBe(true);
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled([closing]);
      loadSpy.mockRestore();
      shutdown.mockRestore();
      await runtime.shutdown();
    }
  });
});

it("cleans up real initialization that completes after reset", async () => {
  await withOpenClawTestState({ label: "acpx-superseded-initialization" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const store = createFileSessionStore({ stateDir: state.root });
    let exited = false;
    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer, directory] },
      }),
      permissionMode: "deny-all",
      timeoutMs: 5000,
      processLifecycle: {
        onExit: () => {
          exited = true;
        },
      },
    });
    const saveStarted = createDeferred<void>();
    const releaseSave = createDeferred<void>();
    const save = store.save.bind(store);
    const saveSpy = vi.spyOn(store, "save").mockImplementationOnce(async (record) => {
      saveStarted.resolve();
      await releaseSave.promise;
      await save(record);
    });
    const target = { sessionKey: "superseded-initialization", agentId: "main" };
    const initializing = runtime.ensureSession({ ...target, agent: "fixture", mode: "persistent" });
    void initializing.catch(() => {});
    try {
      await saveStarted.promise;
      expect(exited).toBe(false);
      await runtime.prepareFreshSession(target);
      releaseSave.resolve();
      await expect(initializing).rejects.toThrow("superseded by reset");
      expect(exited).toBe(true);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      releaseSave.resolve();
      await Promise.allSettled([initializing]);
      saveSpy.mockRestore();
      await runtime.shutdown();
    }
  });
});

it.each([false, true])(
  "keeps controls attached to distinct oneshot records (discard: %s)",
  async (discardPersistentState) => {
    const promptBlocked = createDeferred<void>();
    const releasePrompt = createDeferred<void>();
    await withServer(
      (_request, response) => {
        promptBlocked.resolve();
        void releasePrompt.promise.then(() => response.end("released"));
      },
      async (promptGateUrl) => {
        await withOpenClawTestState({ label: "acpx-oneshot-custody" }, async (state) => {
          const directory = path.join(state.root, "peer");
          await fs.mkdir(directory);
          const store = createFileSessionStore({ stateDir: state.root });
          const runtime = new AcpxRuntime({
            cwd: state.root,
            sessionStore: store,
            agentRegistry: createAgentRegistry({
              overrides: {
                fixture: [process.execPath, peer, directory, `--prompt-gate-url=${promptGateUrl}`],
              },
            }),
            permissionMode: "deny-all",
            timeoutMs: 5000,
          });
          const target = {
            sessionKey: "shared-oneshot",
            agentId: "main",
            agent: "fixture",
            mode: "oneshot" as const,
          };
          await runtime.prepareFreshSession(target);
          const first = await runtime.ensureSession(target);
          const shutdown = vi.spyOn(BaseAcpxRuntime.prototype, "shutdown");
          const saveStarted = createDeferred<void>();
          const releaseSave = createDeferred<void>();
          const save = store.save.bind(store);
          let held = false;
          let promptAdmitted = false;
          const saveSpy = vi.spyOn(store, "save").mockImplementation(async (record) => {
            if (
              promptAdmitted &&
              !held &&
              record.acpxRecordId === first.acpxRecordId &&
              record.messages.length > 0
            ) {
              held = true;
              saveStarted.resolve();
              await releaseSave.promise;
            }
            await save(record);
          });
          const turn = runtime.startTurn({
            handle: first,
            text: "first turn",
            mode: "prompt",
            requestId: "first",
          });
          const events = (async () => {
            for await (const ignoredEventValue of turn.events) {
              // Drain the real adapter while its persistence checkpoint is held.
              void ignoredEventValue;
            }
          })();
          void events.catch(() => {});
          let turnFinished = false;
          void turn.result.then(
            () => {
              turnFinished = true;
            },
            () => {
              turnFinished = true;
            },
          );
          let second: typeof first | undefined;
          let cancellation: Promise<void> | undefined;
          try {
            await turn.promptStarted;
            promptAdmitted = true;
            // Terminal persistence owns ACPX's record lock; these controls need a live prompt.
            await Promise.all([promptBlocked.promise, saveStarted.promise]);
            second = await runtime.ensureSession(target);
            expect(second.acpxRecordId).not.toBe(first.acpxRecordId);
            expect((await runtime.getStatus({ handle: first })).backendSessionId).toBe(
              first.backendSessionId,
            );
            cancellation = runtime.cancel({ handle: first, reason: "only first" });
            void cancellation.catch(() => {});
            await cancellation;
            await runtime.close({
              handle: first,
              reason: "first complete",
              discardPersistentState,
            });
            expect(turnFinished).toBe(false);
            expect(shutdown).not.toHaveBeenCalled();
            releaseSave.resolve();
            releasePrompt.resolve();
            await Promise.all([events, turn.result]);
            expect((await runtime.getStatus({ handle: second })).backendSessionId).toBe(
              second.backendSessionId,
            );
            await runtime.close({ handle: second, reason: "second complete" });
            expect(shutdown).toHaveBeenCalledOnce();
            await shutdown.mock.results[0]!.value;
          } finally {
            releaseSave.resolve();
            releasePrompt.resolve();
            await Promise.allSettled([
              events,
              turn.result,
              ...(cancellation ? [cancellation] : []),
            ]);
            saveSpy.mockRestore();
            shutdown.mockRestore();
            await runtime.shutdown();
          }
        });
      },
    );
  },
);

it("creates a fresh oneshot while an old physical record write is still pending", async () => {
  await withOpenClawTestState({ label: "acpx-oneshot-write-isolation" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const store = createFileSessionStore({ stateDir: state.root });
    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer, directory] },
      }),
      permissionMode: "deny-all",
      timeoutMs: 5000,
    });
    const target = {
      sessionKey: "oneshot-write-isolation",
      agentId: "main",
      agent: "fixture",
      mode: "oneshot" as const,
    };
    const first = await runtime.ensureSession(target);
    const saveStarted = createDeferred<void>();
    const releaseSave = createDeferred<void>();
    const save = store.save.bind(store);
    let held = false;
    let promptAdmitted = false;
    const saveSpy = vi.spyOn(store, "save").mockImplementation(async (record) => {
      if (
        promptAdmitted &&
        !held &&
        record.acpxRecordId === first.acpxRecordId &&
        record.messages.length > 0
      ) {
        held = true;
        saveStarted.resolve();
        await releaseSave.promise;
      }
      await save(record);
    });
    const turn = runtime.startTurn({
      handle: first,
      text: "old turn",
      mode: "prompt",
      requestId: "old",
    });
    const events = (async () => {
      for await (const ignoredEventValue of turn.events) {
        // Drain the real adapter while its physical record checkpoint is held.
        void ignoredEventValue;
      }
    })();
    void events.catch(() => {});
    void turn.result.catch(() => {});
    let creating: Promise<typeof first> | undefined;
    let fresh: typeof first | undefined;
    try {
      await turn.promptStarted;
      promptAdmitted = true;
      await saveStarted.promise;
      await runtime.prepareFreshSession(target);
      creating = runtime.ensureSession(target).then((handle) => {
        fresh = handle;
        return handle;
      });
      void creating.catch(() => {});
      await vi.waitFor(() => expect(fresh).toBeDefined(), { timeout: 5000 });
      expect(fresh?.acpxRecordId).not.toBe(first.acpxRecordId);
      releaseSave.resolve();
      await Promise.all([events, turn.result]);
      const handle = await creating;
      expect((await runtime.getStatus({ handle })).backendSessionId).toBe(handle.backendSessionId);
      await runtime.close({ handle, reason: "fresh complete" });
    } finally {
      releaseSave.resolve();
      await Promise.allSettled([events, turn.result, ...(creating ? [creating] : [])]);
      saveSpy.mockRestore();
      await runtime.shutdown();
    }
  });
});
