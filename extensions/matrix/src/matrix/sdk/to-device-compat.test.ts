// Matrix tests cover to-device compatibility normalization before Rust crypto.
import { describe, expect, it, vi } from "vitest";
import { patchMatrixRustCryptoToDeviceCompatibility } from "./to-device-compat.js";

/**
 * Drives normalization through the only production seam: the patched Rust crypto
 * preprocessor. Returns what the real preprocessor would have received.
 */
function preprocessThroughPatchedBackend(events: unknown[]): {
  seenByRustCrypto: unknown[];
  normalizedAcceptEvents: number | undefined;
  run: () => Promise<unknown>;
} {
  const captured: { events: unknown[] } = { events: [] };
  const original = vi.fn(async (received: unknown[]) => {
    captured.events = received;
    return received;
  });
  const backend = { preprocessToDeviceMessages: original };
  let normalizedAcceptEvents: number | undefined;
  patchMatrixRustCryptoToDeviceCompatibility({
    client: { cryptoBackend: backend },
    onNormalizedAcceptEvents: (count) => {
      normalizedAcceptEvents = count;
    },
  });
  return {
    get seenByRustCrypto() {
      return captured.events;
    },
    get normalizedAcceptEvents() {
      return normalizedAcceptEvents;
    },
    run: () => backend.preprocessToDeviceMessages(events),
  };
}

describe("matrix to-device normalization before Rust crypto", () => {
  it("adds the SAS method to Matrix verification accept events when Element omits it", async () => {
    const event = {
      type: "m.key.verification.accept",
      sender: "@alice:example.org",
      content: {
        transaction_id: "txn-1",
        commitment: "abc",
      },
    };
    const events = [event];
    const harness = preprocessThroughPatchedBackend(events);

    await harness.run();

    expect(harness.normalizedAcceptEvents).toBe(1);
    expect(harness.seenByRustCrypto).not.toBe(events);
    expect(harness.seenByRustCrypto).toEqual([
      {
        ...event,
        content: {
          ...event.content,
          method: "m.sas.v1",
        },
      },
    ]);
    // The caller's original event object must not be mutated.
    expect(event.content).not.toHaveProperty("method");
  });

  it("leaves existing methods and unrelated to-device events untouched", async () => {
    const acceptWithMethod = {
      type: "m.key.verification.accept",
      content: { method: "m.qr_code.show.v1", transaction_id: "txn-1" },
    };
    const keyEvent = {
      type: "m.key.verification.key",
      content: { transaction_id: "txn-1", key: "abc" },
    };
    const events = [acceptWithMethod, keyEvent, "not-an-event"];
    const harness = preprocessThroughPatchedBackend(events);

    await harness.run();

    expect(harness.normalizedAcceptEvents).toBeUndefined();
    expect(harness.seenByRustCrypto).toBe(events);
  });

  it("normalizes accept events whose method is blank or non-string", async () => {
    const blankMethod = {
      type: "m.key.verification.accept",
      content: { method: "   ", transaction_id: "txn-1" },
    };
    const nonStringMethod = {
      type: "m.key.verification.accept",
      content: { method: null, transaction_id: "txn-2" },
    };
    const events = [blankMethod, nonStringMethod];
    const harness = preprocessThroughPatchedBackend(events);

    await harness.run();

    expect(harness.normalizedAcceptEvents).toBe(2);
    expect(harness.seenByRustCrypto).not.toBe(events);
    expect(
      (harness.seenByRustCrypto as Array<{ content: { method: string } }>).map(
        (e) => e.content.method,
      ),
    ).toEqual(["m.sas.v1", "m.sas.v1"]);
  });

  it("leaves accept events without a content object untouched", async () => {
    const noContent = { type: "m.key.verification.accept" };
    const events = [noContent];
    const harness = preprocessThroughPatchedBackend(events);

    await harness.run();

    expect(harness.normalizedAcceptEvents).toBeUndefined();
    expect(harness.seenByRustCrypto).toBe(events);
    expect(events[0]).not.toHaveProperty("content");
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
