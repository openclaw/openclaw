import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createService,
  getResponder,
  shutdown,
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
  logger,
} = vi.hoisted(() => ({
  createService: vi.fn(),
  getResponder: vi.fn(),
  shutdown: vi.fn(),
  registerUncaughtExceptionHandler: vi.fn(),
  registerUnhandledRejectionHandler: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn() },
}));

const stringOrFallback = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

function expectWarnContaining(fragment: string) {
  expect(warnMessages()).toContain(fragment);
}
const warnMessages = () => logger.warn.mock.calls.map(([message]) => String(message)).join("\n");

function expectCalledOnce(...functions: ReturnType<typeof vi.fn>[]) {
  for (const fn of functions) {
    expect(fn).toHaveBeenCalledTimes(1);
  }
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
  getResponder.mockReturnValue({ createService, shutdown });
  return { destroy };
}

vi.mock("@homebridge/ciao", () => ({ getResponder }));
vi.mock("openclaw/plugin-sdk/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime")>()),
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
}));

const { startGatewayBonjourAdvertiser } = await import("./advertiser.js");

afterAll(() => {
  vi.doUnmock("@homebridge/ciao");
  vi.doUnmock("openclaw/plugin-sdk/runtime");
  vi.resetModules();
});

let advertiser: Awaited<ReturnType<typeof startGatewayBonjourAdvertiser>> | undefined;
async function startAdvertiser(
  opts: Partial<Parameters<typeof startGatewayBonjourAdvertiser>[0]> = {},
) {
  return (advertiser = await startGatewayBonjourAdvertiser(
    { gatewayPort: 18789, sshPort: 2222, ...opts },
    logger,
  ));
}

function serviceOptions() {
  const call = createService.mock.calls[0];
  if (!call) {
    throw new Error("expected Bonjour service creation");
  }
  return call[0] as {
    name: string;
    hostname: string;
    domain: string;
    txt: Record<string, string>;
  };
}

async function expectDisabled() {
  const started = await startAdvertiser();
  expect(createService).not.toHaveBeenCalled();
  await expect(started.stop()).resolves.toBeUndefined();
}

async function expectConsoleFilter(method: "log" | "warn", noise: string) {
  const original = vi.spyOn(console, method).mockImplementation(() => {});
  await startAdvertiser();
  console[method](noise);
  console[method]("ordinary console line");
  expect(original).toHaveBeenCalledTimes(1);
  expect(original).toHaveBeenCalledWith("ordinary console line");
}

describe("gateway bonjour advertiser", () => {
  beforeEach(() => {
    enableAdvertiserUnitMode();
    mockCiaoService();
  });

  afterEach(async () => {
    await advertiser?.stop();
    advertiser = undefined;
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    const pending = Promise.withResolvers<void>();
    const advertise = vi.fn(() => pending.promise);
    const { destroy } = mockCiaoService({ advertise });
    const started = await startAdvertiser({
      gatewayDirectReachable: true,
      tailnetDns: "host.tailnet.ts.net",
      cliPath: "/opt/homebrew/bin/openclaw",
      minimal: false,
    });
    expectCalledOnce(createService);
    expect(serviceOptions()).toMatchObject({
      type: "openclaw-gw",
      port: 18789,
      domain: "local",
      hostname: "test-host",
      txt: {
        lanHost: "test-host.local",
        gatewayPort: "18789",
        gatewayDirectReachable: "1",
        sshPort: "2222",
        tailnetDns: "host.tailnet.ts.net",
        cliPath: "/opt/homebrew/bin/openclaw",
        transport: "gateway",
      },
    });
    expectCalledOnce(advertise);
    pending.resolve();
    await Promise.resolve();
    await started.stop();
    expectCalledOnce(destroy, shutdown);
  });

  it("omits cliPath and sshPort in minimal mode", async () => {
    await startAdvertiser({
      cliPath: "/opt/homebrew/bin/openclaw",
      tailnetDns: "host.tailnet.ts.net",
      minimal: true,
    });
    const { txt } = serviceOptions();
    expect(txt.sshPort).toBeUndefined();
    expect(txt.cliPath).toBeUndefined();
    expect(txt.tailnetDns).toBeUndefined();
  });

  it("honors truthy OPENCLAW_DISABLE_BONJOUR values", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", "true");
    await expectDisabled();
  });

  it("auto-disables Bonjour in detected containers", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => String(filePath) === "/.dockerenv");
    await expectDisabled();
  });

  it("auto-disables Bonjour on Fly Machines without Docker sentinel files", async () => {
    vi.stubEnv("FLY_MACHINE_ID", "3d8d5459a03038");
    vi.stubEnv("FLY_APP_NAME", "openclaw-clawcks-test");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockReturnValue("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");
    await expectDisabled();
  });

  it("honors explicit Bonjour opt-in inside detected containers", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", "0");
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => String(filePath) === "/.dockerenv");
    await startAdvertiser();
    expectCalledOnce(createService);
  });

  it("cleans up ciao process handlers after shutdown", async () => {
    const order: string[] = [];
    shutdown.mockImplementation(async () => void order.push("shutdown"));
    const cleanupException = vi.fn(() => void order.push("cleanup-exception"));
    const cleanupRejection = vi.fn(() => void order.push("cleanup-rejection"));
    registerUncaughtExceptionHandler.mockReturnValue(cleanupException);
    registerUnhandledRejectionHandler.mockReturnValue(cleanupRejection);
    const started = await startAdvertiser();
    await started.stop();
    expectCalledOnce(
      registerUncaughtExceptionHandler,
      registerUnhandledRejectionHandler,
      cleanupException,
      cleanupRejection,
    );
    expect(order).toEqual(["shutdown", "cleanup-exception", "cleanup-rejection"]);
  });

  it("handles ciao netmask assertions at the bonjour caller", async () => {
    await startAdvertiser();
    const exceptionHandler = registerUncaughtExceptionHandler.mock.calls[0]?.[0] as
      | ((reason: unknown) => boolean)
      | undefined;
    expect(exceptionHandler).toBeTypeOf("function");
    const error = Object.assign(
      new Error(
        "IP address version must match. Netmask cannot have a version different from the address!",
      ),
      { name: "AssertionError" },
    );
    expect(exceptionHandler?.(error)).toBe(true);
    expectWarnContaining("suppressing ciao netmask assertion");
  });

  it("handles wrapped interface enumeration failures without hiding unrelated process errors", async () => {
    await startAdvertiser();
    const inner = Object.assign(
      new Error("A system error occurred: uv_interface_addresses returned Unknown system error 1"),
      { name: "SystemError" },
    );
    const wrapper = new Error("ciao NetworkManager init failed", { cause: inner });
    for (const registration of [
      registerUncaughtExceptionHandler,
      registerUnhandledRejectionHandler,
    ]) {
      const handler = registration.mock.calls[0]?.[0];
      if (typeof handler !== "function") {
        throw new Error("expected Bonjour process error handler");
      }
      for (const error of [wrapper, inner]) {
        logger.warn.mockClear();
        expect(handler(error)).toBe(true);
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          "bonjour: disabling mDNS — networkInterfaces() unavailable in this environment: SystemError: A system error occurred: uv_interface_addresses returned Unknown system error 1",
        );
      }
      logger.warn.mockClear();
      expect(handler(new Error("boom"))).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it.each([
    [Object.assign(new Error("   "), { name: "AbortError" }), "AbortError"],
    [new Error("   "), "Error"],
    [new Error(""), "Error"],
    ["boom", "boom"],
    [42, "42"],
  ])("formats advertise rejection %j as %s", async (error, formatted) => {
    const advertise = vi.fn().mockRejectedValue(error);
    mockCiaoService({ advertise, serviceState: "unannounced" });
    await startAdvertiser();
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      `bonjour: advertise failed (gateway fqdn=openclaw-gw.local. host=test-host port=18789 state=unannounced): ${formatted}`,
    );
  });

  it("logs advertise failures without starting a competing retry loop", async () => {
    vi.useFakeTimers();
    const advertise = vi.fn().mockRejectedValue(new Error("boom"));
    mockCiaoService({ advertise, serviceState: "unannounced" });
    const started = await startAdvertiser();
    expectCalledOnce(advertise);
    await Promise.resolve();
    expectWarnContaining("advertise failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expectCalledOnce(advertise, createService);
    await started.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expectCalledOnce(advertise);
  });

  it("handles advertise throwing synchronously", async () => {
    const advertise = vi.fn(() => {
      throw new Error("sync-fail");
    });
    mockCiaoService({ advertise, serviceState: "unannounced" });
    await startAdvertiser();
    expectCalledOnce(advertise);
    expectWarnContaining("advertise threw");
  });

  it("suppresses ciao self-probe retry console noise while advertising", async () => {
    await expectConsoleFilter(
      "log",
      "[test._openclaw-gw._tcp.local.] failed probing with reason: Error: Can't probe for a service which is announced already. Received announcing for service test._openclaw-gw._tcp.local.. Trying again in 2 seconds!",
    );
  });

  it("suppresses transient ciao ENODEV MDNS socket warnings while advertising", async () => {
    await expectConsoleFilter(
      "warn",
      "Encountered MDNS socket error on socket 'br-abcdef123456': Error: send ENODEV 224.0.0.251:5353\n    at ...",
    );
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
    expectCalledOnce(createService, advertise);
    for (const state of ["probing", "announcing", "unannounced", "probed", "announced"]) {
      stateRef.value = state;
      await vi.advanceTimersByTimeAsync(60_000);
    }
    listenerMap.get("name-change")?.("test-host (OpenClaw) (2)");
    listenerMap.get("hostname-change")?.("test-host-(2)");
    expectWarnContaining('name conflict resolved; newName="test-host (OpenClaw) (2)"');
    expectWarnContaining('hostname conflict resolved; newHostname="test-host-(2)"');
    expectCalledOnce(createService, advertise);
    expect(destroy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(warnMessages()).not.toMatch(/watchdog|restarting advertiser|disabling advertiser/);
    await started.stop();
    expectCalledOnce(destroy, shutdown);
  });

  it("makes advertiser shutdown idempotent", async () => {
    const cleanupException = vi.fn();
    const cleanupRejection = vi.fn();
    const { destroy } = mockCiaoService();
    registerUncaughtExceptionHandler.mockReturnValue(cleanupException);
    registerUnhandledRejectionHandler.mockReturnValue(cleanupRejection);
    const started = await startAdvertiser();
    await Promise.all([started.stop(), started.stop()]);
    expectCalledOnce(destroy, shutdown, cleanupException, cleanupRejection);
  });

  it("normalizes hostnames with domains for service names", async () => {
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", undefined);
    vi.spyOn(os, "hostname").mockReturnValue("Mac.localdomain");
    await startAdvertiser();
    expect(serviceOptions()).toMatchObject({
      name: "Mac (OpenClaw)",
      domain: "local",
      hostname: "Mac",
      txt: { lanHost: "Mac.local" },
    });
  });

  it("falls back to openclaw when system hostname is invalid for DNS", async () => {
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", undefined);
    vi.spyOn(os, "hostname").mockReturnValue("My_Lobster Host");
    await startAdvertiser();
    expect(serviceOptions()).toMatchObject({
      hostname: "openclaw",
      txt: { lanHost: "openclaw.local" },
    });
  });

  it("truncates host labels exceeding the 63-byte DNS label limit", async () => {
    const longHostname = "app-41627eae5842473f9e05f139ea307277-7f9477f4d6-lqqzf-abcdefghij";
    enableAdvertiserUnitMode(longHostname);
    await startAdvertiser();
    const { name, hostname } = serviceOptions();
    expect(Buffer.byteLength(longHostname)).toBe(64);
    expect(Buffer.byteLength(hostname)).toBe(63);
    expect(hostname).toBe(longHostname.slice(0, -1));
    expect(hostname).not.toMatch(/-$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  });

  it("truncates multi-byte hostname within DNS label byte limit", async () => {
    const cjkHostname = "你".repeat(21);
    enableAdvertiserUnitMode(cjkHostname);
    await startAdvertiser();
    const { name } = serviceOptions();
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).not.toMatch(/\uFFFD$/);
  });
});
