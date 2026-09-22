import path from "node:path";
import { z } from "zod";
import {
  BROWSER_NATIVE_HOST_NAME,
  BROWSER_NATIVE_HOST_DESCRIPTION,
} from "./extension-native-host.constants.js";
import { parseStrictJsonObject } from "./extension-relay/auth-v2.js";
import { isValidProfileName } from "./profiles.js";

export const WINDOWS_MANAGEMENT_LIMIT = 32768;
export const WINDOWS_NATIVE_EXE = "OpenClaw.BrowserBootstrap.exe";
export const WINDOWS_BINDING = "OpenClaw.BrowserBootstrap.binding.json";
export const WINDOWS_RECEIPT = "OpenClaw.BrowserBootstrap.owned.json";
export const WINDOWS_MANIFEST = BROWSER_NATIVE_HOST_NAME + ".json";
export const WINDOWS_OFFICIAL_ORIGIN = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
const windowsPathKey = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const sameWindowsPath = (a: string, b: string) => windowsPathKey(a) === windowsPathKey(b);
// In Unicode mode, paired surrogates form a scalar and do not match this range.
const wellFormed = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
export function isWindowsNativePath(value: string): boolean {
  if (
    !value ||
    value.length > 4096 ||
    !wellFormed(value) ||
    !/^[a-z]:\\/i.test(value) ||
    value !== path.win32.normalize(value) ||
    value.includes("/") ||
    value.slice(2).includes(":")
  ) {
    return false;
  }
  if (value.length > 3 && value.endsWith("\\")) {
    return false;
  }
  return value
    .slice(3)
    .split("\\")
    .filter(Boolean)
    .every(
      (part) =>
        Array.from(part).every((character) => character.charCodeAt(0) >= 32) &&
        !/[<>:"|?*]/u.test(part) &&
        part.trim() === part &&
        !part.endsWith(".") &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part),
    );
}
export const windowsPathSchema = z.string().refine(isWindowsNativePath);
const generationSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .refine((s) => s !== "00000000-0000-0000-0000-000000000000");
export const sidSchema = z
  .string()
  .max(184)
  .refine((value) => {
    if (!/^S-1-(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*)){1,15}$/.test(value)) {
      return false;
    }
    const parts = value.split("-").slice(2).map(BigInt);
    return (
      parts[0]! <= 281474976710655n &&
      parts.slice(1).every((v) => v <= 4294967295n) &&
      !["S-1-5-18", "S-1-5-19", "S-1-5-20"].includes(value)
    );
  });
export const originsSchema = z
  .array(z.string().regex(/^chrome-extension:\/\/[a-p]{32}\/$/))
  .min(1)
  .max(32)
  .refine(
    (values) =>
      values.includes(WINDOWS_OFFICIAL_ORIGIN) &&
      values.every((value, i) => i === 0 || values[i - 1]! < value),
  );
export const nativeWindowsContextSchema = z.strictObject({
  nodePath: windowsPathSchema.refine((v) => windowsPathKey(path.win32.basename(v)) === "node.exe"),
  cliPath: windowsPathSchema.refine(
    (v) => windowsPathKey(path.win32.basename(v)) === "openclaw.mjs",
  ),
  stateDir: windowsPathSchema,
  configPath: windowsPathSchema,
  browserProfile: z.string().refine(isValidProfileName),
});
export type NativeWindowsContext = z.infer<typeof nativeWindowsContextSchema>;
const modeSchema = z.enum(["companion-managed-wsl", "native-windows-cli"]);
const actionSchema = z.enum(["inspect", "install", "uninstall"]);
const storeActionSchema = z.enum(["preserve", "request", "remove"]);
const modeContext = (value: {
  mode: string;
  context: NativeWindowsContext | null;
  expectedOrigins: string[];
}) =>
  value.mode === "native-windows-cli"
    ? value.context !== null
    : value.context === null &&
      value.expectedOrigins.length === 1 &&
      value.expectedOrigins[0] === WINDOWS_OFFICIAL_ORIGIN;
export const managementRequestSchema = z
  .strictObject({
    v: z.literal(1),
    action: actionSchema,
    mode: modeSchema,
    context: nativeWindowsContextSchema.nullable(),
    expectedOrigins: originsSchema,
    store: storeActionSchema,
  })
  .refine(modeContext)
  .refine((r) =>
    r.action === "inspect"
      ? r.store === "preserve"
      : r.action === "install"
        ? r.store !== "remove"
        : r.store !== "request",
  );
export type WindowsManagementRequest = z.infer<typeof managementRequestSchema>;
export const installationSchema = z
  .strictObject({
    generation: generationSchema,
    manifestPath: windowsPathSchema,
    launcherPath: windowsPathSchema,
    bindingPath: windowsPathSchema,
    receiptPath: windowsPathSchema,
  })
  .refine((v) => {
    const dir = path.win32.dirname(v.manifestPath);
    return (
      path.win32.basename(dir) === v.generation &&
      v.manifestPath === path.win32.join(dir, WINDOWS_MANIFEST) &&
      v.launcherPath === path.win32.join(dir, WINDOWS_NATIVE_EXE) &&
      v.bindingPath === path.win32.join(dir, WINDOWS_BINDING) &&
      v.receiptPath === path.win32.join(dir, WINDOWS_RECEIPT)
    );
  });
export type WindowsInstallation = z.infer<typeof installationSchema>;
const managementResponseSchema = z
  .strictObject({
    v: z.literal(1),
    ok: z.boolean(),
    code: z.enum([
      "ok",
      "invalid_request",
      "context_conflict",
      "foreign_registration",
      "unsafe_path",
      "unsafe_acl",
      "binding_invalid",
      "browser_control_disabled",
      "transport_failed",
      "busy",
      "cancelled",
      "io_error",
      "platform_unsupported",
    ]),
    registration: z.enum(["missing", "owned", "foreign", "invalid"]).nullable(),
    mode: modeSchema.nullable(),
    store: z.enum(["missing", "requested", "foreign", "invalid"]).nullable(),
    installation: installationSchema.nullable(),
  })
  .refine((r) => r.ok === (r.code === "ok"))
  .refine((r) =>
    r.registration === "owned" ? r.mode !== null : r.mode === null && r.installation === null,
  )
  .refine(
    (r) =>
      !["invalid_request", "platform_unsupported", "busy"].includes(r.code) ||
      [r.registration, r.mode, r.store, r.installation].every((v) => v === null),
  );
export type WindowsManagementResponse = z.infer<typeof managementResponseSchema>;
export const bindingSchema = z
  .strictObject({
    version: z.literal(1),
    mode: modeSchema,
    manifestPath: windowsPathSchema,
    expectedOrigins: originsSchema,
    nativeWindows: nativeWindowsContextSchema.nullable(),
  })
  .refine((b) => modeContext({ ...b, context: b.nativeWindows }));
export const receiptSchema = z.strictObject({
  owner: z.literal("openclaw-browser-native-host"),
  version: z.literal(1),
  generation: generationSchema,
  ownerSid: sidSchema,
  transportVerified: z.literal(true),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const windowsManifestSchema = z.strictObject({
  name: z.literal(BROWSER_NATIVE_HOST_NAME),
  description: z.literal(BROWSER_NATIVE_HOST_DESCRIPTION),
  path: windowsPathSchema,
  type: z.literal("stdio"),
  allowed_origins: originsSchema,
});

/** Reuse the browser's duplicate-key owner; version tokens and UTF-8 are ABI-specific. */
export function parseWindowsJson(bytes: Buffer, compact = false): Record<string, unknown> {
  if (
    !bytes.length ||
    bytes.length > WINDOWS_MANAGEMENT_LIMIT ||
    bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
  ) {
    throw new Error("Invalid Windows management JSON");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const tokens = /"(?:\\.|[^"\\])*"/g;
  let invalidString = false;
  const outside = text.replace(tokens, (token) => {
    const value: unknown = JSON.parse(token);
    if (typeof value !== "string" || !wellFormed(value)) {
      invalidString = true;
    }
    return '""';
  });
  if (
    invalidString ||
    (compact && /\s/u.test(outside)) ||
    [...outside.matchAll(/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g)].some(
      (m) => m[0] !== "1",
    )
  ) {
    throw new Error("Invalid Windows management JSON");
  }
  const result = parseStrictJsonObject(text);
  if (!result) {
    throw new Error("Invalid Windows management JSON");
  }
  return result;
}

export function parseWindowsManagementResponse(
  bytes: Buffer,
  exitCode: number | null,
  request: WindowsManagementRequest,
): WindowsManagementResponse {
  if (bytes.length > WINDOWS_MANAGEMENT_LIMIT || bytes.at(-1) !== 10) {
    throw new Error("Invalid management frame");
  }
  const r = managementResponseSchema.parse(parseWindowsJson(bytes.subarray(0, -1), true));
  if (
    exitCode !== (r.ok ? 0 : 1) ||
    (r.installation && r.mode !== request.mode) ||
    (r.code === "context_conflict" && r.installation)
  ) {
    throw new Error("Invalid management receipt");
  }
  if (r.ok) {
    const owned = r.registration === "owned" && r.mode === request.mode && r.installation !== null;
    if (
      request.action === "install" &&
      (!owned || (request.store === "request" && r.store !== "requested"))
    ) {
      throw new Error("Incomplete install");
    }
    if (
      request.action === "uninstall" &&
      (r.registration !== "missing" || (request.store === "remove" && r.store !== "missing"))
    ) {
      throw new Error("Incomplete uninstall");
    }
    if (
      request.action === "inspect" &&
      ((!owned && r.registration !== "missing") ||
        !["missing", "requested"].includes(r.store ?? ""))
    ) {
      throw new Error("Incomplete inspection");
    }
  }
  return r;
}
