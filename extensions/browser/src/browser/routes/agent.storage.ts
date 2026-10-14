import {
  asNullableRecord,
  readNonBlankString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import { createPlaywrightRouteRegistrar } from "./agent.playwright.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readOptionalRouteFiniteNumber, readRouteFiniteNumber } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { readHttpOrigin, toBoolean, toStringOrEmpty } from "./utils.js";

type StorageKind = "local" | "session";

type CookieSetOptions = Parameters<PwAiModule["cookiesSetViaPlaywright"]>[0]["cookie"];

function parseStorageKind(raw: string): StorageKind {
  if (raw === "local" || raw === "session") {
    return raw;
  }
  throw new Error("kind must be local|session");
}

function assertRange(
  value: number | undefined,
  fieldName: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}.`);
  }
  return value;
}

function readOptionalHttpOrigin(raw: unknown): string | undefined {
  const value = toStringOrEmpty(raw);
  if (!value) {
    return undefined;
  }
  const origin = readHttpOrigin(value);
  if (!origin) {
    throw new Error("origin must be an http(s) origin");
  }
  return origin;
}

function parseCookieSetOptions(cookie: Record<string, unknown>): CookieSetOptions {
  return {
    name: toStringOrEmpty(cookie.name),
    value: toStringOrEmpty(cookie.value),
    url: toStringOrEmpty(cookie.url) || undefined,
    domain: toStringOrEmpty(cookie.domain) || undefined,
    path: toStringOrEmpty(cookie.path) || undefined,
    expires: readOptionalRouteFiniteNumber(cookie.expires, "cookie.expires"),
    httpOnly: toBoolean(cookie.httpOnly) ?? undefined,
    secure: toBoolean(cookie.secure) ?? undefined,
    sameSite:
      cookie.sameSite === "Lax" || cookie.sameSite === "None" || cookie.sameSite === "Strict"
        ? cookie.sameSite
        : undefined,
  };
}

function parseGeolocationOptions(body: Record<string, unknown>) {
  const clear = toBoolean(body.clear) ?? false;
  if (clear) {
    return { clear };
  }
  const origin = readOptionalHttpOrigin(body.origin);
  const latitude = assertRange(
    readRouteFiniteNumber(body.latitude, "latitude"),
    "latitude",
    -90,
    90,
  );
  const longitude = assertRange(
    readRouteFiniteNumber(body.longitude, "longitude"),
    "longitude",
    -180,
    180,
  );
  const accuracy = readRouteFiniteNumber(body.accuracy, "accuracy");
  if (accuracy !== undefined && accuracy < 0) {
    throw new Error("accuracy must be non-negative.");
  }
  if (latitude === undefined || longitude === undefined) {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  return { clear, latitude, longitude, accuracy, origin };
}

export function registerBrowserAgentStorageRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  const register = createPlaywrightRouteRegistrar(app, ctx, "state");

  register(
    "get",
    "/cookies",
    "cookies",
    () =>
      (pw, { cdpUrl, targetId }) =>
        pw.cookiesGetViaPlaywright({ cdpUrl, targetId }),
  );

  register("post", "/cookies/set", "cookies set", (body) => {
    const cookie = asNullableRecord(body.cookie);
    if (!cookie) {
      throw new Error("cookie is required");
    }
    const parsedCookie = parseCookieSetOptions(cookie);
    return (pw, target) => pw.cookiesSetViaPlaywright({ ...target, cookie: parsedCookie });
  });

  register("post", "/cookies/set-many", "cookies set-many", (body) => {
    const rawCookies = body.cookies;
    if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
      throw new Error("cookies must be a non-empty array");
    }
    const cookieRecords: Record<string, unknown>[] = [];
    for (const cookie of rawCookies) {
      const record = asNullableRecord(cookie);
      if (!record) {
        throw new Error("cookies must contain only cookie objects");
      }
      cookieRecords.push(record);
    }
    const cookies = cookieRecords.map(parseCookieSetOptions);
    return async (pw, target, signal) => {
      const { added } = await pw.cookiesSetManyViaPlaywright({ ...target, cookies, signal });
      return { added };
    };
  });

  register(
    "post",
    "/cookies/clear",
    "cookies clear",
    () => (pw, target) => pw.cookiesClearViaPlaywright(target),
  );

  register("get", "/storage/:kind", "storage get", (input, params) => {
    const kind = parseStorageKind(toStringOrEmpty(params.kind));
    const key = readNonBlankString(readStringValue(input.key) ?? toStringOrEmpty(input.key));
    return (pw, { cdpUrl, targetId }) =>
      pw.storageGetViaPlaywright({ cdpUrl, targetId, kind, key });
  });

  register("post", "/storage/:kind/set", "storage set", (body, params) => {
    const kind = parseStorageKind(toStringOrEmpty(params.kind));
    const key = readNonBlankString(readStringValue(body.key) ?? toStringOrEmpty(body.key));
    if (!key) {
      throw new Error("key is required");
    }
    const value = typeof body.value === "string" ? body.value : "";
    return (pw, target) => pw.storageSetViaPlaywright({ ...target, kind, key, value });
  });

  register("post", "/storage/:kind/clear", "storage clear", (_body, params) => {
    const kind = parseStorageKind(toStringOrEmpty(params.kind));
    return (pw, target) => pw.storageClearViaPlaywright({ ...target, kind });
  });

  register("post", "/set/offline", "offline", (body) => {
    const offline = toBoolean(body.offline);
    if (offline === undefined) {
      throw new Error("offline is required");
    }
    return (pw, target) => pw.setOfflineViaPlaywright({ ...target, offline });
  });

  register("post", "/set/headers", "headers", (body) => {
    const headers = asNullableRecord(body.headers);
    if (!headers) {
      throw new Error("headers is required");
    }
    const parsed: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") {
        parsed[k] = v;
      }
    }
    return (pw, target) => pw.setExtraHTTPHeadersViaPlaywright({ ...target, headers: parsed });
  });

  register("post", "/set/credentials", "http credentials", (body) => {
    const clear = toBoolean(body.clear) ?? false;
    const username = toStringOrEmpty(body.username) || undefined;
    const password = readStringValue(body.password);
    return (pw, target) =>
      pw.setHttpCredentialsViaPlaywright({ ...target, username, password, clear });
  });

  register("post", "/set/geolocation", "geolocation", (body) => {
    const geolocation = parseGeolocationOptions(body);
    return (pw, target) => pw.setGeolocationViaPlaywright({ ...target, ...geolocation });
  });

  register(
    "post",
    "/set/media",
    "media emulation",
    (body) => {
      const schemeRaw = toStringOrEmpty(body.colorScheme);
      const colorScheme =
        schemeRaw === "dark" || schemeRaw === "light" || schemeRaw === "no-preference"
          ? schemeRaw
          : schemeRaw === "none"
            ? null
            : undefined;
      if (colorScheme === undefined) {
        throw new Error("colorScheme must be dark|light|no-preference|none");
      }
      return (pw, target) => pw.emulateMediaViaPlaywright({ ...target, colorScheme });
    },
    EXISTING_SESSION_LIMITS.emulation,
  );

  register(
    "post",
    "/set/timezone",
    "timezone",
    (body) => {
      const timezoneId = toStringOrEmpty(body.timezoneId);
      if (!timezoneId) {
        throw new Error("timezoneId is required");
      }
      return (pw, target) => pw.setTimezoneViaPlaywright({ ...target, timezoneId });
    },
    EXISTING_SESSION_LIMITS.emulation,
  );

  register(
    "post",
    "/set/locale",
    "locale",
    (body) => {
      const locale = toStringOrEmpty(body.locale);
      if (!locale) {
        throw new Error("locale is required");
      }
      return (pw, target) => pw.setLocaleViaPlaywright({ ...target, locale });
    },
    EXISTING_SESSION_LIMITS.emulation,
  );

  register(
    "post",
    "/set/device",
    "device emulation",
    (body) => {
      const name = toStringOrEmpty(body.name);
      if (!name) {
        throw new Error("name is required");
      }
      return (pw, target, signal) => pw.setDeviceViaPlaywright({ ...target, name, signal });
    },
    EXISTING_SESSION_LIMITS.emulation,
  );
}
