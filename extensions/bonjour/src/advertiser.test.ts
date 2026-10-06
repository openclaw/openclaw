import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  getResponder: vi.fn(),
  shutdown: vi.fn(),
  registerUncaughtExceptionHandler: vi.fn(),
  registerUnhandledRejectionHandler: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
const {
  createService,
  getResponder,
  shutdown,
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
  logger,
} = mocks;

const stringOrFallback = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

function warnMessages(): string[] {
  return logger.warn.mock.calls.map(([message]) => String(message));
}

function expectWarnContaining(fragment: string) {
  expect(warnMessages().join("\n")).toContain(fragment);
}

function enableAdvertiserUnitMode(hostname = "test-host") {
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(os, "hostname").mockReturnValue(hostname);
  vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", hostname);
}

function mockCiaoService(params?: {
  advertise?: ReturnType<typeof vi.fn>;
  serviceState?: string;
  stateRef?: { value: string };
  listenerMap?: Map<string, (value: unknown) => void>;
  responder?: Record<string, unknown>;
}) {
  const advertise = params?.advertise ?? vi.fn().mockResolvedValue(undefined);
  const destroy = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn((event: string, listener: (value: unknown) => void) => {
    params?.listenerMap?.set(event, listener);
  });
  createService.mockImplementation((options: Record<string, unknown>) => ({
    advertise,
    destroy,
    on,
    getFQDN: () =>
      `${stringOrFallback(options.type, "service")}.${stringOrFallback(options.domain, "local")}.`,
    getHostname: () => stringOrFallback(options.hostname, "unknown"),
    getPort: () => Number(options.port ?? -1),
    get serviceState() {
      return params?.stateRef?.value ?? params?.serviceState ?? "announced";
    },
  }));
  getResponder.mockReturnValue(params?.responder ?? { createService, shutdown });
  return { destroy };
}

vi.mock("@homebridge/ciao", () => ({ getResponder }));

const { startGatewayBonjourAdvertiser } = await import("./advertiser.js");

afterAll(() => {
  vi.doUnmock("@homebridge/ciao");
  vi.resetModules();
});

const startAdvertiser = (opts: Partial<Parameters<typeof startGatewayBonjourAdvertiser>[0]> = {}) =>
  startGatewayBonjourAdvertiser(
    { gatewayPort: 18789, sshPort: 2222, ...opts },
    {
      logger,
      registerUncaughtExceptionHandler,
      registerUnhandledRejectionHandler,
    },
  );

describe("gateway bonjour advertiser", () => {
  type ServiceCall = {
    name?: unknown;
    hostname?: unknown;
    domain?: unknown;
    txt?: unknown;
  };

  beforeEach(() => {
    enableAdvertiserUnitMode();
    mockCiaoService();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    let resolveAdvertise = () => {};
    const advertise = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          resolveAdvertise = resolve;
        }),
    );
    const { destroy } = mockCiaoService({ advertise });

    const started = await startAdvertiser({
      gatewayDirectReachable: true,
      tailnetDns: "host.tailnet.ts.net",
      cliPath: "/opt/homebrew/bin/openclaw",
      minimal: false,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openclaw-gw",
        port: 18789,
        domain: "local",
        hostname: "test-host",
        txt: expect.objectContaining({
          lanHost: "test-host.local",
          gatewayPort: "18789",
          gatewayDirectReachable: "1",
          sshPort: "2222",
          tailnetDns: "host.tailnet.ts.net",
          cliPath: "/opt/homebrew/bin/openclaw",
          transport: "gateway",
        }),
      }),
    );

    expect(advertise).toHaveBeenCalledTimes(1);
    resolveAdvertise();
    await Promise.resolve();

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("omits cliPath and sshPort in minimal mode", async () => {
    const started = await startAdvertiser({
      cliPath: "/opt/homebrew/bin/openclaw",
      tailnetDns: "host.tailnet.ts.net",
      minimal: true,
    });

    const [gatewayCall] = createService.mock.calls as Array<[Record<string, unknown>]>;
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.sshPort).toBeUndefined();
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.cliPath).toBeUndefined();
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.tailnetDns).toBeUndefined();

    await started.stop();
  });

  it("honors truthy OPENCLAW_DISABLE_BONJOUR values", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", "true");

    const started = await startAdvertiser();

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("auto-disables Bonjour in detected containers", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => String(filePath) === "/.dockerenv");

    const started = await startAdvertiser();

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("auto-disables Bonjour on Fly Machines without Docker sentinel files", async () => {
    vi.stubEnv("FLY_MACHINE_ID", "3d8d5459a03038");
    vi.stubEnv("FLY_APP_NAME", "openclaw-clawcks-test");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");

    const started = await startAdvertiser();

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("honors explicit Bonjour opt-in inside detected containers", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", "0");
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => String(filePath) === "/.dockerenv");

    const started = await startAdvertiser();

    expect(createService).toHaveBeenCalledTimes(1);

    await started.stop();
  });

  it("cleans up ciao process handlers after shutdown", async () => {
    const order: string[] = [];
    shutdown.mockImplementation(async () => {
      order.push("shutdown");
    });
    const cleanupException = vi.fn(() => {
      order.push("cleanup-exception");
    });
    const cleanupRejection = vi.fn(() => {
      order.push("cleanup-rejection");
    });
    registerUncaughtExceptionHandler.mockReturnValue(cleanupException);
    registerUnhandledRejectionHandler.mockReturnValue(cleanupRejection);

    const started = await startAdvertiser();

    await started.stop();

    expect(registerUncaughtExceptionHandler).toHaveBeenCalledTimes(1);
    expect(registerUnhandledRejectionHandler).toHaveBeenCalledTimes(1);
    expect(cleanupException).toHaveBeenCalledTimes(1);
    expect(cleanupRejection).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["shutdown", "cleanup-exception", "cleanup-rejection"]);
  });

  it("handles ciao netmask assertions at the bonjour caller", async () => {
    const started = await startAdvertiser();

    const exceptionHandler = registerUncaughtExceptionHandler.mock.calls[0]?.[0] as
      | ((reason: unknown) => boolean)
      | undefined;
    expect(exceptionHandler).toBeTypeOf("function");

    expect(
      exceptionHandler?.(
        Object.assign(
          new Error(
            "IP address version must match. Netmask cannot have a version different from the address!",
          ),
          { name: "AssertionError" },
        ),
      ),
    ).toBe(true);
    expectWarnContaining("suppressing ciao netmask assertion");

    await started.stop();
  });

  it("logs advertise failures without starting a competing retry loop", async () => {
    vi.useFakeTimers();

    const advertise = vi.fn().mockRejectedValue(new Error("boom"));
    mockCiaoService({ advertise, serviceState: "unannounced" });

    const started = await startAdvertiser();

    expect(advertise).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    expectWarnContaining("advertise failed");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(1);
    expect(createService).toHaveBeenCalledTimes(1);

    await started.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(1);
  });

  it("handles advertise throwing synchronously", async () => {
    const advertise = vi.fn(() => {
      throw new Error("sync-fail");
    });
    mockCiaoService({ advertise, serviceState: "unannounced" });

    const started = await startAdvertiser();

    expect(advertise).toHaveBeenCalledTimes(1);
    expectWarnContaining("advertise threw");

    await started.stop();
  });

  it("suppresses ciao self-probe retry console noise while advertising", async () => {
    const baseConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const started = await startAdvertiser();

    console.log(
      "[test._openclaw-gw._tcp.local.] failed probing with reason: Error: Can't probe for a service which is announced already. Received announcing for service test._openclaw-gw._tcp.local.. Trying again in 2 seconds!",
    );
    console.log("ordinary console line");

    expect(baseConsoleLog).toHaveBeenCalledTimes(1);
    expect(baseConsoleLog).toHaveBeenCalledWith("ordinary console line");

    await started.stop();
  });

  it("suppresses transient ciao ENODEV MDNS socket warnings while advertising", async () => {
    const baseConsoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const started = await startAdvertiser();

    // A Docker bridge disappears between ciao's interface polls; the send to
    // the removed interface fails with ENODEV, which ciao does not silence.
    console.warn(
      "Encountered MDNS socket error on socket 'br-abcdef123456': Error: send ENODEV 224.0.0.251:5353\n    at ...",
    );
    console.warn("ordinary warning line");

    expect(baseConsoleWarn).toHaveBeenCalledTimes(1);
    expect(baseConsoleWarn).toHaveBeenCalledWith("ordinary warning line");

    await started.stop();
  });

  it("does not monkey-patch responder methods during shutdown", async () => {
    const responder = {
      createService,
      shutdown,
      advertiseService: vi.fn(),
      announce: vi.fn(),
      probe: vi.fn(),
      republishService: vi.fn(),
    };
    const originalMethods = { ...responder };
    mockCiaoService({ responder });

    const started = await startAdvertiser();
    await started.stop();

    expect(responder.advertiseService).toBe(originalMethods.advertiseService);
    expect(responder.announce).toBe(originalMethods.announce);
    expect(responder.probe).toBe(originalMethods.probe);
    expect(responder.republishService).toBe(originalMethods.republishService);
  });

  it("does not clobber console.log if another wrapper replaced it before shutdown", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const replacementConsoleLog = vi.fn();

    const started = await startAdvertiser();

    console.log = replacementConsoleLog as typeof console.log;
    await started.stop();

    expect(console.log).toBe(replacementConsoleLog);
  });

  it("never overlaps ciao lifecycle states or conflict handling with another advertise call", async () => {
    vi.useFakeTimers();

    const stateRef = { value: "unannounced" };
    const advertise = vi.fn(() => new Promise<void>(() => {}));
    const listenerMap = new Map<string, (value: unknown) => void>();
    const { destroy } = mockCiaoService({ advertise, stateRef, listenerMap });

    const started = await startAdvertiser();

    expect(createService).toHaveBeenCalledTimes(1);
    expect(advertise).toHaveBeenCalledTimes(1);

    for (const state of ["probing", "announcing", "unannounced", "probed", "announced"]) {
      stateRef.value = state;
      await vi.advanceTimersByTimeAsync(60_000);
    }
    listenerMap.get("name-change")?.("test-host (OpenClaw) (2)");
    listenerMap.get("hostname-change")?.("test-host-(2)");
    expectWarnContaining('name conflict resolved; newName="test-host (OpenClaw) (2)"');
    expectWarnContaining('hostname conflict resolved; newHostname="test-host-(2)"');
    expect(createService).toHaveBeenCalledTimes(1);
    expect(advertise).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(warnMessages().join("\n")).not.toMatch(
      /watchdog|restarting advertiser|disabling advertiser/,
    );

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("makes advertiser shutdown idempotent", async () => {
    const cleanupException = vi.fn();
    const cleanupRejection = vi.fn();
    const { destroy } = mockCiaoService();
    registerUncaughtExceptionHandler.mockReturnValue(cleanupException);
    registerUnhandledRejectionHandler.mockReturnValue(cleanupRejection);

    const started = await startAdvertiser();

    await Promise.all([started.stop(), started.stop()]);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cleanupException).toHaveBeenCalledTimes(1);
    expect(cleanupRejection).toHaveBeenCalledTimes(1);
  });

  it("normalizes hostnames with domains for service names", async () => {
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", undefined);
    vi.spyOn(os, "hostname").mockReturnValue("Mac.localdomain");

    const started = await startAdvertiser();

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.name).toBe("Mac (OpenClaw)");
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("Mac");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("Mac.local");

    await started.stop();
  });

  it("falls back to openclaw when system hostname is invalid for DNS", async () => {
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", undefined);
    vi.spyOn(os, "hostname").mockReturnValue("My_Lobster Host");

    const started = await startAdvertiser();

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.hostname).toBe("openclaw");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("openclaw.local");

    await started.stop();
  });

  it("truncates reported Kubernetes service name at the DNS label byte limit", async () => {
    const reportedHostname = "app-41627eae5842473f9e05f139ea307277-7f9477f4d6-lqqzf";
    enableAdvertiserUnitMode(reportedHostname);

    const started = await startAdvertiser();

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    const serviceName = gatewayCall?.[0]?.name as string;
    const hostname = gatewayCall?.[0]?.hostname as string;

    expect(Buffer.byteLength(`${reportedHostname} (OpenClaw)`)).toBe(64);
    expect(hostname).toBe(reportedHostname);
    expect(Buffer.byteLength(serviceName)).toBeLessThanOrEqual(63);

    await started.stop();
  });

  it("truncates host labels exceeding the 63-byte DNS label limit", async () => {
    const longHostname = "app-41627eae5842473f9e05f139ea307277-7f9477f4d6-lqqzf-abcdefghij";
    enableAdvertiserUnitMode(longHostname);

    const started = await startAdvertiser();

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    const serviceName = gatewayCall?.[0]?.name as string;
    const hostname = gatewayCall?.[0]?.hostname as string;

    expect(Buffer.byteLength(longHostname)).toBe(64);
    expect(Buffer.byteLength(hostname)).toBe(63);
    expect(hostname).toBe(longHostname.slice(0, -1));
    expect(hostname).not.toMatch(/-$/);
    expect(Buffer.byteLength(serviceName)).toBeLessThanOrEqual(63);

    await started.stop();
  });

  it("truncates multi-byte hostname within DNS label byte limit", async () => {
    // 21 CJK characters = 63 bytes in UTF-8, adding " (OpenClaw)" pushes over
    const cjkHostname = "你".repeat(21);
    enableAdvertiserUnitMode(cjkHostname);

    const started = await startAdvertiser();

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    const serviceName = gatewayCall?.[0]?.name as string;

    expect(Buffer.byteLength(serviceName)).toBeLessThanOrEqual(63);
    expect(serviceName).not.toMatch(/\uFFFD$/);

    await started.stop();
  });
});
