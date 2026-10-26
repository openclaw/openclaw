import { afterEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.hoisted(() =>
  vi.fn(async () => ({
    configRevisionHash: "saved-revision",
    appliedConfigHash: "older-applied",
  })),
);

// mock-isolation: real module import hangs under this suite's fake timers; only callGatewayFromCli is replaced.
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({ callGatewayFromCli }));

describe("buzz setup verify reload wait clock domain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fails the reload wait at its monotonic deadline when the wall clock rewinds", async () => {
    // Load the module under real timers so guarded module init behaves
    // normally; config.get keeps reporting an unapplied saved revision.
    const { verifyBuzzAfterSetup } = await import("./setup-verify.js");
    // The reload budget is consumed by sleep polls on the monotonic clock;
    // fake timers advance the monotonic deadline while the wall-clock reading
    // stays frozen at a rewound instant — the two-clock separation the series
    // uses.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const startedAt = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(startedAt - 10 * 60_000);
    // Settlement observer is attached before fake time advances; the recorded
    // outcome is asserted without leaving real timers behind. The bounded
    // failure surfaces through the runtime log: the verify call resolves after
    // reporting that the Gateway did not apply the saved configuration.
    const logs: string[] = [];
    let settled: string | undefined;
    const verify = verifyBuzzAfterSetup({
      accountId: "default",
      target: "buzz",
      runtime: {
        log: (...args: unknown[]) => {
          logs.push(String(args[0] ?? ""));
        },
        error: () => {},
        exit: () => {},
      },
    }).then(
      () => {
        settled = "completed";
      },
      (error: unknown) => {
        settled = `error:${(error as Error).message.slice(0, 60)}`;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000 + 1_000);
    expect(settled ?? "still-waiting").toBe("completed");
    expect(logs.join("\n")).toContain("did not apply");
    expect(callGatewayFromCli).toHaveBeenCalled();
    await verify;
    wallClock.mockRestore();
  });
});
