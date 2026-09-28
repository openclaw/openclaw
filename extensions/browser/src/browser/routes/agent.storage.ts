/**
 * Browser storage and context mutation routes.
 *
 * Parses and applies cookies, local/session storage, geolocation, permissions,
 * and related browser-context mutations for the selected profile/tab.
 */

import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import {
  asNullableRecord,
  normalizeOptionalString,
  readNonBlankString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { InteractionTargetOptions } from "../pw-tools-core.interactions.navigation.js";
import type { BrowserRouteContext } from "../server-context.js";
import { readBody, resolveProfileContext, withPlaywrightRouteContext } from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readOptionalRouteFiniteNumber, readRouteFiniteNumber } from "./route-numeric.js";
import type { BrowserRequest, BrowserRouteRegistrar } from "./types.js";
import { jsonError, readHttpOrigin, toBoolean, toStringOrEmpty } from "./utils.js";

type StorageKind = "local" | "session";

type GeolocationOptions = {
  clear: boolean;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
};

type CookieSetOptions = Parameters<PwAiModule["cookiesSetViaPlaywright"]>[0]["cookie"];

/** Parse the supported browser storage bucket names. */
function parseStorageKind(raw: string): StorageKind | null {
  if (raw === "local" || raw === "session") {
    return raw;
  }
  return null;
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

/** Parse cookie options accepted by browser storage mutation routes. */
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

/** Parse geolocation override options accepted by context mutation routes. */
function parseGeolocationOptions(body: Record<string, unknown>): GeolocationOptions {
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
  if (!clear && (latitude === undefined || longitude === undefined)) {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  return { clear, latitude, longitude, accuracy, origin };
}

/** Register storage and browser-context mutation endpoints. */
export function registerBrowserAgentStorageRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  type Mutation = (
    pw: PwAiModule,
    target: InteractionTargetOptions,
    signal: AbortSignal,
  ) => Promise<void | Record<string, unknown>>;

  const registerMutation = (
    path: string,
    feature: string,
    prepare: (body: Record<string, unknown>, params: BrowserRequest["params"]) => Mutation,
    existingSessionUnsupported?: string,
  ) => {
    app.post(path, async (req, res) => {
      const body = readBody(req);
      const targetId = normalizeOptionalString(body.targetId);
      let run: Mutation;
      try {
        run = prepare(body, req.params);
      } catch (err) {
        return jsonError(res, 400, formatErrorMessage(err));
      }
      const profileCtx = existingSessionUnsupported
        ? resolveProfileContext(req, res, ctx)
        : undefined;
      if (profileCtx === null) {
        return;
      }
      if (
        existingSessionUnsupported &&
        profileCtx &&
        getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp
      ) {
        return jsonError(res, 501, existingSessionUnsupported);
      }
      // Mutations intentionally do not apply the tab-scoped read/export URL guard.
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        profileCtx,
        targetId,
        feature,
        run: async (context) => {
          const result = await run(
            context.pw,
            {
              ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {}),
              cdpUrl: context.cdpUrl,
              targetId: context.tab.targetId,
            },
            context.signal,
          );
          context.signal.throwIfAborted();
          res.json({ ok: true, targetId: context.tab.targetId, ...result });
        },
      });
    });
  };

  app.get("/cookies", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);
    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "cookies",
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, pw, signal }) => {
        const result = await pw.cookiesGetViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
        });
        signal.throwIfAborted();
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
    });
  });

  registerMutation("/cookies/set", "cookies set", (body) => {
    const cookie = asNullableRecord(body.cookie);
    if (!cookie) {
      throw new Error("cookie is required");
    }
    const parsedCookie = parseCookieSetOptions(cookie);
    return (pw, target) => pw.cookiesSetViaPlaywright({ ...target, cookie: parsedCookie });
  });

  registerMutation("/cookies/set-many", "cookies set-many", (body) => {
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

  registerMutation(
    "/cookies/clear",
    "cookies clear",
    () => (pw, target) => pw.cookiesClearViaPlaywright(target),
  );

  app.get("/storage/:kind", async (req, res) => {
    const kind = parseStorageKind(toStringOrEmpty(req.params.kind));
    if (!kind) {
      return jsonError(res, 400, "kind must be local|session");
    }
    const targetId = normalizeOptionalString(req.query.targetId);
    const key = readNonBlankString(
      readStringValue(req.query.key) ?? toStringOrEmpty(req.query.key),
    );

    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      targetId,
      feature: "storage get",
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, pw, signal }) => {
        const result = await pw.storageGetViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          kind,
          key,
        });
        signal.throwIfAborted();
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
    });
  });

  registerMutation("/storage/:kind/set", "storage set", (body, params) => {
    const kind = parseStorageKind(toStringOrEmpty(params.kind));
    if (!kind) {
      throw new Error("kind must be local|session");
    }
    const key = readNonBlankString(readStringValue(body.key) ?? toStringOrEmpty(body.key));
    if (!key) {
      throw new Error("key is required");
    }
    const value = typeof body.value === "string" ? body.value : "";
    return (pw, target) => pw.storageSetViaPlaywright({ ...target, kind, key, value });
  });

  registerMutation("/storage/:kind/clear", "storage clear", (_body, params) => {
    const kind = parseStorageKind(toStringOrEmpty(params.kind));
    if (!kind) {
      throw new Error("kind must be local|session");
    }
    return (pw, target) => pw.storageClearViaPlaywright({ ...target, kind });
  });

  registerMutation("/set/offline", "offline", (body) => {
    const offline = toBoolean(body.offline);
    if (offline === undefined) {
      throw new Error("offline is required");
    }
    return (pw, target) => pw.setOfflineViaPlaywright({ ...target, offline });
  });

  registerMutation("/set/headers", "headers", (body) => {
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

  registerMutation("/set/credentials", "http credentials", (body) => {
    const clear = toBoolean(body.clear) ?? false;
    const username = toStringOrEmpty(body.username) || undefined;
    const password = readStringValue(body.password);
    return (pw, target) =>
      pw.setHttpCredentialsViaPlaywright({ ...target, username, password, clear });
  });

  registerMutation("/set/geolocation", "geolocation", (body) => {
    const geolocation = parseGeolocationOptions(body);
    return (pw, target) => pw.setGeolocationViaPlaywright({ ...target, ...geolocation });
  });

  registerMutation(
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

  registerMutation(
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

  registerMutation(
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

  registerMutation(
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
