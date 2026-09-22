/**
 * Browser storage and context mutation routes.
 *
 * Parses and applies cookies, local/session storage, geolocation, permissions,
 * and related browser-context mutations for the selected profile/tab.
 */
import {
  asNullableRecord,
  readNonBlankString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../../infra/errors.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { InteractionTargetOptions } from "../pw-tools-core.interactions.navigation.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveProfileContext,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readOptionalRouteFiniteNumber, readRouteFiniteNumber } from "./route-numeric.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError, readHttpOrigin, toBoolean, toStringOrEmpty } from "./utils.js";

type StorageKind = "local" | "session";

type GeolocationOptions = {
  clear: boolean;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
};

type CookieSetOptions = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
};

/** Parse the supported browser storage bucket names. */
function parseStorageKind(raw: string): StorageKind | null {
  if (raw === "local" || raw === "session") {
    return raw;
  }
  return null;
}

/** Parse storage mutations once at the request boundary. */
function parseStorageMutationFromRequest(req: BrowserRequest, res: BrowserResponse) {
  const body = readBody(req);
  const kind = parseStorageKind(toStringOrEmpty(req.params.kind));
  const targetId = resolveTargetIdFromBody(body);
  if (!kind) {
    jsonError(res, 400, "kind must be local|session");
    return null;
  }
  return { body, parsed: { kind, targetId } };
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
  const runMutation = async (
    req: BrowserRequest,
    res: BrowserResponse,
    targetId: string | undefined,
    feature: string,
    run: (
      pw: PwAiModule,
      target: InteractionTargetOptions,
      signal: AbortSignal,
    ) => Promise<void | Record<string, unknown>>,
    existingSessionUnsupported?: string,
  ) => {
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
  };

  app.get("/cookies", async (req, res) => {
    const targetId = resolveTargetIdFromQuery(req.query);
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

  app.post("/cookies/set", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const cookie = asNullableRecord(body.cookie);
    if (!cookie) {
      return jsonError(res, 400, "cookie is required");
    }
    let parsedCookie: CookieSetOptions;
    try {
      parsedCookie = parseCookieSetOptions(cookie);
    } catch (err) {
      return jsonError(res, 400, formatErrorMessage(err));
    }

    await runMutation(req, res, targetId, "cookies set", async (pw, target) => {
      await pw.cookiesSetViaPlaywright({
        ...target,
        cookie: parsedCookie,
      });
    });
  });

  app.post("/cookies/set-many", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const rawCookies = body.cookies;
    if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
      return jsonError(res, 400, "cookies must be a non-empty array");
    }
    const cookieRecords: Record<string, unknown>[] = [];
    for (const cookie of rawCookies) {
      if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
        return jsonError(res, 400, "cookies must contain only cookie objects");
      }
      cookieRecords.push(cookie as Record<string, unknown>);
    }
    let cookies: CookieSetOptions[];
    try {
      cookies = cookieRecords.map((cookie) => parseCookieSetOptions(cookie));
    } catch (err) {
      return jsonError(res, 400, formatErrorMessage(err));
    }

    await runMutation(req, res, targetId, "cookies set-many", async (pw, target, signal) => {
      const { added } = await pw.cookiesSetManyViaPlaywright({
        ...target,
        cookies,
        signal,
      });
      return { added };
    });
  });

  app.post("/cookies/clear", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);

    await runMutation(req, res, targetId, "cookies clear", async (pw, target) => {
      await pw.cookiesClearViaPlaywright(target);
    });
  });

  app.get("/storage/:kind", async (req, res) => {
    const kind = parseStorageKind(toStringOrEmpty(req.params.kind));
    if (!kind) {
      return jsonError(res, 400, "kind must be local|session");
    }
    const targetId = resolveTargetIdFromQuery(req.query);
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

  app.post("/storage/:kind/set", async (req, res) => {
    const mutation = parseStorageMutationFromRequest(req, res);
    if (!mutation) {
      return;
    }
    const key = readNonBlankString(
      readStringValue(mutation.body.key) ?? toStringOrEmpty(mutation.body.key),
    );
    if (!key) {
      return jsonError(res, 400, "key is required");
    }
    const value = typeof mutation.body.value === "string" ? mutation.body.value : "";

    await runMutation(req, res, mutation.parsed.targetId, "storage set", async (pw, target) => {
      await pw.storageSetViaPlaywright({
        ...target,
        kind: mutation.parsed.kind,
        key,
        value,
      });
    });
  });

  app.post("/storage/:kind/clear", async (req, res) => {
    const mutation = parseStorageMutationFromRequest(req, res);
    if (!mutation) {
      return;
    }

    await runMutation(req, res, mutation.parsed.targetId, "storage clear", async (pw, target) => {
      await pw.storageClearViaPlaywright({
        ...target,
        kind: mutation.parsed.kind,
      });
    });
  });

  app.post("/set/offline", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const offline = toBoolean(body.offline);
    if (offline === undefined) {
      return jsonError(res, 400, "offline is required");
    }

    await runMutation(req, res, targetId, "offline", async (pw, target) => {
      await pw.setOfflineViaPlaywright({
        ...target,
        offline,
      });
    });
  });

  app.post("/set/headers", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const headers =
      body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
        ? (body.headers as Record<string, unknown>)
        : null;
    if (!headers) {
      return jsonError(res, 400, "headers is required");
    }

    const parsed: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") {
        parsed[k] = v;
      }
    }

    await runMutation(req, res, targetId, "headers", async (pw, target) => {
      await pw.setExtraHTTPHeadersViaPlaywright({
        ...target,
        headers: parsed,
      });
    });
  });

  app.post("/set/credentials", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const clear = toBoolean(body.clear) ?? false;
    const username = toStringOrEmpty(body.username) || undefined;
    const password = readStringValue(body.password);

    await runMutation(req, res, targetId, "http credentials", async (pw, target) => {
      await pw.setHttpCredentialsViaPlaywright({
        ...target,
        username,
        password,
        clear,
      });
    });
  });

  app.post("/set/geolocation", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    let geolocation: GeolocationOptions;
    try {
      geolocation = parseGeolocationOptions(body);
    } catch (err) {
      return jsonError(res, 400, formatErrorMessage(err));
    }

    await runMutation(req, res, targetId, "geolocation", async (pw, target) => {
      await pw.setGeolocationViaPlaywright({
        ...target,
        ...geolocation,
      });
    });
  });

  app.post("/set/media", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const schemeRaw = toStringOrEmpty(body.colorScheme);
    const colorScheme =
      schemeRaw === "dark" || schemeRaw === "light" || schemeRaw === "no-preference"
        ? schemeRaw
        : schemeRaw === "none"
          ? null
          : undefined;
    if (colorScheme === undefined) {
      return jsonError(res, 400, "colorScheme must be dark|light|no-preference|none");
    }

    await runMutation(
      req,
      res,
      targetId,
      "media emulation",
      async (pw, target) => {
        await pw.emulateMediaViaPlaywright({
          ...target,
          colorScheme,
        });
      },
      EXISTING_SESSION_LIMITS.emulation,
    );
  });

  app.post("/set/timezone", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const timezoneId = toStringOrEmpty(body.timezoneId);
    if (!timezoneId) {
      return jsonError(res, 400, "timezoneId is required");
    }

    await runMutation(
      req,
      res,
      targetId,
      "timezone",
      async (pw, target) => {
        await pw.setTimezoneViaPlaywright({
          ...target,
          timezoneId,
        });
      },
      EXISTING_SESSION_LIMITS.emulation,
    );
  });

  app.post("/set/locale", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const locale = toStringOrEmpty(body.locale);
    if (!locale) {
      return jsonError(res, 400, "locale is required");
    }

    await runMutation(
      req,
      res,
      targetId,
      "locale",
      async (pw, target) => {
        await pw.setLocaleViaPlaywright({
          ...target,
          locale,
        });
      },
      EXISTING_SESSION_LIMITS.emulation,
    );
  });

  app.post("/set/device", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const name = toStringOrEmpty(body.name);
    if (!name) {
      return jsonError(res, 400, "name is required");
    }

    await runMutation(
      req,
      res,
      targetId,
      "device emulation",
      async (pw, target, signal) => {
        await pw.setDeviceViaPlaywright({
          ...target,
          name,
          signal,
        });
      },
      EXISTING_SESSION_LIMITS.emulation,
    );
  });
}
