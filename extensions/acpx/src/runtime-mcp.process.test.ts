import fs from "node:fs/promises";
import path from "node:path";
import {
  AcpxRuntime as BaseAcpxRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import {
  ownerAgentScript as peer,
  ownerRuntimeOptions,
  promptJson,
  createTestGate,
  createHeldCall,
  fixtureSession,
  mcpServers,
  withProcessRuntime,
  type RuntimeHandle,
} from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";

function holdCheckpoint(
  runtime: AcpxRuntime,
  store: ReturnType<typeof createFileSessionStore>,
  handle: RuntimeHandle,
  requestId: string,
) {
  const gate = createTestGate();
  const save = store.save.bind(store);
  let held = false;
  let promptAdmitted = false;
  const saveSpy = vi.spyOn(store, "save").mockImplementation(async (record) => {
    if (
      promptAdmitted &&
      !held &&
      record.acpxRecordId === handle.acpxRecordId &&
      record.messages.length > 0
    ) {
      held = true;
      await gate.hold();
    }
    await save(record);
  });
  const turn = runtime.startTurn({ handle, text: `${requestId} turn`, mode: "prompt", requestId });
  const events = (async () => {
    for await (const event of turn.events) {
      void event;
    }
  })();
  void events.catch(() => {});
  const admit = async () => {
    await turn.promptStarted;
    promptAdmitted = true;
  };
  return { turn, events, gate, saveSpy, admit };
}

async function expectSessionStatus(runtime: AcpxRuntime, handle: RuntimeHandle) {
  expect((await runtime.getStatus({ handle })).backendSessionId).toBe(handle.backendSessionId);
}

it.each([process.platform === "win32" ? "bridge" : "env-bridge", "catalog", "openclaw-direct"])(
  "scopes MCP at the real ACP boundary across reconnect (%s)",
  async (scenario) => {
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
      const store = createFileSessionStore({ stateDir: state.root });
      const createRuntime = (configuredCommand = command) =>
        new AcpxRuntime(
          ownerRuntimeOptions(state.root, {
            sessionStore: store,
            agentRegistry: createAgentRegistry({ overrides: { [agent]: configuredCommand } }),
            pluginToolsMcpBridgeEnabled: true,
            openclawToolsMcpBridgeEnabled: true,
            mcpServers: mcpServers(),
          }),
        );
      let runtime = createRuntime();
      const handles: RuntimeHandle[] = [];
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
        const verify = async (reconnected = false) => {
          const results = await Promise.all(
            handles.map((handle) => promptJson(runtime, handle, "show context", handle.agentId!)),
          );
          for (const [index, result] of results.entries()) {
            expect(reconnected ? result.loadedMcpServers : result.mcpServers).toEqual(
              bridge || catalog ? [] : mcpServers(["main", "work"][index]!),
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
  },
);

it("finishes an admitted discard after reset retires its pending snapshot", async () => {
  await withProcessRuntime("acpx-discard-snapshot", async ({ runtime, store }) => {
    const target = { sessionKey: "discard-snapshot", agentId: "main" };
    await runtime.prepareFreshSession(target);
    const handle = await runtime.ensureSession({ ...target, agent: "fixture", mode: "persistent" });
    const shutdown = vi.spyOn(BaseAcpxRuntime.prototype, "shutdown");
    const load = store.load.bind(store);
    const snapshot = createHeldCall(load);
    const loadSpy = vi.spyOn(store, "load").mockImplementationOnce(snapshot.call);
    const closing = runtime.close({ handle, reason: "discard", discardPersistentState: true });
    void closing.catch(() => {});
    try {
      await snapshot.entered;
      await runtime.prepareFreshSession(target);
      expect(shutdown).not.toHaveBeenCalled();
      snapshot.release();
      await closing;
      const persisted = await load(handle.acpxRecordId!);
      expect(persisted).toMatchObject({ closed: true, acpx: { reset_on_next_ensure: true } });
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      await snapshot.settle(closing);
      loadSpy.mockRestore();
      shutdown.mockRestore();
    }
  });
});

it("cleans up real initialization that completes after reset", async () => {
  let exited = false;
  await withProcessRuntime(
    "acpx-superseded-initialization",
    async ({ runtime, store, directory }) => {
      const saveGate = createHeldCall(store.save.bind(store));
      const saveSpy = vi.spyOn(store, "save").mockImplementationOnce(saveGate.call);
      const target = { ...fixtureSession("superseded-initialization"), agentId: "main" };
      const initializing = runtime.ensureSession(target);
      void initializing.catch(() => {});
      try {
        await saveGate.entered;
        expect(exited).toBe(false);
        await runtime.prepareFreshSession(target);
        saveGate.release();
        await expect(initializing).rejects.toThrow("superseded by reset");
        expect(exited).toBe(true);
        expect(await fs.readdir(directory)).toEqual([]);
      } finally {
        await saveGate.settle(initializing);
        saveSpy.mockRestore();
      }
    },
    {
      processLifecycle: {
        onExit: () => {
          exited = true;
        },
      },
    },
  );
});

it.each([false, true])(
  "keeps controls attached to distinct oneshot records (discard: %s)",
  async (discardPersistentState) => {
    const promptGate = createTestGate();
    await withServer(
      (_request, response) => {
        void promptGate.hold().then(() => response.end("released"));
      },
      async (promptGateUrl) => {
        await withProcessRuntime(
          "acpx-oneshot-custody",
          async ({ runtime, store }) => {
            const target = { ...fixtureSession("shared-oneshot", "oneshot"), agentId: "main" };
            await runtime.prepareFreshSession(target);
            const first = await runtime.ensureSession(target);
            const shutdown = vi.spyOn(BaseAcpxRuntime.prototype, "shutdown");
            const { turn, events, gate, saveSpy, admit } = holdCheckpoint(
              runtime,
              store,
              first,
              "first",
            );
            let turnFinished = false;
            const markFinished = () => {
              turnFinished = true;
            };
            void turn.result.then(markFinished, markFinished);
            let cancellation: Promise<void> | undefined;
            try {
              await admit();
              // Terminal persistence owns ACPX's record lock; these controls need a live prompt.
              await Promise.all([promptGate.entered, gate.entered]);
              const second = await runtime.ensureSession(target);
              expect(second.acpxRecordId).not.toBe(first.acpxRecordId);
              await expectSessionStatus(runtime, first);
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
              gate.release();
              promptGate.release();
              await Promise.all([events, turn.result]);
              await expectSessionStatus(runtime, second);
              await runtime.close({ handle: second, reason: "second complete" });
              expect(shutdown).toHaveBeenCalledOnce();
              await shutdown.mock.results[0]!.value;
            } finally {
              gate.release();
              await promptGate.settle(events, turn.result, cancellation);
              saveSpy.mockRestore();
              shutdown.mockRestore();
            }
          },
          { args: [`--prompt-gate-url=${promptGateUrl}`] },
        );
      },
    );
  },
);

it("creates a fresh oneshot while an old physical record write is still pending", async () => {
  await withProcessRuntime("acpx-oneshot-write-isolation", async ({ runtime, store }) => {
    const target = { ...fixtureSession("oneshot-write-isolation", "oneshot"), agentId: "main" };
    const first = await runtime.ensureSession(target);
    const { turn, events, gate, saveSpy, admit } = holdCheckpoint(runtime, store, first, "old");
    void turn.result.catch(() => {});
    let creating: Promise<typeof first> | undefined;
    let fresh: typeof first | undefined;
    try {
      await admit();
      await gate.entered;
      await runtime.prepareFreshSession(target);
      creating = runtime.ensureSession(target).then((handle) => {
        fresh = handle;
        return handle;
      });
      void creating.catch(() => {});
      await vi.waitFor(() => expect(fresh).toBeDefined(), { timeout: 5000 });
      expect(fresh?.acpxRecordId).not.toBe(first.acpxRecordId);
      gate.release();
      await Promise.all([events, turn.result]);
      const handle = await creating;
      await expectSessionStatus(runtime, handle);
      await runtime.close({ handle, reason: "fresh complete" });
    } finally {
      await gate.settle(events, turn.result, creating);
      saveSpy.mockRestore();
    }
  });
});
