import { EventEmitter } from "node:events";
import {
  VerificationPhase,
  VerificationRequestEvent,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { describe, expect, it, vi } from "vitest";
import {
  MatrixVerificationManager,
  type MatrixShowQrCodeCallbacks,
  type MatrixShowSasCallbacks,
  type MatrixVerificationRequestLike,
  type MatrixVerifierLike,
} from "./verification-manager.js";

class MockVerifier extends EventEmitter implements MatrixVerifierLike {
  constructor(
    private readonly sasCallbacks: MatrixShowSasCallbacks | null,
    private readonly qrCallbacks: MatrixShowQrCodeCallbacks | null,
    private readonly verifyImpl: () => Promise<void> = async () => {},
  ) {
    super();
  }

  verify(): Promise<void> {
    return this.verifyImpl();
  }

  cancel(_e: Error): void {
    void _e;
  }

  getShowSasCallbacks(): MatrixShowSasCallbacks | null {
    return this.sasCallbacks;
  }

  getReciprocateQrCodeCallbacks(): MatrixShowQrCodeCallbacks | null {
    return this.qrCallbacks;
  }
}

class MockVerificationRequest extends EventEmitter implements MatrixVerificationRequestLike {
  transactionId?: string;
  roomId?: string;
  initiatedByMe = false;
  otherUserId = "@alice:example.org";
  otherDeviceId?: string;
  isSelfVerification = false;
  phase = VerificationPhase.Requested;
  pending = true;
  accepting = false;
  declining = false;
  methods: string[] = ["m.sas.v1"];
  chosenMethod?: string | null;
  cancellationCode?: string | null;
  verifier?: MatrixVerifierLike;

  constructor(init?: Partial<MockVerificationRequest>) {
    super();
    Object.assign(this, init);
  }

  accept = vi.fn(async () => {
    this.phase = VerificationPhase.Ready;
  });

  cancel = vi.fn(async () => {
    this.phase = VerificationPhase.Cancelled;
  });

  startVerification = vi.fn(async (_method: string) => {
    if (!this.verifier) {
      throw new Error("verifier not configured");
    }
    this.phase = VerificationPhase.Started;
    return this.verifier;
  });

  scanQRCode = vi.fn(async (_qrCodeData: Uint8ClampedArray) => {
    if (!this.verifier) {
      throw new Error("verifier not configured");
    }
    this.phase = VerificationPhase.Started;
    return this.verifier;
  });

  generateQRCode = vi.fn(async () => new Uint8ClampedArray([1, 2, 3]));
}

describe("MatrixVerificationManager", () => {
  it("handles rust verification requests whose methods getter throws", () => {
    const manager = new MatrixVerificationManager();
    const request = new MockVerificationRequest({
      transactionId: "txn-rust-methods",
      phase: VerificationPhase.Requested,
      initiatedByMe: true,
    });
    Object.defineProperty(request, "methods", {
      get() {
        throw new Error("not implemented");
      },
    });

    const summary = manager.trackVerificationRequest(request);

    expect(summary.id).toBeTruthy();
    expect(summary.methods).toEqual([]);
    expect(summary.phaseName).toBe("requested");
  });

  it("reuses the same tracked id for repeated transaction IDs", () => {
    const manager = new MatrixVerificationManager();
    const first = new MockVerificationRequest({
      transactionId: "txn-1",
      phase: VerificationPhase.Requested,
    });
    const second = new MockVerificationRequest({
      transactionId: "txn-1",
      phase: VerificationPhase.Ready,
      pending: false,
      chosenMethod: "m.sas.v1",
    });

    const firstSummary = manager.trackVerificationRequest(first);
    const secondSummary = manager.trackVerificationRequest(second);

    expect(secondSummary.id).toBe(firstSummary.id);
    expect(secondSummary.phase).toBe(VerificationPhase.Ready);
    expect(secondSummary.pending).toBe(false);
    expect(secondSummary.chosenMethod).toBe("m.sas.v1");
  });

  it("starts SAS verification and exposes SAS payload/callback flow", async () => {
    const confirm = vi.fn(async () => {});
    const mismatch = vi.fn();
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [111, 222, 333],
          emoji: [
            ["cat", "cat"],
            ["dog", "dog"],
            ["fox", "fox"],
          ],
        },
        confirm,
        mismatch,
        cancel: vi.fn(),
      },
      null,
      async () => {},
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-2",
      verifier,
    });
    const manager = new MatrixVerificationManager();
    const tracked = manager.trackVerificationRequest(request);

    const started = await manager.startVerification(tracked.id, "sas");
    expect(started.hasSas).toBe(true);
    expect(started.sas?.decimal).toEqual([111, 222, 333]);
    expect(started.sas?.emoji?.length).toBe(3);

    const sas = manager.getVerificationSas(tracked.id);
    expect(sas.decimal).toEqual([111, 222, 333]);
    expect(sas.emoji?.length).toBe(3);

    await manager.confirmVerificationSas(tracked.id);
    expect(confirm).toHaveBeenCalledTimes(1);

    manager.mismatchVerificationSas(tracked.id);
    expect(mismatch).toHaveBeenCalledTimes(1);
  });

  it("auto-starts an incoming verifier exposed via request change events", async () => {
    const verify = vi.fn(async () => {});
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [6158, 1986, 3513],
          emoji: [
            ["gift", "Gift"],
            ["globe", "Globe"],
            ["horse", "Horse"],
          ],
        },
        confirm: vi.fn(async () => {}),
        mismatch: vi.fn(),
        cancel: vi.fn(),
      },
      null,
      verify,
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-incoming-change",
      verifier: undefined,
    });
    const manager = new MatrixVerificationManager();
    const tracked = manager.trackVerificationRequest(request);

    request.verifier = verifier;
    request.emit(VerificationRequestEvent.Change);

    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });
    const summary = manager.listVerifications().find((item) => item.id === tracked.id);
    expect(summary?.hasSas).toBe(true);
    expect(summary?.sas?.decimal).toEqual([6158, 1986, 3513]);
    expect(manager.getVerificationSas(tracked.id).decimal).toEqual([6158, 1986, 3513]);
  });

  it("emits summary updates when SAS becomes available", async () => {
    const verify = vi.fn(async () => {});
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [6158, 1986, 3513],
          emoji: [
            ["gift", "Gift"],
            ["globe", "Globe"],
            ["horse", "Horse"],
          ],
        },
        confirm: vi.fn(async () => {}),
        mismatch: vi.fn(),
        cancel: vi.fn(),
      },
      null,
      verify,
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-summary-listener",
      roomId: "!dm:example.org",
      verifier: undefined,
    });
    const manager = new MatrixVerificationManager();
    const summaries: ReturnType<typeof manager.listVerifications> = [];
    manager.onSummaryChanged((summary) => {
      summaries.push(summary);
    });

    manager.trackVerificationRequest(request);
    request.verifier = verifier;
    request.emit(VerificationRequestEvent.Change);

    await vi.waitFor(() => {
      expect(
        summaries.some(
          (summary) =>
            summary.transactionId === "txn-summary-listener" &&
            summary.roomId === "!dm:example.org" &&
            summary.hasSas,
        ),
      ).toBe(true);
    });
  });

  it("does not auto-start non-self inbound SAS when request becomes ready without a verifier", async () => {
    const verify = vi.fn(async () => {});
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [1234, 5678, 9012],
          emoji: [
            ["gift", "Gift"],
            ["rocket", "Rocket"],
            ["butterfly", "Butterfly"],
          ],
        },
        confirm: vi.fn(async () => {}),
        mismatch: vi.fn(),
        cancel: vi.fn(),
      },
      null,
      verify,
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-no-auto-start-dm-sas",
      initiatedByMe: false,
      isSelfVerification: false,
      verifier: undefined,
    });
    request.startVerification = vi.fn(async (_method: string) => {
      request.phase = VerificationPhase.Started;
      request.verifier = verifier;
      return verifier;
    });
    const manager = new MatrixVerificationManager();
    const tracked = manager.trackVerificationRequest(request);

    request.phase = VerificationPhase.Ready;
    request.emit(VerificationRequestEvent.Change);

    await vi.waitFor(() => {
      expect(manager.listVerifications().find((item) => item.id === tracked.id)?.phase).toBe(
        VerificationPhase.Ready,
      );
    });
    expect(request.startVerification).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(manager.listVerifications().find((item) => item.id === tracked.id)?.hasSas).toBe(false);
  });

  it("auto-starts self verification SAS when request becomes ready without a verifier", async () => {
    const verify = vi.fn(async () => {});
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [1234, 5678, 9012],
          emoji: [
            ["gift", "Gift"],
            ["rocket", "Rocket"],
            ["butterfly", "Butterfly"],
          ],
        },
        confirm: vi.fn(async () => {}),
        mismatch: vi.fn(),
        cancel: vi.fn(),
      },
      null,
      verify,
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-auto-start-self-sas",
      initiatedByMe: false,
      isSelfVerification: true,
      verifier: undefined,
    });
    request.startVerification = vi.fn(async (_method: string) => {
      request.phase = VerificationPhase.Started;
      request.verifier = verifier;
      return verifier;
    });
    const manager = new MatrixVerificationManager();
    const tracked = manager.trackVerificationRequest(request);

    request.phase = VerificationPhase.Ready;
    request.emit(VerificationRequestEvent.Change);

    await vi.waitFor(() => {
      expect(request.startVerification).toHaveBeenCalledWith("m.sas.v1");
    });
    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });
    const summary = manager.listVerifications().find((item) => item.id === tracked.id);
    expect(summary?.hasSas).toBe(true);
    expect(summary?.sas?.decimal).toEqual([1234, 5678, 9012]);
    expect(manager.getVerificationSas(tracked.id).decimal).toEqual([1234, 5678, 9012]);
  });

  it("auto-accepts incoming verification requests only once per transaction", async () => {
    const request = new MockVerificationRequest({
      transactionId: "txn-auto-accept-once",
      initiatedByMe: false,
      isSelfVerification: false,
      phase: VerificationPhase.Requested,
      accepting: false,
      declining: false,
    });
    const manager = new MatrixVerificationManager();

    manager.trackVerificationRequest(request);
    request.emit(VerificationRequestEvent.Change);
    manager.trackVerificationRequest(request);

    await vi.waitFor(() => {
      expect(request.accept).toHaveBeenCalledTimes(1);
    });
  });

  it("auto-confirms inbound SAS after a human-safe delay", async () => {
    vi.useFakeTimers();
    const confirm = vi.fn(async () => {});
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [6158, 1986, 3513],
          emoji: [
            ["gift", "Gift"],
            ["globe", "Globe"],
            ["horse", "Horse"],
          ],
        },
        confirm,
        mismatch: vi.fn(),
        cancel: vi.fn(),
      },
      null,
      async () => {},
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-auto-confirm",
      initiatedByMe: false,
      verifier,
    });
    try {
      const manager = new MatrixVerificationManager();
      manager.trackVerificationRequest(request);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(confirm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_100);
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-confirm SAS for verifications initiated by this device", async () => {
    vi.useFakeTimers();
    const confirm = vi.fn(async () => {});
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [111, 222, 333],
          emoji: [
            ["cat", "Cat"],
            ["dog", "Dog"],
            ["fox", "Fox"],
          ],
        },
        confirm,
        mismatch: vi.fn(),
        cancel: vi.fn(),
      },
      null,
      async () => {},
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-no-auto-confirm",
      initiatedByMe: true,
      verifier,
    });
    try {
      const manager = new MatrixVerificationManager();
      manager.trackVerificationRequest(request);

      await vi.advanceTimersByTimeAsync(20);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending auto-confirm when SAS is explicitly mismatched", async () => {
    vi.useFakeTimers();
    const confirm = vi.fn(async () => {});
    const mismatch = vi.fn();
    const verifier = new MockVerifier(
      {
        sas: {
          decimal: [444, 555, 666],
          emoji: [
            ["panda", "Panda"],
            ["rocket", "Rocket"],
            ["crown", "Crown"],
          ],
        },
        confirm,
        mismatch,
        cancel: vi.fn(),
      },
      null,
      async () => {},
    );
    const request = new MockVerificationRequest({
      transactionId: "txn-mismatch-cancels-auto-confirm",
      initiatedByMe: false,
      verifier,
    });
    try {
      const manager = new MatrixVerificationManager();
      const tracked = manager.trackVerificationRequest(request);

      manager.mismatchVerificationSas(tracked.id);
      await vi.advanceTimersByTimeAsync(2000);

      expect(mismatch).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes stale terminal sessions during list operations", () => {
    const now = new Date("2026-02-08T15:00:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(now);

    const manager = new MatrixVerificationManager();
    manager.trackVerificationRequest(
      new MockVerificationRequest({
        transactionId: "txn-old-done",
        phase: VerificationPhase.Done,
        pending: false,
      }),
    );

    nowSpy.mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    const summaries = manager.listVerifications();

    expect(summaries).toHaveLength(0);
    nowSpy.mockRestore();
  });
});
