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
  it.each(["retry cap", "capacity", "expiry"] as const)(
    "retains failed-decryption notifications through %s",
    async (retirement) => {
      vi.useFakeTimers();
      const client = context.createSdkClient();
      const sdk = context.getMatrixJsClient();
      const failed = vi.fn<(_room: string, _event: unknown, error: Error) => void>();
      const notifications = () => failed.mock.calls.map((call) => call[2].message);
      client.on("room.failed_decryption", failed);
      sdk.decryptEventIfNeeded = vi.fn(async () => {
        throw new Error("still missing key");
      });
      const emitFailure = (event: FakeMatrixEvent) => {
        sdk.emit("event", event);
        event.emit("decrypted", event, new Error("missing room key"));
      };
      const expectAttempts = async (count: number) => {
        await vi.advanceTimersByTimeAsync(200_000);
        expect(sdk.decryptEventIfNeeded).toHaveBeenCalledTimes(count);
      };
      const makeFailed = (eventId: string) => makeMatrixEvent({ eventId, decryptionFailure: true });
      const oldest = makeFailed("$oldest");
      const events = [
        oldest,
        ...Array.from({ length: retirement === "capacity" ? 512 : 0 }, (_unused, index) =>
          makeFailed(`$retained-${index}`),
        ),
      ];
      await client.start();
      events.forEach(emitFailure);
      let retained = events.at(-1) ?? oldest;
      if (retirement === "retry cap") {
        expect(notifications()).toEqual(["missing room key"]);
      }
      await expectAttempts(events.length * 8);
      if (retirement === "retry cap") {
        oldest.emit("decrypted", oldest, new Error("missing room key again"));
        await expectAttempts(8);
        expect(notifications()).toEqual(["missing room key"]);
        return;
      }
      if (retirement === "expiry") {
        await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
        retained = makeFailed("$retained");
        emitFailure(retained);
        await expectAttempts(16);
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
