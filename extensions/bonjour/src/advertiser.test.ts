// Bonjour tests cover advertiser plugin behavior.
import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
const dnsLabelEncoder = new TextEncoder();

const asString = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

function expectDnsLabelByteLength(value: string, expected: number) {
  expect(dnsLabelEncoder.encode(value).byteLength).toBe(expected);
}

function expectDnsLabelWithinLimit(value: string) {
  expect(dnsLabelEncoder.encode(value).byteLength).toBeLessThanOrEqual(63);
}

function warnMessages(): string[] {
  return logger.warn.mock.calls.map(([message]) => String(message));
}

function expectWarnContaining(fragment: string) {
  expect(warnMessages().join("\n")).toContain(fragment);
}

function mockCall(mock: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call;
}

function enableAdvertiserUnitMode(hostname = "test-host") {
  // Allow advertiser to run in unit tests.
  delete process.env.VITEST;
  process.env.NODE_ENV = "development";
  vi.spyOn(os, "hostname").mockReturnValue(hostname);
  process.env.OPENCLAW_MDNS_HOSTNAME = hostname;
}

function mockCiaoService(params?: {
  advertise?: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
  serviceState?: string;
  stateRef?: { value: string };
  on?: ReturnType<typeof vi.fn>;
  listenerMap?: Map<string, (value: unknown) => void>;
  responder?: Record<string, unknown>;
}) {
  const advertise = params?.advertise ?? vi.fn().mockResolvedValue(undefined);
  const destroy = params?.destroy ?? vi.fn().mockResolvedValue(undefined);
  const on =
    params?.on ??
    vi.fn((event: string, listener: (value: unknown) => void) => {
      params?.listenerMap?.set(event, listener);
    });
  createService.mockImplementation((options: Record<string, unknown>) => {
    const service = {
      advertise,
      destroy,
      on,
      getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
      getHostname: () => asString(options.hostname, "unknown"),
      getPort: () => Number(options.port ?? -1),
    };
    Object.defineProperty(service, "serviceState", {
      configurable: true,
      enumerable: true,
      get: () => params?.stateRef?.value ?? params?.serviceState ?? "announced",
      set: (value: string) => {
        if (params?.stateRef) {
          params.stateRef.value = value;
        }
      },
    });
    return service;
  });
  getResponder.mockReturnValue(params?.responder ?? { createService, shutdown });
  return { advertise, destroy, on };
}

vi.mock("@homebridge/ciao", () => {
  return {
    Protocol: { TCP: "tcp" },
    getResponder,
  };
});

const { startGatewayBonjourAdvertiser } = await import("./advertiser.js");

afterAll(() => {
  vi.doUnmock("@homebridge/ciao");
  vi.resetModules();
});

type StartGatewayBonjourAdvertiser = typeof startGatewayBonjourAdvertiser;

const startAdvertiser = (
  opts: Parameters<StartGatewayBonjourAdvertiser>[0],
): ReturnType<StartGatewayBonjourAdvertiser> =>
  startGatewayBonjourAdvertiser(opts, {
    logger,
    registerUncaughtExceptionHandler: (handler) => registerUncaughtExceptionHandler(handler),
    registerUnhandledRejectionHandler: (handler) => registerUnhandledRejectionHandler(handler),
  });

describe("gateway bonjour advertiser", () => {
  type ServiceCall = {
    name?: unknown;
    hostname?: unknown;
    domain?: unknown;
    txt?: unknown;
  };

  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitest = process.env.VITEST;
  const originalOpenClawMdnsHostname = process.env.OPENCLAW_MDNS_HOSTNAME;
  const originalOpenClawDisableBonjour = process.env.OPENCLAW_DISABLE_BONJOUR;
  const originalFlyMachineId = process.env.FLY_MACHINE_ID;
  const originalFlyAppName = process.env.FLY_APP_NAME;

  function restoreBonjourTestEnv() {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    if (originalOpenClawMdnsHostname === undefined) {
      delete process.env.OPENCLAW_MDNS_HOSTNAME;
    } else {
      process.env.OPENCLAW_MDNS_HOSTNAME = originalOpenClawMdnsHostname;
    }
    if (originalOpenClawDisableBonjour === undefined) {
      delete process.env.OPENCLAW_DISABLE_BONJOUR;
    } else {
      process.env.OPENCLAW_DISABLE_BONJOUR = originalOpenClawDisableBonjour;
    }
    if (originalFlyMachineId === undefined) {
      delete process.env.FLY_MACHINE_ID;
    } else {
      process.env.FLY_MACHINE_ID = originalFlyMachineId;
    }
    if (originalFlyAppName === undefined) {
      delete process.env.FLY_APP_NAME;
    } else {
      process.env.FLY_APP_NAME = originalFlyAppName;
    }
  }

  afterEach(() => {
    restoreBonjourTestEnv();

    createService.mockClear();
    getResponder.mockReset();
    shutdown.mockClear();
    registerUncaughtExceptionHandler.mockClear();
    registerUnhandledRejectionHandler.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.debug.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    let resolveAdvertise = () => {};
    const advertise = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          resolveAdvertise = resolve;
        }),
    );
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      gatewayDirectReachable: true,
      tailnetDns: "host.tailnet.ts.net",
      cliPath: "/opt/homebrew/bin/openclaw",
      minimal: false,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    const [gatewayCall] = createService.mock.calls as Array<[Record<string, unknown>]>;
    expect(gatewayCall?.[0]?.type).toBe("openclaw-gw");
    const gatewayType = asString(gatewayCall?.[0]?.type, "");
    expect(gatewayType.length).toBeLessThanOrEqual(15);
    expect(gatewayCall?.[0]?.port).toBe(18789);
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("test-host");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("test-host.local");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.gatewayPort).toBe("18789");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.gatewayDirectReachable).toBe("1");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.sshPort).toBe("2222");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.tailnetDns).toBe(
      "host.tailnet.ts.net",
    );
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.cliPath).toBe(
      "/opt/homebrew/bin/openclaw",
    );
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.transport).toBe("gateway");

    // We don't await `advertise()`, but it should still be called for each service.
    expect(advertise).toHaveBeenCalledTimes(1);
    resolveAdvertise();
    await Promise.resolve();

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("omits cliPath and sshPort in minimal mode", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
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
    enableAdvertiserUnitMode();
    process.env.OPENCLAW_DISABLE_BONJOUR = "true";

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("auto-disables Bonjour in detected containers", async () => {
    enableAdvertiserUnitMode();
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => String(filePath) === "/.dockerenv");

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("auto-disables Bonjour on Fly Machines without Docker sentinel files", async () => {
    enableAdvertiserUnitMode();
    process.env.FLY_MACHINE_ID = "3d8d5459a03038";
    process.env.FLY_APP_NAME = "openclaw-clawcks-test";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("auto-disables Bonjour in Cloudflare Cloudchamber containers", async () => {
    enableAdvertiserUnitMode();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/cloudchamber_v2/00000000-0000-0000-0000-000000000000_oci\n",
    );

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).not.toHaveBeenCalled();
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("does not treat cloudchamber.service as a container marker", async () => {
    enableAdvertiserUnitMode();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/system.slice/cloudchamber.service\n");
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    await started.stop();
  });

  it("honors explicit Bonjour opt-in inside detected containers", async () => {
    enableAdvertiserUnitMode();
    process.env.OPENCLAW_DISABLE_BONJOUR = "0";
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => String(filePath) === "/.dockerenv");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).toHaveBeenCalledTimes(1);

    await started.stop();
  });

  it("attaches conflict listeners for services", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const onCalls: Array<{ event: string }> = [];

    const on = vi.fn((event: string) => {
      onCalls.push({ event });
    });
    mockCiaoService({ advertise, destroy, on });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    // 1 service × 2 listeners
    expect(onCalls.map((c) => c.event)).toEqual(["name-change", "hostname-change"]);

    await started.stop();
  });

  it("cleans up ciao process handlers after shutdown", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    shutdown.mockImplementation(async () => {
      order.push("shutdown");
    });
    mockCiaoService({ advertise, destroy });

    const cleanupException = vi.fn(() => {
      order.push("cleanup-exception");
    });
    const cleanupRejection = vi.fn(() => {
      order.push("cleanup-rejection");
    });
    registerUncaughtExceptionHandler.mockImplementation(() => cleanupException);
    registerUnhandledRejectionHandler.mockImplementation(() => cleanupRejection);

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    await started.stop();

    expect(registerUncaughtExceptionHandler).toHaveBeenCalledTimes(1);
    expect(registerUnhandledRejectionHandler).toHaveBeenCalledTimes(1);
    expect(cleanupException).toHaveBeenCalledTimes(1);
    expect(cleanupRejection).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["shutdown", "cleanup-exception", "cleanup-rejection"]);
  });

  it("handles ciao netmask assertions at the bonjour caller", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const exceptionHandler = mockCall(registerUncaughtExceptionHandler).at(0) as
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

  it("logs advertise failures and retries via watchdog", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom")) // initial advertise fails
      .mockResolvedValue(undefined); // watchdog retry succeeds
    mockCiaoService({ advertise, destroy, serviceState: "unannounced" });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    // initial advertise attempt happens immediately
    expect(advertise).toHaveBeenCalledTimes(1);

    // allow promise rejection handler to run
    await Promise.resolve();
    expectWarnContaining("advertise failed");

    // watchdog first retries, then recreates the advertiser after the service
    // stays unhealthy across multiple 5s ticks.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(advertise).toHaveBeenCalledTimes(3);
    expect(createService).toHaveBeenCalledTimes(2);

    await started.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(3);
  });

  it("handles advertise throwing synchronously", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn(() => {
      throw new Error("sync-fail");
    });
    mockCiaoService({ advertise, destroy, serviceState: "unannounced" });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(advertise).toHaveBeenCalledTimes(1);
    expectWarnContaining("advertise threw");

    await started.stop();
  });

  it("suppresses ciao self-probe retry console noise while advertising", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const originalConsoleLog = console.log;
    const baseConsoleLog = vi.fn();
    console.log = baseConsoleLog as typeof console.log;

    try {
      const started = await startAdvertiser({
        gatewayPort: 18789,
        sshPort: 2222,
      });

      console.log(
        "[test._openclaw-gw._tcp.local.] failed probing with reason: Error: Can't probe for a service which is announced already. Received announcing for service test._openclaw-gw._tcp.local.. Trying again in 2 seconds!",
      );
      console.log("ordinary console line");

      expect(baseConsoleLog).toHaveBeenCalledTimes(1);
      expect(baseConsoleLog).toHaveBeenCalledWith("ordinary console line");

      await started.stop();
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it("does not monkey-patch responder methods during shutdown", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const responder = {
      createService,
      shutdown,
      advertiseService: vi.fn(),
      announce: vi.fn(),
      probe: vi.fn(),
      republishService: vi.fn(),
    };
    const originalMethods = {
      advertiseService: responder.advertiseService,
      announce: responder.announce,
      probe: responder.probe,
      republishService: responder.republishService,
    };
    mockCiaoService({ advertise, destroy, responder });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });
    await started.stop();

    expect(responder.advertiseService).toBe(originalMethods.advertiseService);
    expect(responder.announce).toBe(originalMethods.announce);
    expect(responder.probe).toBe(originalMethods.probe);
    expect(responder.republishService).toBe(originalMethods.republishService);
  });

  it("does not clobber console.log if another wrapper replaced it before shutdown", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const originalConsoleLog = console.log;
    const baseConsoleLog = vi.fn();
    const replacementConsoleLog = vi.fn();
    console.log = baseConsoleLog as typeof console.log;

    try {
      const started = await startAdvertiser({
        gatewayPort: 18789,
        sshPort: 2222,
      });

      console.log = replacementConsoleLog as typeof console.log;
      await started.stop();

      expect(console.log).toBe(replacementConsoleLog);
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it("recreates the advertiser when ciao gets stuck announcing", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "announcing" };
    const events: string[] = [];
    const cleanupException = vi.fn();
    const cleanupRejection = vi.fn();
    let advertiseCount = 0;
    const destroy = vi.fn().mockImplementation(async () => {
      events.push("destroy");
    });
    const advertise = vi.fn().mockImplementation(() => {
      advertiseCount += 1;
      events.push(`advertise:${advertiseCount}`);
      if (advertiseCount === 1) {
        stateRef.value = "announcing";
        return new Promise<void>(() => {});
      }
      stateRef.value = "announced";
      return Promise.resolve();
    });
    mockCiaoService({ advertise, destroy, stateRef });
    registerUncaughtExceptionHandler.mockImplementation(() => cleanupException);
    registerUnhandledRejectionHandler.mockImplementation(() => cleanupRejection);

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    expect(advertise).toHaveBeenCalledTimes(1);
    expect(registerUncaughtExceptionHandler).toHaveBeenCalledTimes(1);
    expect(registerUnhandledRejectionHandler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25_000);

    expectWarnContaining("restarting advertiser");
    expect(createService).toHaveBeenCalledTimes(2);
    expect(advertise).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
    expect(cleanupException).not.toHaveBeenCalled();
    expect(cleanupRejection).not.toHaveBeenCalled();
    expect(events).toEqual(["advertise:1", "destroy", "advertise:2"]);

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cleanupException).toHaveBeenCalledTimes(1);
    expect(cleanupRejection).toHaveBeenCalledTimes(1);
  });

  it("treats probing-to-announcing churn as one unhealthy window", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "probing" };
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy, stateRef });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    expect(advertise).toHaveBeenCalledTimes(1);

    setTimeout(() => {
      stateRef.value = "announcing";
    }, 10_000);

    await vi.advanceTimersByTimeAsync(25_000);

    expectWarnContaining("service stuck in announcing");
    expect(createService).toHaveBeenCalledTimes(2);
    expect(advertise).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();

    await started.stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not re-advertise while ciao is still probing", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "probing" };
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy, stateRef });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(advertise).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(advertise).toHaveBeenCalledTimes(1);
    expect(createService).toHaveBeenCalledTimes(1);
    expect(warnMessages().join("\n")).not.toContain(
      "watchdog detected non-announced service; attempting re-advertise",
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expectWarnContaining("service stuck in probing");
    expect(createService).toHaveBeenCalledTimes(2);

    await started.stop();
  });

  it("defers probing recovery while a name conflict is still settling", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "probing" };
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const listenerMap = new Map<string, (value: unknown) => void>();
    mockCiaoService({ advertise, destroy, stateRef, listenerMap });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    listenerMap.get("name-change")?.("test-host (OpenClaw) (2)");

    await vi.advanceTimersByTimeAsync(15_000);

    expect(createService).toHaveBeenCalledTimes(1);
    expectWarnContaining('name conflict resolved; newName="test-host (OpenClaw) (2)"');

    await vi.advanceTimersByTimeAsync(20_000);

    expectWarnContaining("service stuck in probing");
    expect(createService).toHaveBeenCalledTimes(2);

    await started.stop();
  });

  it("disables bonjour for the process after repeated stuck advertiser restarts", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "announcing" };
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn(() => new Promise<void>(() => {}));
    mockCiaoService({ advertise, destroy, stateRef });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    await vi.advanceTimersByTimeAsync(55_000);

    expectWarnContaining("disabling advertiser after 1 stuck-state restart");
    expect(createService).toHaveBeenCalledTimes(2);
    expect(advertise).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(createService).toHaveBeenCalledTimes(2);
    expect(advertise).toHaveBeenCalledTimes(2);

    await started.stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("disables bonjour when the advertiser flaps within a sliding window", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "announced" };
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy, stateRef });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    for (let cycle = 0; cycle < 12; cycle += 1) {
      stateRef.value = "announced";
      await vi.advanceTimersByTimeAsync(5_000);
      stateRef.value = "probing";
      await vi.advanceTimersByTimeAsync(25_000);
      if (
        logger.warn.mock.calls.some(
          (call) => typeof call[0] === "string" && call[0].includes("disabling advertiser after"),
        )
      ) {
        break;
      }
    }

    const disableLog = logger.warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("disabling advertiser after"),
    );
    if (!disableLog) {
      throw new Error("expected advertiser disable warning after repeated restarts");
    }
    expect(String(disableLog[0])).toMatch(/restarts within \d+ minutes/);

    const advertiseCallsAtDisable = advertise.mock.calls.length;
    const createServiceCallsAtDisable = createService.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(advertise).toHaveBeenCalledTimes(advertiseCallsAtDisable);
    expect(createService).toHaveBeenCalledTimes(createServiceCallsAtDisable);

    await started.stop();
  });

  it("normalizes hostnames with domains for service names", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("Mac.localdomain");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.name).toBe("Mac (OpenClaw)");
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("Mac");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("Mac.local");

    await started.stop();
  });

  it("falls back to openclaw when system hostname is invalid for DNS", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    delete process.env.OPENCLAW_MDNS_HOSTNAME;
    vi.spyOn(os, "hostname").mockReturnValue("My_Lobster Host");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.hostname).toBe("openclaw");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("openclaw.local");

    await started.stop();
  });

  it("truncates reported Kubernetes service name at the DNS label byte limit", async () => {
    const reportedHostname = "app-41627eae5842473f9e05f139ea307277-7f9477f4d6-lqqzf";
    enableAdvertiserUnitMode(reportedHostname);

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    const serviceName = gatewayCall?.[0]?.name as string;
    const hostname = gatewayCall?.[0]?.hostname as string;

    expectDnsLabelByteLength(`${reportedHostname} (OpenClaw)`, 64);
    expect(hostname).toBe(reportedHostname);
    expectDnsLabelWithinLimit(serviceName);

    await started.stop();
  });

  it("truncates host labels exceeding the 63-byte DNS label limit", async () => {
    const longHostname = "app-41627eae5842473f9e05f139ea307277-7f9477f4d6-lqqzf-abcdefghij";
    enableAdvertiserUnitMode(longHostname);

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    const serviceName = gatewayCall?.[0]?.name as string;
    const hostname = gatewayCall?.[0]?.hostname as string;

    expectDnsLabelByteLength(longHostname, 64);
    expectDnsLabelByteLength(hostname, 63);
    expect(hostname).toBe(longHostname.slice(0, -1));
    expect(hostname).not.toMatch(/-$/);
    expectDnsLabelWithinLimit(serviceName);

    await started.stop();
  });

  it("truncates multi-byte hostname within DNS label byte limit", async () => {
    // 21 CJK characters = 63 bytes in UTF-8, adding " (OpenClaw)" pushes over
    const cjkHostname = "你".repeat(21);
    enableAdvertiserUnitMode(cjkHostname);

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    const serviceName = gatewayCall?.[0]?.name as string;

    expectDnsLabelWithinLimit(serviceName);
    expect(serviceName).not.toMatch(/\uFFFD$/);

    await started.stop();
  });

  it("uses system hostname when OPENCLAW_MDNS_HOSTNAME is unset", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    delete process.env.OPENCLAW_MDNS_HOSTNAME;
    vi.spyOn(os, "hostname").mockReturnValue("Lobster");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.hostname).toBe("Lobster");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("Lobster.local");

    await started.stop();
  });
});
