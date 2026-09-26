import { createHmac } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const ipcKey = "a".repeat(64);
const validateConfig = configModule.validateFaceTimeConfig;
const buildId = "b".repeat(64);
const mac = (key: string, value: string) => createHmac("sha256", key).update(value).digest("hex");
const storeOptions = {
  namespace: "pending-dial",
  maxEntries: 1,
  overflowPolicy: "reject-new" as const,
};
const openStore = () =>
  createPluginStateKeyedStoreForTests<
    Omit<PendingFaceTimeDial, "callUUIDAliases"> & { callUUIDAliases?: string[] }
  >("facetime", storeOptions);

class WireHelper {
  readonly actions: Array<Record<string, unknown>> = [];
  private buffer = "";
  private frames: Array<Record<string, unknown>> = [];
  private waiting: ((frame: Record<string, unknown>) => void) | undefined;
  private epoch = "";
  private key = "";
  private sent = 0;
  private received = 0;
  private serving = false;

  constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += String(chunk);
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(this.buffer.slice(0, end)) as Record<string, unknown>;
        this.buffer = this.buffer.slice(end + 1);
        if (this.serving) {
          const payload = this.decode(frame);
          this.actions.push(payload);
          this.send({
            transactionId: payload.transactionId,
            ...(payload.action === "find-outgoing-call"
              ? { found: true, call_uuid: "recovered-call" }
              : { found: false, cancelled: true, tombstoned: true }),
          });
        } else if (this.waiting) {
          const resolve = this.waiting;
          this.waiting = undefined;
          resolve(frame);
        } else {
          this.frames.push(frame);
        }
      }
    });
  }

  private read(): Promise<Record<string, unknown>> {
    const frame = this.frames.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => {
          this.waiting = resolve;
        });
  }

  private decode(frame: Record<string, unknown>) {
    const payload = String(frame.payload_json);
    expect(frame).toMatchObject({
      connection_epoch: this.epoch,
      direction: "server-to-helper",
      sequence: ++this.received,
    });
    expect(frame.auth).toBe(
      mac(this.key, `message\nserver-to-helper\n${this.epoch}\n${this.received}\n${payload}`),
    );
    return JSON.parse(payload) as Record<string, unknown>;
  }

  send(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    const sequence = ++this.sent;
    this.socket.write(
      `${JSON.stringify({ connection_epoch: this.epoch, direction: "helper-to-server", sequence, payload_json: json, auth: mac(this.key, `message\nhelper-to-server\n${this.epoch}\n${sequence}\n${json}`) })}\n`,
    );
  }

  async authenticate() {
    const bundle = "com.apple.FaceTime";
    const pid = 1234;
    const started = 1_700_000_000_000;
    const nonce = "c".repeat(64);
    this.socket.write(
      `${JSON.stringify({ event: "client-hello", bundle_identifier: bundle, build_id: buildId, process_id: pid, process_started_at_ms: started, client_nonce: nonce, proof: mac(ipcKey, `client-hello\n${bundle}\n${buildId}\n${pid}\n${started}\n${nonce}`) })}\n`,
    );
    const hello = await this.read();
    this.epoch = String(hello.connection_epoch);
    const context = `${bundle}\n${buildId}\n${pid}\n${started}\n${nonce}\n${String(hello.server_nonce)}\n${this.epoch}`;
    expect(hello.proof).toBe(mac(ipcKey, `server-hello\n${context}`));
    this.key = mac(ipcKey, `session\n${context}`);
    this.socket.write(
      `${JSON.stringify({ event: "client-finish", connection_epoch: this.epoch, proof: mac(this.key, `client-finish\n${this.epoch}`) })}\n`,
    );
    expect(this.decode(await this.read())).toEqual({ event: "session-ready" });
    this.serving = true;
    this.send({ event: "session-ready-ack" });
  }
}

function call(status = 4, overrides: Record<string, unknown> = {}) {
  return {
    event: "ft-call-status-changed",
    data: {
      call_uuid: "recovered-call",
      call_status: status,
      has_ended: status === 6,
      is_outgoing: false,
      is_sending_audio: false,
      handle: { value: "owner@example.com" },
      transport: {
        kind: "facetime",
        classifier_version: "tu-provider-v1",
        service: 2,
        facetime_transport_type: 1,
        provider_classified: true,
        provider_is_facetime: true,
        provider_is_telephony: false,
        is_using_baseband: false,
        is_wifi_call: false,
        is_voip: true,
        is_emergency: false,
      },
      ...overrides,
    },
  };
}

describe("FaceTime production authority boundary", () => {
  let ownedRuntime: FaceTimeRuntime | undefined;
  let ownedPeer: WireHelper | undefined;
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
    ownedPeer?.socket.destroy();
    ownedRuntime = undefined;
    ownedPeer = undefined;
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
        state: { openKeyedStore: openStore },
        system: {
          runCommandWithTimeout: vi.fn(async () => {
            throw new Error("host command is forbidden in authority proof");
          }),
        },
      } as unknown as PluginRuntime,
    });
    ownedRuntime = runtime;
    const socket = net.createConnection({ host: "127.0.0.1", port: isolation.port });
    const peer = new WireHelper(socket);
    ownedPeer = peer;
    await once(socket, "connect");
    await peer.authenticate();
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

  describe.each([4, 1])("native call status %s", (status) => {
    it.each([
      { name: "unlisted caller", data: { handle: { value: "unlisted@example.com" } } },
      {
        name: "forbidden cellular transport",
        data: {
          transport: {
            ...call().data.transport,
            kind: "cellular",
            provider_is_facetime: false,
            provider_is_telephony: true,
          },
        },
      },
    ])("rejects $name before capture or native media commands", async ({ data }) => {
      const { runtime, peer } = await start();
      peer.send(call(status, data));
      await vi.waitFor(() =>
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("ignored unauthorized")),
      );
      expect((await runtime.status()).calls).toEqual([]);
      expect(peer.actions).toEqual([]);
      expect(isolation.spawn).not.toHaveBeenCalled();
    });
  });

  it.each(["cancelled", "revoked"] as const)(
    "rejects a %s persisted dial after runtime recovery",
    async (reason) => {
      await new PendingFaceTimeDialStore(openStore()).save({
        version: 1,
        ownerEpoch: 1,
        dialID: "persisted-dial",
        handle: "owner@example.com",
        mode: "audio",
        delivery: reason === "cancelled" ? "cancelling" : "accepted",
        requestedAt: "2026-09-19T12:00:00.000Z",
        callUUID: "recovered-call",
      });
      const { runtime, peer } = await start(
        reason === "revoked" ? ["replacement@example.com"] : undefined,
      );
      const recovered = await new PendingFaceTimeDialStore(openStore()).load();
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
      const cancelled = await new PendingFaceTimeDialStore(openStore()).load();
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
      await vi.waitFor(async () =>
        expect(await new PendingFaceTimeDialStore(openStore()).load()).toBeUndefined(),
      );
    },
  );
});
