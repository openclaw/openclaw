// Matrix tests cover to-device compatibility normalization before Rust crypto.
import { describe, expect, it, vi } from "vitest";
import {
  normalizeMatrixToDeviceEventsForRustCrypto,
  patchMatrixRustCryptoToDeviceCompatibility,
} from "./to-device-compat.js";

describe("normalizeMatrixToDeviceEventsForRustCrypto", () => {
  it("adds the SAS method to Matrix verification accept events when Element omits it", () => {
    const event = {
      type: "m.key.verification.accept",
      sender: "@alice:example.org",
      content: {
        transaction_id: "txn-1",
        commitment: "abc",
      },
    };
    const events = [event];

    const result = normalizeMatrixToDeviceEventsForRustCrypto(events);

    expect(result.normalizedAcceptEvents).toBe(1);
    expect(result.events).not.toBe(events);
    expect(result.events).toEqual([
      {
        ...event,
        content: {
          ...event.content,
          method: "m.sas.v1",
        },
      },
    ]);
    expect(event.content).not.toHaveProperty("method");
  });

  it("leaves existing methods and unrelated to-device events untouched", () => {
    const acceptWithMethod = {
      type: "m.key.verification.accept",
      content: { method: "m.qr_code.show.v1", transaction_id: "txn-1" },
    };
    const keyEvent = {
      type: "m.key.verification.key",
      content: { transaction_id: "txn-1", key: "abc" },
    };
    const events = [acceptWithMethod, keyEvent, "not-an-event"];

    const result = normalizeMatrixToDeviceEventsForRustCrypto(events);

    expect(result.normalizedAcceptEvents).toBe(0);
    expect(result.events).toBe(events);
  });
});

describe("patchMatrixRustCryptoToDeviceCompatibility", () => {
  it("normalizes events before invoking the original Rust crypto preprocessor", async () => {
    const onNormalizedAcceptEvents = vi.fn();
    const original = vi.fn(async function (this: unknown, events: unknown[]) {
      return [{ message: events[0], encryptionInfo: null }];
    });
    const backend = {
      preprocessToDeviceMessages: original,
    };
    patchMatrixRustCryptoToDeviceCompatibility({
      client: { cryptoBackend: backend },
      onNormalizedAcceptEvents,
    });

    const result = await backend.preprocessToDeviceMessages([
      {
        type: "m.key.verification.accept",
        content: { transaction_id: "txn-1" },
      },
    ]);

    expect(onNormalizedAcceptEvents).toHaveBeenCalledWith(1);
    expect(original).toHaveBeenCalledWith([
      {
        type: "m.key.verification.accept",
        content: { transaction_id: "txn-1", method: "m.sas.v1" },
      },
    ]);
    expect(result).toEqual([
      {
        message: {
          type: "m.key.verification.accept",
          content: { transaction_id: "txn-1", method: "m.sas.v1" },
        },
        encryptionInfo: null,
      },
    ]);
  });

  it("patches the Rust crypto preprocessor only once", async () => {
    const original = vi.fn(async (events: unknown[]) => events);
    const backend = {
      preprocessToDeviceMessages: original,
    };
    const client = { cryptoBackend: backend };

    patchMatrixRustCryptoToDeviceCompatibility({ client });
    const patched = backend.preprocessToDeviceMessages;
    patchMatrixRustCryptoToDeviceCompatibility({ client });

    expect(backend.preprocessToDeviceMessages).toBe(patched);
    await backend.preprocessToDeviceMessages([]);
    expect(original).toHaveBeenCalledTimes(1);
  });
});
