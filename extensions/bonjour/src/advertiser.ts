import fs from "node:fs";
import os from "node:os";
import type { CiaoService } from "@homebridge/ciao";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
} from "openclaw/plugin-sdk/runtime";
import { parseBooleanValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { classifyCiaoProcessError } from "./ciao.js";
import { formatBonjourError } from "./errors.js";

type GatewayBonjourAdvertiser = {
  stop: () => Promise<void>;
};

type GatewayBonjourAdvertiseOpts = {
  instanceName?: string;
  gatewayPort: number;
  sshPort?: number;
  gatewayTlsEnabled?: boolean;
  gatewayTlsFingerprintSha256?: string;
  gatewayDirectReachable?: boolean;
  tailnetDns?: string;
  cliPath?: string;
  minimal?: boolean;
};

const CIAO_SELF_PROBE_RETRY_FRAGMENT =
  "failed probing with reason: Error: Can't probe for a service which is announced already.";

// Ciao already treats EADDRNOTAVAIL / EHOSTDOWN / ENETUNREACH / EHOSTUNREACH /
// EPERM / EINVAL as transient socket errors and keeps the socket valid, but
// ENODEV (device gone — a short-lived Docker bridge removed between interface
// polls) is not in that set, so ciao logs a full warning stack trace per send.
const CIAO_MDNS_SOCKET_ERROR_FRAGMENT = "Encountered MDNS socket error on socket";
const CIAO_ENODEV_SOCKET_ERROR_FRAGMENT = "send ENODEV";

function isContainerEnvironment() {
  if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) {
    return true;
  }

  for (const sentinelPath of ["/.dockerenv", "/run/.containerenv", "/var/run/.containerenv"]) {
    if (fs.existsSync(sentinelPath)) {
      return true;
    }
  }

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/u.test(
      cgroup,
    );
  } catch {
    return false;
  }
}

function isDisabledByEnv() {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.VITEST) {
    return true;
  }
  return parseBooleanValue(process.env.OPENCLAW_DISABLE_BONJOUR) ?? isContainerEnvironment();
}

function resolveSystemMdnsHostname(): string | null {
  let raw: string;
  try {
    raw = os.hostname();
  } catch {
    return null;
  }
  const firstLabel =
    raw
      .trim()
      .replace(/\.local$/i, "")
      .split(".")[0]
      ?.trim() ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(firstLabel)) {
    return null;
  }
  return firstLabel;
}

const MAX_DNS_LABEL_BYTES = 63;
function truncateToDnsLabel(name: string, fallback = "OpenClaw"): string {
  if (Buffer.byteLength(name) <= MAX_DNS_LABEL_BYTES) {
    return name;
  }
  return truncateUtf8Prefix(name, MAX_DNS_LABEL_BYTES).replace(/-+$/, "").trim() || fallback;
}

function safeServiceName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? truncateToDnsLabel(trimmed) : "OpenClaw";
}

function prettifyInstanceName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized.replace(/\s+\(OpenClaw\)\s*$/i, "").trim() || normalized;
}

function serviceSummary(label: string, svc: CiaoService): string {
  return `${label} fqdn=${svc.getFQDN()} host=${svc.getHostname()} port=${svc.getPort()} state=${svc.serviceState}`;
}

function installCiaoConsoleNoiseFilter(): () => void {
  const previousConsoleLog = console.log;
  const previousConsoleWarn = console.warn;
  const logWrapper = (...args: unknown[]) => {
    if (
      args.some((arg) => typeof arg === "string" && arg.includes(CIAO_SELF_PROBE_RETRY_FRAGMENT))
    ) {
      return;
    }
    previousConsoleLog(...args);
  };
  const warnWrapper = (...args: unknown[]) => {
    if (
      args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(CIAO_MDNS_SOCKET_ERROR_FRAGMENT) &&
          arg.includes(CIAO_ENODEV_SOCKET_ERROR_FRAGMENT),
      )
    ) {
      return;
    }
    previousConsoleWarn(...args);
  };
  console.log = logWrapper;
  console.warn = warnWrapper;
  return () => {
    if (console.log === logWrapper) {
      console.log = previousConsoleLog;
    }
    if (console.warn === warnWrapper) {
      console.warn = previousConsoleWarn;
    }
  };
}

export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
  logger: Pick<PluginLogger, "info" | "warn">,
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }

  let restoreConsoleLog: () => void = () => {};
  let cleanupUnhandledRejection: (() => void) | undefined;
  let cleanupUncaughtException: (() => void) | undefined;

  function cleanupProcessHandlers() {
    cleanupUncaughtException?.();
    cleanupUnhandledRejection?.();
  }

  try {
    const { getResponder } = await import("@homebridge/ciao");
    restoreConsoleLog = installCiaoConsoleNoiseFilter();
    const handleCiaoProcessError = (reason: unknown): boolean => {
      const classification = classifyCiaoProcessError(reason);
      if (!classification) {
        return false;
      }

      if (classification.kind === "interface-enumeration-failure") {
        // Restricted sandboxes can refuse os.networkInterfaces(); mDNS cannot
        // function without it, so surface a single warning and skip recovery.
        // Recovery would just re-enter the same failing syscall.
        logger.warn(
          `bonjour: disabling mDNS — networkInterfaces() unavailable in this environment: ${classification.formatted}`,
        );
      } else {
        logger.warn(`bonjour: suppressing ciao netmask assertion: ${classification.formatted}`);
      }
      return true;
    };
    cleanupUnhandledRejection = registerUnhandledRejectionHandler(handleCiaoProcessError);
    cleanupUncaughtException = registerUncaughtExceptionHandler(handleCiaoProcessError);

    const hostnameRaw =
      process.env.OPENCLAW_MDNS_HOSTNAME?.trim() || resolveSystemMdnsHostname() || "openclaw";
    const hostnameWithoutLocal = hostnameRaw.replace(/\.local$/i, "");
    const dotIndex = hostnameWithoutLocal.indexOf(".");
    const labelEnd = dotIndex === -1 ? hostnameWithoutLocal.length : dotIndex;
    const hostnameLabel = hostnameWithoutLocal.slice(0, labelEnd).trim() || "openclaw";
    const hostname = truncateToDnsLabel(hostnameLabel, "openclaw");
    const instanceName = opts.instanceName?.trim() || `${hostname} (OpenClaw)`;
    const displayName = prettifyInstanceName(instanceName);

    const gatewayTxt: Record<string, string> = {
      role: "gateway",
      gatewayPort: String(opts.gatewayPort),
      lanHost: `${hostname}.local`,
      displayName,
    };
    if (opts.gatewayTlsEnabled) {
      gatewayTxt.gatewayTls = "1";
      if (opts.gatewayTlsFingerprintSha256) {
        gatewayTxt.gatewayTlsSha256 = opts.gatewayTlsFingerprintSha256;
      }
    }
    if (opts.gatewayDirectReachable) {
      gatewayTxt.gatewayDirectReachable = "1";
    }
    if (!opts.minimal && opts.tailnetDns?.trim()) {
      gatewayTxt.tailnetDns = opts.tailnetDns.trim();
    }
    if (!opts.minimal && opts.cliPath?.trim()) {
      gatewayTxt.cliPath = opts.cliPath.trim();
    }

    gatewayTxt.transport = "gateway";
    if (!opts.minimal) {
      gatewayTxt.sshPort = String(opts.sshPort ?? 22);
    }

    const responder = getResponder();

    function handleAdvertiseFailure(
      label: string,
      svc: CiaoService,
      err: unknown,
      action: "failed" | "threw",
    ) {
      const classification = classifyCiaoProcessError(err);
      if (classification) {
        logger.warn(
          `bonjour: advertise ${action} with ciao ${classification.kind} (${serviceSummary(
            label,
            svc,
          )}): ${classification.formatted}`,
        );
        return;
      }
      logger.warn(
        `bonjour: advertise ${action} (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`,
      );
    }

    const gateway = responder.createService({
      name: safeServiceName(instanceName),
      type: "openclaw-gw",
      port: opts.gatewayPort,
      domain: "local",
      hostname,
      txt: gatewayTxt,
    });
    gateway.on("name-change", (name) => {
      logger.warn(`bonjour: gateway name conflict resolved; newName=${JSON.stringify(name)}`);
    });
    gateway.on("hostname-change", (nextHostname) => {
      logger.warn(
        `bonjour: gateway hostname conflict resolved; newHostname=${JSON.stringify(nextHostname)}`,
      );
    });
    try {
      void gateway
        .advertise()
        .then(() => {
          logger.info(`bonjour: advertised ${serviceSummary("gateway", gateway)}`);
        })
        .catch((err: unknown) => {
          handleAdvertiseFailure("gateway", gateway, err, "failed");
        });
    } catch (err) {
      handleAdvertiseFailure("gateway", gateway, err, "threw");
    }
    let stopPromise: Promise<void> | null = null;

    return {
      stop: () => {
        stopPromise ??= (async () => {
          try {
            await gateway.destroy();
          } catch {
            /* ignore */
          }
          try {
            await responder.shutdown();
          } catch {
            /* ignore */
          }
          restoreConsoleLog();
          cleanupProcessHandlers();
        })();
        return stopPromise;
      },
    };
  } catch (err) {
    restoreConsoleLog();
    cleanupProcessHandlers();
    throw err;
  }
}
