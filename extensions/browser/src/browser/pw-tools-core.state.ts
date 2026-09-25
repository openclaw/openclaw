/**
 * Browser context and emulation state helpers for Playwright-backed tools.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession, Page } from "playwright-core";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import type { PageState } from "./pw-session-contracts.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import {
  assertInteractionCurrent,
  awaitActionWithAbort,
  type InteractionTargetOptions,
  createAbortPromiseWithListener,
} from "./pw-tools-core.interactions.navigation.js";

type DeviceSize = { width: number; height: number };
type PlaywrightDeviceDescriptor = {
  userAgent: string;
  viewport: DeviceSize;
  screen?: DeviceSize;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
};

function resolvePageEmulationState(state: PageState): NonNullable<PageState["emulation"]> {
  return (state.emulation ??= {});
}

function resolvePageEmulationSession(page: Page, state: PageState): Promise<CDPSession> {
  const emulation = resolvePageEmulationState(state);
  if (emulation.session) {
    return emulation.session;
  }
  const pending = page.context().newCDPSession(page);
  emulation.session = pending;
  void pending.catch(() => {
    if (emulation.session === pending) {
      delete emulation.session;
    }
  });
  return pending;
}

async function withPageEmulationCdpClient<T>(params: {
  page: Page;
  state: PageState;
  run: (send: CDPSession["send"], session: CDPSession) => Promise<T>;
}): Promise<T> {
  const session = await resolvePageEmulationSession(params.page, params.state);
  return await params.run(session.send.bind(session), session);
}

export async function setViewportSizeOnPage(
  page: Page,
  state: PageState,
  viewport: DeviceSize,
  assertCurrent?: InteractionTargetOptions["assertCurrent"],
) {
  const emulation = state.emulation;
  if (
    emulation?.metricsOwner &&
    (emulation.metricsOwner.viewport.width !== viewport.width ||
      emulation.metricsOwner.viewport.height !== viewport.height)
  ) {
    // Chromium caches metrics per session. Release the device owner before
    // Playwright writes, or reapplying the same device silently skips its DPR/screen.
    await emulation.metricsOwner.session.send("Emulation.clearDeviceMetricsOverride");
    delete emulation.metricsOwner;
  }
  // Clearing an earlier metrics owner can yield; recheck before the next native effect.
  const assertion = assertInteractionCurrent({ assertCurrent });
  if (assertion) {
    await assertion;
  }
  await page.setViewportSize(viewport);
}

export async function runPageEmulationTransition<T>(params: {
  state: PageState;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  params.signal?.throwIfAborted();
  const emulation = resolvePageEmulationState(params.state);
  const interrupted = (emulation.transitionAbort ??= new AbortController());
  interrupted.signal.throwIfAborted();
  const signal = params.signal
    ? AbortSignal.any([params.signal, interrupted.signal])
    : interrupted.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal);
  const previous = emulation.transitionTail ?? Promise.resolve();
  const transition = previous
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      // Device changes and captures share one queue: neither may observe or
      // restore only part of another operation's viewport, metrics, or touch state.
      const interrupt = () =>
        interrupted.abort(
          new Error(
            "A previous screenshot or emulation action was cancelled but is still running. Retry when it finishes; if it remains stuck, close and reopen this tab.",
          ),
        );
      params.signal?.addEventListener("abort", interrupt, { once: true });
      try {
        return await params.run();
      } finally {
        params.signal?.removeEventListener("abort", interrupt);
      }
    });
  // Cancellation cannot stop Chromium's pending capture/restoration. Reject
  // waiting callers, but retain the mutation owner until its cleanup settles.
  const tail = transition
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      if (emulation.transitionTail === tail) {
        delete emulation.transitionTail;
        delete emulation.transitionAbort;
      }
    });
  emulation.transitionTail = tail;
  try {
    return await awaitActionWithAbort(transition, abortPromise);
  } finally {
    cleanup();
  }
}

/** Toggles offline mode for the target page context. */
export async function setOfflineViaPlaywright(
  opts: InteractionTargetOptions & {
    offline: boolean;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.context().setOffline(opts.offline);
}

/** Replaces extra HTTP headers for the target page context. */
export async function setExtraHTTPHeadersViaPlaywright(
  opts: InteractionTargetOptions & {
    headers: Record<string, string>;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.context().setExtraHTTPHeaders(opts.headers);
}

/** Sets or clears HTTP basic-auth credentials for the target page context. */
export async function setHttpCredentialsViaPlaywright(
  opts: InteractionTargetOptions & {
    username?: string;
    password?: string;
    clear?: boolean;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  if (opts.clear) {
    await page.context().setHTTPCredentials(null);
    return;
  }
  const username = opts.username ?? "";
  const password = opts.password ?? "";
  if (!username) {
    throw new Error("username is required (or set clear=true)");
  }
  await page.context().setHTTPCredentials({ username, password });
}

/** Sets or clears geolocation and grants page-origin geolocation permission. */
export async function setGeolocationViaPlaywright(
  opts: InteractionTargetOptions & {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    origin?: string;
    clear?: boolean;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const context = page.context();
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  if (opts.clear) {
    await context.setGeolocation(null);
    // Finish clearing prior permissions even if the admitted reset's caller retires.
    await context.clearPermissions().catch(() => {});
    return;
  }
  if (typeof opts.latitude !== "number" || typeof opts.longitude !== "number") {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  await context.setGeolocation({
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: typeof opts.accuracy === "number" ? opts.accuracy : undefined,
  });
  const origin =
    normalizeOptionalString(opts.origin) ||
    (() => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return "";
      }
    })();
  if (origin) {
    if (opts.assertCurrent) {
      await assertInteractionCurrent(opts);
    }
    await context.grantPermissions(["geolocation"], { origin }).catch(() => {});
  }
}

/** Emulates the requested media color scheme on the target page. */
export async function emulateMediaViaPlaywright(
  opts: InteractionTargetOptions & {
    colorScheme: "dark" | "light" | "no-preference" | null;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.emulateMedia({ colorScheme: opts.colorScheme });
}

/** Applies a locale override through page-scoped CDP. */
export async function setLocaleViaPlaywright(
  opts: InteractionTargetOptions & {
    locale: string;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const pageState = ensurePageState(page);
  const locale = normalizeOptionalString(opts.locale) ?? "";
  if (!locale) {
    throw new Error("locale is required");
  }
  await withPageEmulationCdpClient({
    page,
    state: pageState,
    run: async (send) => {
      if (opts.assertCurrent) {
        await assertInteractionCurrent(opts);
      }
      try {
        await send("Emulation.setLocaleOverride", { locale });
      } catch (err) {
        if (String(err).includes("Another locale override is already in effect")) {
          return;
        }
        throw err;
      }
    },
  });
}

/** Applies a timezone override through page-scoped CDP. */
export async function setTimezoneViaPlaywright(
  opts: InteractionTargetOptions & {
    timezoneId: string;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const pageState = ensurePageState(page);
  const timezoneId = normalizeOptionalString(opts.timezoneId) ?? "";
  if (!timezoneId) {
    throw new Error("timezoneId is required");
  }
  await withPageEmulationCdpClient({
    page,
    state: pageState,
    run: async (send) => {
      if (opts.assertCurrent) {
        await assertInteractionCurrent(opts);
      }
      try {
        await send("Emulation.setTimezoneOverride", { timezoneId });
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Timezone override is already in effect")) {
          return;
        }
        if (msg.includes("Invalid timezone")) {
          throw new Error(`Invalid timezone ID: ${timezoneId}`, { cause: err });
        }
        throw err;
      }
    },
  });
}

/** Applies a Playwright device descriptor to viewport, user agent, and touch state. */
export async function setDeviceViaPlaywright(
  opts: InteractionTargetOptions & {
    name: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const pageState = ensurePageState(page);
  const name = normalizeOptionalString(opts.name) ?? "";
  if (!name) {
    throw new Error("device name is required");
  }
  const descriptor = (getPlaywrightCore().devices as Record<string, unknown>)[name] as
    | PlaywrightDeviceDescriptor
    | undefined;
  if (!descriptor) {
    throw new Error(`Unknown device "${name}".`);
  }

  await runPageEmulationTransition({
    state: pageState,
    signal: opts.signal,
    run: async () => {
      if (opts.assertCurrent) {
        await assertInteractionCurrent(opts);
        opts.signal?.throwIfAborted();
      }
      const screen = descriptor.screen ?? descriptor.viewport;
      const isLandscape = screen.width > screen.height;

      // Keep Playwright's page model aligned before applying the descriptor fields
      // that its public setViewportSize API cannot express on an attached context.
      await setViewportSizeOnPage(page, pageState, { ...descriptor.viewport });

      await withPageEmulationCdpClient({
        page,
        state: pageState,
        run: async (send, session) => {
          await send("Emulation.setUserAgentOverride", {
            userAgent: descriptor.userAgent,
          });
          await send("Emulation.setDeviceMetricsOverride", {
            mobile: descriptor.isMobile,
            width: descriptor.viewport.width,
            height: descriptor.viewport.height,
            deviceScaleFactor: descriptor.deviceScaleFactor,
            screenWidth: screen.width,
            screenHeight: screen.height,
            screenOrientation:
              descriptor.isMobile && !isLandscape
                ? { angle: 0, type: "portraitPrimary" }
                : { angle: descriptor.isMobile ? 90 : 0, type: "landscapePrimary" },
          });
          const emulation = resolvePageEmulationState(pageState);
          emulation.metricsOwner = { session, viewport: { ...descriptor.viewport } };
          await send("Emulation.setTouchEmulationEnabled", {
            enabled: descriptor.hasTouch,
          });
          emulation.touch = { session, enabled: descriptor.hasTouch };
        },
      });
    },
  });
}
