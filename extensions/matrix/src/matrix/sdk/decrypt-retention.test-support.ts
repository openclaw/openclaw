import type { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import {
  type FakeMatrixEvent,
  makeMatrixEvent,
  type MatrixEventDecryptor,
} from "./event.test-support.js";

type DecryptRetentionContext = {
  createSdkClient: () => MatrixClient;
  getMatrixJsClient: () => Pick<EventEmitter, "emit"> & {
    decryptEventIfNeeded: MatrixEventDecryptor;
  };
};

export function registerDecryptRetentionTests(context: DecryptRetentionContext): void {
  const { createSdkClient, getMatrixJsClient } = context;

  it("stops decryption retries after hitting retry cap", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const matrixJsClient = getMatrixJsClient();
    const failed: string[] = [];

    client.on("room.failed_decryption", (_roomId, eventValue, error) => {
      failed.push(error.message);
    });

    const encrypted = makeMatrixEvent({ decryptionFailure: true });

    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      throw new Error("still missing key");
    });

    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));

    expect(failed).toEqual(["missing room key"]);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(8);

    encrypted.emit("decrypted", encrypted, new Error("missing room key again"));

    await vi.advanceTimersByTimeAsync(200_000);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(8);
    expect(failed).toEqual(["missing room key"]);
  });

  it.each(["capacity", "expiry"] as const)(
    "retires failed-decryption notifications with exhausted retries on %s",
    async (retirement) => {
      vi.useFakeTimers();
      const client = createSdkClient();
      const matrixJsClient = getMatrixJsClient();
      const failed = vi.fn();
      client.on("room.failed_decryption", failed);
      matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
        throw new Error("still missing key");
      });
      const oldest = makeMatrixEvent({ eventId: "$oldest", decryptionFailure: true });
      let retained = oldest;
      const events = [
        oldest,
        ...Array.from({ length: retirement === "capacity" ? 512 : 0 }, (_unused, index) =>
          makeMatrixEvent({ eventId: `$retained-${index}`, decryptionFailure: true }),
        ),
      ];
      const emitFailure = (event: FakeMatrixEvent) => {
        matrixJsClient.emit("event", event);
        event.emit("decrypted", event, new Error("missing room key"));
      };

      await client.start();
      for (const event of events) {
        emitFailure(event);
        retained = event;
      }
      await vi.advanceTimersByTimeAsync(200_000);
      expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(events.length * 8);

      if (retirement === "expiry") {
        await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
        retained = makeMatrixEvent({ eventId: "$retained", decryptionFailure: true });
        emitFailure(retained);
        await vi.advanceTimersByTimeAsync(200_000);
        expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(16);
      }

      const initialNotifications = retirement === "capacity" ? 513 : 2;
      expect(failed).toHaveBeenCalledTimes(initialNotifications);
      retained.emit("decrypted", retained, new Error("retained failure"));
      expect(failed).toHaveBeenCalledTimes(initialNotifications);

      oldest.emit("decrypted", oldest, new Error("retired failure"));
      expect(failed).toHaveBeenCalledTimes(initialNotifications + 1);
      expect(failed).toHaveBeenLastCalledWith(
        "!room:example.org",
        expect.objectContaining({ event_id: "$oldest" }),
        expect.objectContaining({ message: "retired failure" }),
      );
    },
  );
}
