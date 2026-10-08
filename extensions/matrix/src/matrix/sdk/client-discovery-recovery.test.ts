import {
  ClientEvent,
  EventType,
  MatrixEvent,
  Room,
  type MatrixClient as MatrixJsClient,
} from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixClient } from "../sdk.js";

const fixture = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  sync: vi.fn<(client: MatrixJsClient) => Promise<void>>(),
}));
vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (options: Parameters<typeof actual.createClient>[0]) => {
      const client = actual.createClient({ ...options, fetchFn: fixture.fetch });
      const initialize = client.initRustCrypto.bind(client);
      vi.spyOn(client, "initRustCrypto").mockImplementation(() =>
        initialize({ useIndexedDB: false }),
      );
      vi.spyOn(client, "startClient").mockImplementation(async () => {
        await fixture.sync(client);
        client.emit(ClientEvent.Sync, SyncState.Prepared, null);
      });
      return client;
    },
  };
});

const healthy = "!healthy:example.org";
const missing = "!missing:example.org";
const encryption = { algorithm: "m.megolm.v1.aes-sha2" };

describe("Matrix startup with unavailable joined-room discovery", () => {
  let client: MatrixClient;
  let discovery: () => Promise<Response>;

  beforeEach(() => {
    discovery = async () => Response.json({ errcode: "M_UNKNOWN" }, { status: 503 });
    fixture.fetch.mockReset().mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/joined_rooms")) {
        return await discovery();
      }
      if (url.pathname.endsWith("/room_keys/version")) {
        return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
      }
      throw new Error(`Unexpected SDK request: ${url.pathname}`);
    });
    fixture.sync.mockReset().mockImplementation(async (sdk) => {
      const room = new Room(healthy, sdk, "@bot:example.org");
      room.updateMyMembership("join");
      const event = new MatrixEvent({
        room_id: healthy,
        type: EventType.RoomEncryption,
        state_key: "",
        content: encryption,
      });
      const crypto = sdk.getCrypto();
      if (!(crypto instanceof RustCrypto)) {
        throw new Error("Expected the installed Rust crypto backend");
      }
      await crypto.onCryptoEvent(room, event);
      room.currentState.setStateEvents([event]);
      sdk.store.storeRoom(room);
      const unrecovered = new Room(missing, sdk, "@bot:example.org");
      unrecovered.updateMyMembership("join");
      sdk.store.storeRoom(unrecovered);
    });
    client = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
    });
  });

  afterEach(async () => {
    await client.stopWithoutPersist();
    vi.restoreAllMocks();
  });

  it.each(["503", "429", "connection", "401", "403", "abort", "malformed"])(
    "preserves encrypted startup safety after %s discovery",
    async (failure) => {
      const abort = new AbortController();
      const errcode =
        failure === "401" ? "M_UNKNOWN_TOKEN" : failure === "403" ? "M_FORBIDDEN" : "M_UNKNOWN";
      discovery = async () => {
        if (failure === "abort") {
          abort.abort();
          throw new TypeError("connection closed during abort");
        }
        if (failure === "connection") {
          throw new TypeError("fetch failed");
        }
        return failure === "malformed"
          ? Response.json({ joined_rooms: [null] })
          : Response.json({ errcode }, { status: Number(failure) });
      };
      const startup = client.start({ abortSignal: abort.signal });
      if (failure === "401" || failure === "403") {
        await expect(startup).rejects.toMatchObject({ httpStatus: Number(failure), errcode });
        return;
      }
      if (failure === "abort") {
        await expect(startup).rejects.toMatchObject({ name: "AbortError" });
        return;
      }
      if (failure === "malformed") {
        await expect(startup).rejects.toThrow("invalid joined rooms");
        return;
      }
      await expect(startup).resolves.toBeUndefined();
      await expect(client.prepareRoomForMessageSend(healthy)).resolves.toBe("m.room.encrypted");
      vi.spyOn(client, "getRoomStateEvent").mockResolvedValue(encryption);
      await expect(
        client.sendMessage(missing, { msgtype: "m.text", body: "must not escape" }),
      ).rejects.toThrow("Encrypted Matrix room is not ready");
      expect(
        fixture.fetch.mock.calls.some(([input]) =>
          (input instanceof Request ? input.url : String(input)).includes("/send/"),
        ),
      ).toBe(false);
    },
  );
});
