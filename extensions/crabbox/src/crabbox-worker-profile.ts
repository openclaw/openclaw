import { createHash } from "node:crypto";
import path from "node:path";
import {
  WorkerProviderError,
  type WorkerMachineOption,
  type WorkerProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef, isValidSecretRef } from "openclaw/plugin-sdk/secret-input";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { CRABBOX_HEARTBEAT_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const PROFILE_KEYS = new Set([
  "azureSandboxDiskId",
  "binary",
  "class",
  "desktop",
  "idleTimeout",
  "provider",
  "setup",
  "setupEnv",
  "setupSecrets",
  "ttl",
  "target",
  "warmImage",
]);
const GO_DURATION_PATTERN = /^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
const GO_DURATION_TOKEN_PATTERN = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gu;
const MAX_GO_DURATION_NANOSECONDS = 9_223_372_036_854_775_807n;
const CRABBOX_LEASE_ID_DOMAIN = "openclaw:crabbox-worker-lease-id:v1\0";
const LEGACY_PROVISION_OPERATION_ID_PATTERN = /^provision:[a-f0-9]{64}$/u;
const DURATION_UNIT_NANOSECONDS: Readonly<Record<string, bigint>> = {
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ns: 1n,
};

type CrabboxProfile = {
  azureSandboxDiskId?: string;
  binary?: string;
  class?: string;
  desktop?: boolean;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  idleTimeout: string;
  idleTimeoutMs: number;
  provider: string;
  ttl: string;
  target: CrabboxOperatingSystem;
  setup?: string;
  setupSecrets?: Record<string, SecretRef & { source: "store" }>;
  warmImage?: boolean;
};

const MAX_CRABBOX_MACHINE_CLASS_LENGTH = 128;
const MAX_CRABBOX_MACHINE_OPTIONS = 64;
export const CRABBOX_ENROLLABLE_TARGETS = [
  "linux",
  "windows/wsl2",
  "windows/normal",
  "macos",
] as const;
export type CrabboxOperatingSystem = (typeof CRABBOX_ENROLLABLE_TARGETS)[number];
export const CRABBOX_OS_LABELS: Record<CrabboxOperatingSystem, string> = {
  linux: "Linux",
  "windows/wsl2": "Windows (WSL2)",
  "windows/normal": "Windows",
  macos: "macOS",
};

function parseCrabboxOperatingSystem(value: unknown): CrabboxOperatingSystem {
  if (value === undefined) {
    return "linux";
  }
  const target = nonEmptyString(value);
  const supported = CRABBOX_ENROLLABLE_TARGETS.find((os) => os === target);
  if (supported) {
    return supported;
  }
  throw new WorkerProviderError(
    `Crabbox target must be ${CRABBOX_ENROLLABLE_TARGETS.join(" or ")}`,
  );
}
const CRABBOX_DESKTOP_PROVIDERS = new Set(["aws", "azure", "hetzner"]);

export type CrabboxMachineShape = Readonly<{
  class: string;
  os: CrabboxOperatingSystem;
  cpu?: number;
  memoryGb?: number;
}>;

export const CRABBOX_WORKER_PROVIDER_ID = "crabbox";

function requirePositiveDuration(
  value: unknown,
  key: string,
): { duration: string; milliseconds: number } {
  const duration = nonEmptyString(value);
  const nanoseconds = duration ? parsePositiveGoDurationNanoseconds(duration) : undefined;
  if (!duration || nanoseconds === undefined) {
    throw new WorkerProviderError(
      `Crabbox profile ${key} must be a positive Go duration such as 60m`,
    );
  }
  return { duration, milliseconds: Number(nanoseconds) / 1_000_000 };
}

export function parseCrabboxDurationMs(value: unknown): number | undefined {
  const text = nonEmptyString(value);
  const nanoseconds = text ? parsePositiveGoDurationNanoseconds(text) : undefined;
  return nanoseconds === undefined ? undefined : Number(nanoseconds) / 1_000_000;
}

function parsePositiveGoDurationNanoseconds(duration: string): bigint | undefined {
  if (!GO_DURATION_PATTERN.test(duration)) {
    return undefined;
  }
  let total = 0n;
  for (const match of duration.matchAll(GO_DURATION_TOKEN_PATTERN)) {
    const numberText = match[1];
    const unit = match[2] ? DURATION_UNIT_NANOSECONDS[match[2]] : undefined;
    if (!numberText || unit === undefined) {
      return undefined;
    }
    const [wholeText = "", fractionText = ""] = numberText.split(".", 2);
    const whole = wholeText.replace(/^0+/u, "") || "0";
    if (whole.length > 19) {
      return undefined;
    }
    total += BigInt(whole) * unit;
    const fraction = fractionText.slice(0, 18);
    if (fraction) {
      total += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length);
    }
    if (total > MAX_GO_DURATION_NANOSECONDS) {
      return undefined;
    }
  }
  return total > 0n ? total : undefined;
}

export function heartbeatIntervalMs(idleTimeoutMs: number): number {
  const referenceIntervalMs = Math.max(5_000, Math.min(60_000, idleTimeoutMs / 3));
  // Crabbox's floor can exceed short accepted timeouts. Keep renewal ahead of
  // coordinator idle expiry without changing the profile contract.
  return Math.min(referenceIntervalMs, Math.max(1, Math.floor(idleTimeoutMs / 2)));
}

export function parseCrabboxProfile(profile: Readonly<Record<string, unknown>>): CrabboxProfile {
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new WorkerProviderError(`unknown Crabbox profile setting: ${key}`);
    }
  }

  const provider = nonEmptyString(profile.provider)?.toLowerCase();
  const machineClass = nonEmptyString(profile.class);
  const target = parseCrabboxOperatingSystem(profile.target);
  if (!provider) {
    throw new WorkerProviderError("Crabbox profile provider must be a non-empty string");
  }
  if (profile.class !== undefined && !machineClass) {
    throw new WorkerProviderError("Crabbox profile class must be a non-empty string");
  }
  const { duration: ttl } = requirePositiveDuration(profile.ttl, "ttl");
  const { duration: idleTimeout, milliseconds: idleTimeoutMs } = requirePositiveDuration(
    profile.idleTimeout,
    "idleTimeout",
  );
  const binary = nonEmptyString(profile.binary);
  if (profile.binary !== undefined && !binary) {
    throw new WorkerProviderError("Crabbox profile binary must be a non-empty string");
  }
  if (binary && !path.isAbsolute(binary)) {
    throw new WorkerProviderError("Crabbox profile binary must be an absolute path");
  }
  const setup = nonEmptyString(profile.setup);
  if (profile.setup !== undefined && !setup) {
    throw new WorkerProviderError("Crabbox profile setup must be a non-empty command string");
  }
  if (profile.setupEnv !== undefined) {
    throw new WorkerProviderError(
      "Crabbox profile setupEnv is retired; run openclaw doctor --fix to migrate protected, destination-bound store entries to setupSecrets. Repair any reported entries before provisioning; plaintext forwarding is unavailable.",
    );
  }
  const setupSecrets = parseCrabboxSetupSecrets(profile.setupSecrets);
  const azureSandboxDiskId = nonEmptyString(profile.azureSandboxDiskId);
  if (
    profile.azureSandboxDiskId !== undefined &&
    (provider !== "azure-sandbox" || !azureSandboxDiskId || azureSandboxDiskId.length > 256)
  ) {
    throw new WorkerProviderError(
      "Crabbox Azure Sandbox disk ID requires an azure-sandbox profile and a non-empty string of at most 256 characters",
    );
  }
  const desktop = profile.desktop;
  if (desktop !== undefined && typeof desktop !== "boolean") {
    throw new WorkerProviderError("Crabbox profile desktop must be a boolean");
  }
  if (desktop && !CRABBOX_DESKTOP_PROVIDERS.has(provider)) {
    throw new WorkerProviderError(
      "Crabbox desktop profiles support only AWS, Azure, and coordinator-backed Hetzner",
    );
  }
  const warmImage = profile.warmImage;
  if (warmImage !== undefined && typeof warmImage !== "boolean") {
    throw new WorkerProviderError("Crabbox profile warmImage must be a boolean");
  }
  return {
    ...(azureSandboxDiskId ? { azureSandboxDiskId } : {}),
    binary,
    class: machineClass,
    desktop,
    heartbeatIntervalMs: heartbeatIntervalMs(idleTimeoutMs),
    heartbeatTimeoutMs: Math.min(
      CRABBOX_HEARTBEAT_TIMEOUT_MS,
      Math.max(1, Math.floor(idleTimeoutMs / 2)),
    ),
    idleTimeout,
    idleTimeoutMs,
    provider,
    setup,
    setupSecrets,
    ttl,
    target,
    warmImage,
  };
}

/** Existing pre-egress leases retain inspection/release, never new setup or capture. */
export function parseCrabboxCleanupProfile(profile: WorkerProfile): CrabboxProfile {
  const { setupEnv: retiredSetupEnv, ...settings } = profile;
  const parsed = parseCrabboxProfile(settings);
  if (retiredSetupEnv !== undefined) {
    parsed.warmImage = false;
  }
  return parsed;
}

export function parseCrabboxSetupSecrets(value: unknown): CrabboxProfile["setupSecrets"] {
  if (value === undefined) {
    return undefined;
  }
  const entries = asOptionalRecord(value);
  if (!entries) {
    throw new WorkerProviderError("Crabbox profile setupSecrets must be a map of store SecretRefs");
  }
  if (Object.keys(entries).length > 16) {
    throw new WorkerProviderError("Crabbox profile setupSecrets must contain at most 16 names");
  }
  const parsed: NonNullable<CrabboxProfile["setupSecrets"]> = {};
  for (const [name, ref] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new WorkerProviderError(
        "Crabbox profile setupSecrets keys must be valid POSIX environment variable names",
      );
    }
    if (
      [
        "CRABBOX_ENV_ALLOW",
        "HOME",
        "PATH",
        "LANG",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
        "REQUESTS_CA_BUNDLE",
        "NODE_USE_ENV_PROXY",
        "CRABBOX_SETUP_PROXY",
      ].includes(name) ||
      /^(?:https?|all|no)_proxy$/iu.test(name) ||
      name.startsWith("OPENCLAW_")
    ) {
      throw new WorkerProviderError(`Crabbox profile setupSecrets name ${name} is reserved`);
    }
    if (!isSecretRef(ref) || !isValidSecretRef(ref) || ref.source !== "store") {
      throw new WorkerProviderError(
        `Crabbox profile setupSecrets entry ${name} must use a store SecretRef { source: "store", provider, id }; inline values and other sources are unavailable`,
      );
    }
    parsed[name] = { source: "store", provider: ref.provider, id: ref.id };
  }
  return parsed;
}

// Resolve defaults only after sizing is known: placement and enrolled lease classes
// must share the same policy during provisioning and teardown.
export function resolveCrabboxWarmImageProfile(
  profile: CrabboxProfile,
  machineClass = profile.class,
  target = profile.target,
) {
  if (target === "windows/wsl2" && profile.desktop) {
    throw new WorkerProviderError(
      "Crabbox WSL2 does not support desktops; select native Windows for a desktop viewer",
    );
  }
  return {
    ...profile,
    class: machineClass,
    target,
    warmImage: target === "linux" && (profile.warmImage ?? machineClass !== undefined),
  };
}

export function resolveCrabboxWarmImageProfileKey(
  profile: CrabboxProfile,
  projectKey?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backendProvider: profile.provider,
        ...(profile.azureSandboxDiskId ? { azureSandboxDiskId: profile.azureSandboxDiskId } : {}),
        // Missing target in persisted Linux keys already means Linux.
        ...(profile.target !== "linux" ? { target: profile.target } : {}),
        setup: profile.setup ?? "",
        setupSecretMode: "protected-egress-v1",
        setupSecrets: Object.entries(profile.setupSecrets ?? {}).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
        desktop: profile.desktop ?? false,
        // Exact class is intentionally conservative; cross-class reuse comes later.
        machineClass: profile.class,
        ...(projectKey ? { projectKey } : {}),
      }),
    )
    .digest("hex");
}

export function resolveCrabboxPreparationTarget(
  profile: WorkerProfile,
  machineClass?: string,
  os?: string,
) {
  const parsed = parseCrabboxProfile(profile);
  const effective = resolveCrabboxWarmImageProfile(
    parsed,
    machineClass ?? parsed.class,
    os === undefined ? parsed.target : parseCrabboxOperatingSystem(os),
  );
  return supportsResolvedCrabboxProjectPreparation(effective) &&
    effective.class &&
    effective.target === "linux"
    ? {
        machineClass: effective.class,
        platform: effective.target,
        profileKey: resolveCrabboxWarmImageProfileKey(effective),
      }
    : undefined;
}

export function supportsCrabboxProjectPreparation(
  profile: WorkerProfile,
  machineClass?: string,
  os?: string,
): boolean {
  const parsed = parseCrabboxProfile(profile);
  const resolved = resolveCrabboxWarmImageProfile(
    parsed,
    machineClass ?? parsed.class,
    os === undefined ? parsed.target : parseCrabboxOperatingSystem(os),
  );
  return supportsResolvedCrabboxProjectPreparation(resolved);
}

function supportsResolvedCrabboxProjectPreparation(resolved: CrabboxProfile): boolean {
  return (
    Boolean(resolved.warmImage) ||
    Object.keys(resolved.setupSecrets ?? {}).length > 0 ||
    Boolean(
      resolved.provider === "azure-sandbox" &&
      resolved.azureSandboxDiskId &&
      resolved.target === "linux" &&
      resolved.class,
    )
  );
}

export function resolveCrabboxPreparedIdleTimeoutMs(profile: WorkerProfile): number | undefined {
  const parsed = parseCrabboxProfile(profile);
  // The pool passes original settings; placement may supply the required machine class.
  return (parsed.warmImage === false && !parsed.azureSandboxDiskId) || parsed.target !== "linux"
    ? undefined
    : parsed.idleTimeoutMs;
}

// Setup belongs to the configured target's interpreter, not the requested OS.
// POSIX-to-POSIX portability remains the profile author's responsibility.
export function isCrabboxSetupTargetCompatible(
  profile: CrabboxProfile,
  target: CrabboxOperatingSystem,
): boolean {
  return !profile.setup || (profile.target === "windows/normal") === (target === "windows/normal");
}

type CrabboxProvisionProfile = CrabboxProfile &
  ({ warmImage: false } | { warmImage: true; class: string });

export function resolveCrabboxProvisionProfile(
  profile: WorkerProfile,
  requestedClassValue: unknown,
  requestedOsValue?: unknown,
): { profile: CrabboxProvisionProfile } {
  const configured = parseCrabboxProfile(profile);
  const requestedClass = nonEmptyString(requestedClassValue);
  if (
    requestedClassValue !== undefined &&
    (!requestedClass || requestedClass.length > MAX_CRABBOX_MACHINE_CLASS_LENGTH)
  ) {
    throw new WorkerProviderError(
      "Crabbox machine class must be a non-empty string of at most 128 characters",
    );
  }
  const resolved = resolveCrabboxWarmImageProfile(
    configured,
    requestedClass ?? configured.class,
    requestedOsValue === undefined
      ? configured.target
      : parseCrabboxOperatingSystem(requestedOsValue),
  );
  if (!isCrabboxSetupTargetCompatible(configured, resolved.target)) {
    const shell = resolved.target === "windows/normal" ? "PowerShell" : "POSIX";
    throw new WorkerProviderError(
      `Crabbox profile setup for ${configured.target} cannot run on ${resolved.target}; select a profile with settings.target=${resolved.target} and a compatible ${shell} setup command`,
    );
  }
  let provisionProfile: CrabboxProvisionProfile;
  if (!resolved.warmImage) {
    provisionProfile = { ...resolved, warmImage: false };
  } else {
    // Resolve immutable sizing before allocation and replay.
    if (!resolved.class) {
      throw new WorkerProviderError(
        "Crabbox warmImage requires a configured class or a placement machine class",
      );
    }
    provisionProfile = { ...resolved, class: resolved.class, warmImage: true };
  }
  return {
    profile: provisionProfile,
  };
}

export function listCrabboxMachineOptions(
  configuredClass: string | undefined,
  shapes: readonly CrabboxMachineShape[] = [],
): readonly WorkerMachineOption[] {
  const seen = new Set<string>();
  const options: WorkerMachineOption[] = [];
  for (const os of CRABBOX_ENROLLABLE_TARGETS) {
    const candidates = shapes.filter((shape) => {
      const key = `${shape.os}:${shape.class}`;
      if (
        shape.os !== os ||
        shape.class.length > MAX_CRABBOX_MACHINE_CLASS_LENGTH ||
        seen.has(key)
      ) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (candidates.length === 0) {
      continue;
    }
    const remaining = MAX_CRABBOX_MACHINE_OPTIONS - options.length;
    const reserveDefault =
      configuredClass !== undefined &&
      !candidates.slice(0, remaining).some((shape) => shape.class === configuredClass);
    for (const shape of candidates.slice(0, Math.max(0, remaining - Number(reserveDefault)))) {
      options.push({
        id: shape.class,
        os,
        label: shape.class.replace(/^./u, (initial) => initial.toUpperCase()),
        ...(shape.cpu !== undefined ? { cpu: shape.cpu } : {}),
        ...(shape.memoryGb !== undefined ? { memoryGb: shape.memoryGb } : {}),
        ...(shape.class === configuredClass ? { default: true } : {}),
      });
    }
    if (reserveDefault && remaining > 0 && configuredClass !== undefined) {
      options.push({ id: configuredClass, os, label: configuredClass, default: true });
    }
  }
  return options;
}

export function buildCrabboxAllocationArgs(
  profile: CrabboxProfile,
  leaseId: string,
  slug: string,
): string[] {
  const args = [
    "--provider",
    profile.provider,
    ...(profile.azureSandboxDiskId ? ["--azure-sandbox-disk-id", profile.azureSandboxDiskId] : []),
    "--network",
    "public",
    "--tailscale=false",
    ...(profile.class ? ["--class", profile.class] : []),
    ...(profile.target === "linux" ? ["--target", "linux"] : []),
    ...(profile.target === "windows/wsl2" ? ["--target", "windows", "--windows-mode", "wsl2"] : []),
    ...(profile.target === "windows/normal"
      ? ["--target", "windows", "--windows-mode", "normal"]
      : []),
    ...(profile.target === "macos" ? ["--target", "macos", "--market", "on-demand"] : []),
    "--ttl",
    profile.ttl,
    "--idle-timeout",
    profile.idleTimeout,
    "--lease-id",
    leaseId,
    "--slug",
    slug,
    "--keep=true",
  ];
  if (profile.desktop) {
    args.push("--desktop");
    if (profile.target === "linux") {
      args.push("--browser", "--desktop-env", "xfce");
    }
  }
  return args;
}

export function resolveOpenClawRoot(pluginRoot: string | undefined): string {
  if (!pluginRoot) {
    return process.cwd();
  }
  const extensionsDir = path.dirname(pluginRoot);
  if (path.basename(extensionsDir) !== "extensions") {
    return process.cwd();
  }
  const extensionParent = path.dirname(extensionsDir);
  return path.basename(extensionParent) === "dist" ||
    path.basename(extensionParent) === "dist-runtime"
    ? path.dirname(extensionParent)
    : extensionParent;
}

export function operationSlug(operationId: string): string {
  return `openclaw-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

const LEASE_ID_PATTERN = /^(?:cbx_|tbx_)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function assertCrabboxLeaseId(leaseId: string): void {
  if (!LEASE_ID_PATTERN.test(leaseId)) {
    throw new Error("Crabbox lease id is invalid");
  }
}

export function operationLeaseId(operationId: string): string {
  if (!operationId.trim()) {
    throw new Error("Crabbox provision requires an operation id");
  }
  if (LEGACY_PROVISION_OPERATION_ID_PATTERN.test(operationId)) {
    // Historical random allocation can exist without a recorded handle; refusing replay
    // must not terminalize unresolved cleanup responsibility.
    throw new Error(
      "Legacy Crabbox provision state cannot be replayed safely; clean up any prior lease and dispatch again",
    );
  }
  return `cbx_${createHash("sha256")
    .update(CRABBOX_LEASE_ID_DOMAIN)
    .update(operationId)
    .digest("hex")
    .slice(0, 12)}`;
}
