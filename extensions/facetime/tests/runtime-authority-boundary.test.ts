import { once } from "node:events";
import net from "node:net";
import { createInterface } from "node:readline";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { incomingCall, pendingDial } from "./fixtures.test-support.js";
import { HelperClient, type Payload } from "./helper-wire.test-support.js";

const isolation = vi.hoisted(() => ({
  port: 0,
  spawn: vi.fn((_command: string, ..._args: unknown[]) => {
    throw new Error("isolated capture effect reached");
  }),
}));

// Keep the socket, runtime, persistence, talk and audio owners real. Replace
// host discovery and the first OS media effect, never the admission decision.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: isolation.spawn,
}));
vi.mock("../src/plugin-paths.js", () => ({
  ensureCaptureBinary: async () => process.execPath,
  ensureHelperArtifacts: async () => ({ buildId: "b".repeat(64), ipcKey: "a".repeat(64) }),
}));
vi.mock("../src/helper-endpoint.js", () => ({
  resolveFaceTimeHelperEndpoint: () => ({ host: "127.0.0.1", port: isolation.port }),
}));
vi.mock("../src/helper-supervisor.js", () => ({
  FaceTimeHelperSupervisor: class {
    start() {}
    stop() {}
    connected() {}
    disconnected() {}
    stale() {}
    status() {
      return [];
    }
  },
}));
import * as configModule from "../src/config.js";
import { resolveFaceTimeConfig } from "../src/config.js";
import type { PendingFaceTimeDial } from "../src/outbound-call.js";
import { PendingFaceTimeDialStore } from "../src/pending-dial-store.js";
import { createFaceTimeRuntime, type FaceTimeRuntime } from "../src/runtime.js";

const validateConfig = configModule.validateFaceTimeConfig;
const storeOptions = {
  namespace: "pending-dial",
  maxEntries: 1,
  overflowPolicy: "reject-new" as const,
};
const openStore = () =>
  createPluginStateKeyedStoreV2ForTests<
    Omit<PendingFaceTimeDial, "callUUIDAliases"> & { callUUIDAliases?: string[] }
  >("facetime", storeOptions, { assertCurrent() {} });

async function createWireHelper(socket: net.Socket) {
  socket.setEncoding("utf8");
  const lines = createInterface({ input: socket });
  const peer = new HelperClient(
    socket,
    async () => {
      const [line] = await once(lines, "line");
      return JSON.parse(line) as Payload;
    },
    "\n",
  );
  const actions: Payload[] = [];
  await peer.authenticate(() => {
    // Install the command reader before acknowledging the authenticated session.
    lines.on("line", (line) => {
      const payload = peer.decode(JSON.parse(line) as Payload);
      actions.push(payload);
      peer.send({
        transactionId: payload.transactionId,
        ...(payload.action === "find-outgoing-call"
          ? { found: true, call_uuid: "recovered-call" }
          : { found: false, cancelled: true, tombstoned: true }),
      });
    });
  });
  return Object.assign(peer, { actions });
}

const call = (status = 4, overrides: Record<string, unknown> = {}) =>
  incomingCall(status, { call_uuid: "recovered-call", ...overrides });

describe("FaceTime production authority boundary", () => {
  let ownedRuntime: FaceTimeRuntime | undefined;
  let ownedSocket: net.Socket | undefined;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    vi.clearAllMocks();
    vi.spyOn(configModule, "validateFaceTimeConfig").mockImplementation((config) => {
      const errors = validateConfig(config).errors.filter(
        (error) => error !== "facetime requires macOS",
      );
      return { valid: errors.length === 0, errors };
    });
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") {
      throw new Error("missing isolated port");
    }
    isolation.port = address.port;
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error ? reject(error) : resolve()));
    });
  });

  afterEach(async () => {
    await ownedRuntime?.stop();
    ownedSocket?.destroy();
    ownedRuntime = undefined;
    ownedSocket = undefined;
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  async function start(ownerHandles = ["owner@example.com"]) {
    const runtime = await createFaceTimeRuntime({
      config: resolveFaceTimeConfig({ ownerHandles }),
      fullConfig: {},
      logger: log,
      pluginRoot: "/isolated",
      runtime: {
        state: { openKeyedStoreV2: openStore },
        system: {
          runCommandWithTimeout: vi.fn(async () => {
            throw new Error("host command is forbidden in authority proof");
          }),
        },
      } as unknown as PluginRuntime,
    });
    ownedRuntime = runtime;
    const socket = net.createConnection({ host: "127.0.0.1", port: isolation.port });
    ownedSocket = socket;
    await once(socket, "connect");
    const peer = await createWireHelper(socket);
    await vi.waitFor(async () => expect((await runtime.status()).helperConnected).toBe(true));
    return { runtime, peer };
  }

  it("positive control reaches the real talk/audio owner's capture effect", async () => {
    const { runtime, peer } = await start();
    peer.send(call());
    await vi.waitFor(() => expect(isolation.spawn).toHaveBeenCalledOnce());
    expect(isolation.spawn.mock.calls[0]?.[0]).toBe(process.execPath);
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("isolated capture effect reached"),
    );
    expect(peer.actions).toEqual([]);
  });

  it.each([
    ["unlisted ringing caller", call(4, { handle: { value: "unlisted@example.com" } })],
    [
      "active cellular transport",
      call(1, {
        transport: {
          ...call().data.transport,
          kind: "cellular",
          provider_is_facetime: false,
          provider_is_telephony: true,
        },
      }),
    ],
  ] as const)("rejects %s before capture or native media commands", async (_name, event) => {
    const { runtime, peer } = await start();
    peer.send(event);
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("ignored unauthorized")),
    );
    expect((await runtime.status()).calls).toEqual([]);
    expect(peer.actions).toEqual([]);
    expect(isolation.spawn).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "revoked"] as const)(
    "rejects a %s persisted dial after runtime recovery",
    async (reason) => {
      const store = new PendingFaceTimeDialStore(openStore());
      await store.save(
        pendingDial({
          dialID: "persisted-dial",
          delivery: reason === "cancelled" ? "cancelling" : "accepted",
          requestedAt: "2026-09-19T12:00:00.000Z",
          callUUID: "recovered-call",
        }),
      );
      const { runtime, peer } = await start(
        reason === "revoked" ? ["replacement@example.com"] : undefined,
      );
      const recovered = await store.load();
      expect(recovered?.ownerEpoch).toBe(2);
      // Recovery only reports recovered-call. A cancellation for this new alias
      // proves the injected event was processed, not just background recovery.
      const lateIdentity = {
        call_uuid: "late-active-call",
        is_outgoing: true,
        dial_id: "persisted-dial",
      };
      peer.send(call(1, lateIdentity));
      await vi.waitFor(() =>
        expect(peer.actions).toContainEqual(
          expect.objectContaining({
            action: "cancel-outgoing-call",
            data: expect.objectContaining({ callUUID: "late-active-call" }),
          }),
        ),
      );
      const cancelled = await store.load();
      expect(cancelled?.delivery).toBe("cancelling");
      expect(cancelled?.callUUIDAliases).toContain("late-active-call");
      expect((await runtime.status()).calls).toEqual([]);
      expect(isolation.spawn).not.toHaveBeenCalled();
      expect(
        peer.actions.every((action) =>
          ["find-outgoing-call", "cancel-outgoing-call"].includes(String(action.action)),
        ),
      ).toBe(true);
      // A native ended event settles this synthetic carrier before fixture shutdown.
      peer.send(call(6, lateIdentity));
      await vi.waitFor(async () => expect(await store.load()).toBeUndefined());
    },
  );
});
