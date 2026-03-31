import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeTelegramMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeTelegram: probeTelegramMock,
}));

let HeartbeatSupervisor: typeof import("./heartbeat.js").HeartbeatSupervisor;
type HeartbeatOpts = ConstructorParameters<typeof import("./heartbeat.js").HeartbeatSupervisor>[0];

describe("HeartbeatSupervisor (threshold)", () => {
  beforeEach(async () => {
    vi.resetModules();
    probeTelegramMock.mockReset();
    ({ HeartbeatSupervisor } = await import("./heartbeat.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function captureInterval() {
    let heartbeatCallback: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
      heartbeatCallback = fn as () => void;
      return 2 as unknown as ReturnType<typeof setInterval>;
    });
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    return {
      setIntervalSpy,
      tick: () => {
        if (!heartbeatCallback) {
          throw new Error("setInterval callback not captured");
        }
        return heartbeatCallback();
      },
    };
  }

  function makeOpts(overrides: Partial<HeartbeatOpts> = {}): HeartbeatOpts {
    const base: HeartbeatOpts = {
      apiBase: "https://api.telegram.org",
      token: "test-token",
      log: vi.fn(),
      onOutageDetected: vi.fn(),
      onRecovered: vi.fn(),
    };
    return { ...base, ...overrides };
  }

  it("does not fire onOutageDetected on successful probes", async () => {
    probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts();
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      await tick();
      await tick();
      await tick();

      expect(opts.onOutageDetected).not.toHaveBeenCalled();
      expect(probeTelegramMock).toHaveBeenCalledTimes(3);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("fires onOutageDetected after exactly failureThreshold (3) consecutive failures", async () => {
    probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "timeout" });
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 3 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      await tick();
      expect(opts.onOutageDetected).not.toHaveBeenCalled();

      await tick();
      expect(opts.onOutageDetected).not.toHaveBeenCalled();

      await tick();
      expect(opts.onOutageDetected).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("fires onOutageDetected only once per outage even after more failures", async () => {
    probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "timeout" });
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 3 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      for (let i = 0; i < 6; i++) {
        await tick();
      }

      expect(opts.onOutageDetected).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("fires onRecovered once after a successful probe following an outage", async () => {
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 3 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      // 3 failures → outage
      probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "timeout" });
      await tick();
      await tick();
      await tick();
      expect(opts.onOutageDetected).toHaveBeenCalledTimes(1);
      expect(opts.onRecovered).not.toHaveBeenCalled();

      // 1 success → recovery
      probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
      await tick();
      expect(opts.onRecovered).toHaveBeenCalledTimes(1);

      // Additional successes do not re-fire onRecovered
      await tick();
      expect(opts.onRecovered).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("resets failure counter on success before threshold is reached", async () => {
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 3 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "err" });
      await tick();
      await tick();

      // Success resets the counter
      probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
      await tick();

      // 2 more failures should not reach threshold (only 2, not 3)
      probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "err" });
      await tick();
      await tick();

      expect(opts.onOutageDetected).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not call probeTelegram when abortSignal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ abortSignal: abort.signal });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      await tick();

      expect(probeTelegramMock).not.toHaveBeenCalled();
      expect(opts.onOutageDetected).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("suppresses onOutageDetected when signal fires mid-probe", async () => {
    const abort = new AbortController();
    probeTelegramMock.mockImplementation(async () => {
      abort.abort();
      return { ok: false, elapsedMs: 5, error: "err" };
    });

    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ abortSignal: abort.signal, failureThreshold: 1 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      await tick();

      expect(probeTelegramMock).toHaveBeenCalledTimes(1);
      expect(opts.onOutageDetected).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("stop() clears the interval", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
      return 42 as unknown as ReturnType<typeof setInterval>;
    });

    try {
      const supervisor = new HeartbeatSupervisor(makeOpts());
      supervisor.start();
      supervisor.stop();

      expect(clearIntervalSpy).toHaveBeenCalledWith(42);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("calling start() twice does not register a second interval", () => {
    let callCount = 0;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
      callCount += 1;
      return callCount as unknown as ReturnType<typeof setInterval>;
    });
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    try {
      const supervisor = new HeartbeatSupervisor(makeOpts());
      supervisor.start();
      supervisor.start();

      expect(callCount).toBe(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not overlap probes when a tick fires while a probe is in-flight", async () => {
    let resolveProbe: ((v: { ok: boolean; elapsedMs: number; error: null }) => void) | undefined;
    probeTelegramMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts();
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      // Start first probe (stays pending)
      const firstTick = tick();

      // Second tick fires while first is in-flight — should be skipped
      await tick();

      expect(probeTelegramMock).toHaveBeenCalledTimes(1);

      // Resolve first probe
      resolveProbe!({ ok: true, elapsedMs: 10, error: null });
      await firstTick;
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not fire callbacks after stop() when an in-flight probe resolves", async () => {
    let resolveProbe:
      | ((v: { ok: boolean; elapsedMs: number; error: string | null }) => void)
      | undefined;
    probeTelegramMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 1 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      const firstTick = tick();
      supervisor.stop();
      resolveProbe?.({ ok: false, elapsedMs: 5, error: "timeout" });
      await firstTick;

      expect(opts.onOutageDetected).not.toHaveBeenCalled();
      expect(opts.onRecovered).not.toHaveBeenCalled();
      expect(opts.log).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("logs failure count on each failed probe without leaking token or URL", async () => {
    probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "connection refused" });
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({
        token: "SECRET_TOKEN_VALUE",
        apiBase: "https://secret-api.example.com",
        failureThreshold: 3,
      });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      await tick();

      expect(opts.log).toHaveBeenCalledTimes(1);
      const logLine = (opts.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(logLine).toContain("connection refused");
      expect(logLine).toContain("[1/3]");
      expect(logLine).not.toContain("SECRET_TOKEN_VALUE");
      expect(logLine).not.toContain("secret-api.example.com");
      expect(probeTelegramMock).toHaveBeenCalledWith("SECRET_TOKEN_VALUE", 10_000, {
        apiRoot: "https://secret-api.example.com",
        proxyUrl: undefined,
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("calls onRecovered after a successful probe following an outage", async () => {
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 3 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "err" });
      await tick();
      await tick();
      await tick();

      probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
      await tick();

      expect(opts.onRecovered).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("can trigger a second outage after recovery", async () => {
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ failureThreshold: 2 });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      // First outage
      probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "err" });
      await tick();
      await tick();
      expect(opts.onOutageDetected).toHaveBeenCalledTimes(1);

      // Recovery
      probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
      await tick();
      expect(opts.onRecovered).toHaveBeenCalledTimes(1);

      // Second outage
      probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 5, error: "err" });
      await tick();
      await tick();
      expect(opts.onOutageDetected).toHaveBeenCalledTimes(2);

      // Second recovery
      probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
      await tick();
      expect(opts.onRecovered).toHaveBeenCalledTimes(2);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("forwards proxyUrl to probeTelegram when provided", async () => {
    probeTelegramMock.mockResolvedValue({ ok: true, elapsedMs: 10, error: null });
    const { setIntervalSpy, tick } = captureInterval();

    try {
      const opts = makeOpts({ proxyUrl: "http://proxy.example.com:3128" });
      const supervisor = new HeartbeatSupervisor(opts);
      supervisor.start();

      await tick();

      expect(probeTelegramMock).toHaveBeenCalledWith("test-token", 10_000, {
        apiRoot: "https://api.telegram.org",
        proxyUrl: "http://proxy.example.com:3128",
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
