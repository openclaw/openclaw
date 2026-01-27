/**
 * Anchorbrowser API client for creating and managing remote browser sessions.
 *
 * @see https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session
 */

import type { AnchorBrowserSettings } from "./types.js";

const DEFAULT_API_URL = "https://api.anchorbrowser.io/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnchorBrowserSession = {
  id: string;
  cdpUrl: string;
  liveViewUrl?: string;
};

export type AnchorBrowserCreateParams = AnchorBrowserSettings & {
  /** API key (required). */
  apiKey: string;
};

type AnchorApiSessionResponse = {
  data: {
    id: string;
    cdp_url: string;
    live_view_url?: string;
  };
};

type AnchorApiErrorResponse = {
  error?: string;
  message?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApiUrl(settings?: AnchorBrowserSettings): string {
  return settings?.apiUrl?.trim() || DEFAULT_API_URL;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "anchor-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

/**
 * Build the request body for creating an Anchorbrowser session.
 */
function buildCreateSessionBody(params: AnchorBrowserCreateParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // Session config
  const session: Record<string, unknown> = {};
  if (params.recording !== undefined) {
    session.recording = { active: params.recording };
  }
  if (params.proxy) {
    session.proxy = {
      active: params.proxy.active ?? false,
      ...(params.proxy.type && { type: params.proxy.type }),
      ...(params.proxy.countryCode && { country_code: params.proxy.countryCode }),
      ...(params.proxy.region && { region: params.proxy.region }),
      ...(params.proxy.city && { city: params.proxy.city }),
    };
  }
  if (params.timeout) {
    session.timeout = {
      ...(params.timeout.maxDuration !== undefined && { max_duration: params.timeout.maxDuration }),
      ...(params.timeout.idleTimeout !== undefined && { idle_timeout: params.timeout.idleTimeout }),
    };
  }
  if (Object.keys(session).length > 0) {
    body.session = session;
  }

  // Browser config
  const browser: Record<string, unknown> = {};
  if (params.adblock !== undefined) {
    browser.adblock = { active: params.adblock };
  }
  if (params.popupBlocker !== undefined) {
    browser.popup_blocker = { active: params.popupBlocker };
  }
  if (params.captchaSolver !== undefined) {
    browser.captcha_solver = { active: params.captchaSolver };
  }
  if (params.headless !== undefined) {
    browser.headless = { active: params.headless };
  }
  if (params.viewport) {
    browser.viewport = {
      width: params.viewport.width,
      height: params.viewport.height,
    };
  }
  if (params.extraStealth !== undefined) {
    browser.extra_stealth = { active: params.extraStealth };
  }
  if (Object.keys(browser).length > 0) {
    body.browser = browser;
  }

  return body;
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Create a new Anchorbrowser session.
 *
 * @throws Error if the API call fails or returns an error.
 */
export async function createAnchorBrowserSession(
  params: AnchorBrowserCreateParams,
): Promise<AnchorBrowserSession> {
  const apiUrl = resolveApiUrl(params);
  const url = `${apiUrl}/sessions`;

  const body = buildCreateSessionBody(params);

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(params.apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorMessage = `Anchorbrowser API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = (await response.json()) as AnchorApiErrorResponse;
      if (errorData.error || errorData.message) {
        errorMessage = `Anchorbrowser API error: ${errorData.error || errorData.message}`;
      }
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(errorMessage);
  }

  const data = (await response.json()) as AnchorApiSessionResponse;

  return {
    id: data.data.id,
    cdpUrl: data.data.cdp_url,
    liveViewUrl: data.data.live_view_url,
  };
}

/**
 * End an Anchorbrowser session.
 *
 * @throws Error if the API call fails.
 */
export async function endAnchorBrowserSession(params: {
  apiKey: string;
  apiUrl?: string;
  sessionId: string;
}): Promise<void> {
  const apiUrl = params.apiUrl?.trim() || DEFAULT_API_URL;
  const url = `${apiUrl}/sessions/${encodeURIComponent(params.sessionId)}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: buildHeaders(params.apiKey),
  });

  // 404 is acceptable - session may have already ended
  if (!response.ok && response.status !== 404) {
    let errorMessage = `Anchorbrowser API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = (await response.json()) as AnchorApiErrorResponse;
      if (errorData.error || errorData.message) {
        errorMessage = `Anchorbrowser API error: ${errorData.error || errorData.message}`;
      }
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(errorMessage);
  }
}

/**
 * Get the status of an Anchorbrowser session.
 *
 * @returns The session info, or null if the session doesn't exist.
 */
export async function getAnchorBrowserSession(params: {
  apiKey: string;
  apiUrl?: string;
  sessionId: string;
}): Promise<AnchorBrowserSession | null> {
  const apiUrl = params.apiUrl?.trim() || DEFAULT_API_URL;
  const url = `${apiUrl}/sessions/${encodeURIComponent(params.sessionId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params.apiKey),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    let errorMessage = `Anchorbrowser API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = (await response.json()) as AnchorApiErrorResponse;
      if (errorData.error || errorData.message) {
        errorMessage = `Anchorbrowser API error: ${errorData.error || errorData.message}`;
      }
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(errorMessage);
  }

  const data = (await response.json()) as AnchorApiSessionResponse;

  return {
    id: data.data.id,
    cdpUrl: data.data.cdp_url,
    liveViewUrl: data.data.live_view_url,
  };
}
