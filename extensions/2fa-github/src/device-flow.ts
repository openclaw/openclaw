/**
 * GitHub Device Authorization Flow
 *
 * Implements the OAuth 2.0 Device Authorization Grant for GitHub.
 * This allows authentication without a browser redirect, using GitHub Mobile
 * push notifications or manual code entry at github.com/login/device.
 *
 * Reference: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

import type { DeviceCodeResponse, DeviceTokenResponse } from "./types.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_API_URL = "https://api.github.com/user";

function parseJsonResponse<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub");
  }
  return value as T;
}

/**
 * Request a device code from GitHub.
 * The user will use this code to authorize at github.com/login/device.
 */
export async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: "read:user",
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceCodeResponse>(await res.json());
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing required fields");
  }

  return json;
}

/**
 * Poll for access token after user has authorized the device.
 *
 * @param params.clientId - GitHub OAuth App client ID
 * @param params.deviceCode - Device code from requestDeviceCode()
 * @param params.intervalMs - Minimum polling interval in milliseconds
 * @param params.expiresAt - Timestamp when device code expires
 * @returns Access token and GitHub username
 */
export async function pollForAccessToken(params: {
  clientId: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<{ accessToken: string; login: string }> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`GitHub device token request failed: HTTP ${res.status}`);
    }

    const json = parseJsonResponse<DeviceTokenResponse>(await res.json());

    // Check for successful token response
    if ("access_token" in json && typeof json.access_token === "string") {
      // Fetch user info to get the GitHub login
      const userRes = await fetch(USER_API_URL, {
        headers: {
          Authorization: `Bearer ${json.access_token}`,
          Accept: "application/json",
        },
      });

      if (!userRes.ok) {
        throw new Error(`Failed to fetch GitHub user info: HTTP ${userRes.status}`);
      }

      const userJson = (await userRes.json()) as { login?: string };
      const login = userJson.login;
      if (!login || typeof login !== "string") {
        throw new Error("GitHub user response missing login field");
      }

      return { accessToken: json.access_token, login };
    }

    // Handle error responses
    const err = "error" in json ? json.error : "unknown";

    if (err === "authorization_pending") {
      // User hasn't authorized yet, wait and try again
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }

    if (err === "slow_down") {
      // Rate limited, wait longer
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
      continue;
    }

    if (err === "expired_token") {
      throw new Error("Device code expired");
    }

    if (err === "access_denied") {
      throw new Error("Authorization denied by user");
    }

    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new Error("Device code expired");
}

/**
 * Quick poll - tries once and returns immediately.
 * Used when checking if user has already approved on retry.
 */
export async function quickPollForAccessToken(params: {
  clientId: string;
  deviceCode: string;
}): Promise<{ accessToken: string; login: string } | "pending" | "expired" | "denied"> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device token request failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceTokenResponse>(await res.json());

  if ("access_token" in json && typeof json.access_token === "string") {
    // Fetch user info
    const userRes = await fetch(USER_API_URL, {
      headers: {
        Authorization: `Bearer ${json.access_token}`,
        Accept: "application/json",
      },
    });

    if (!userRes.ok) {
      throw new Error(`Failed to fetch GitHub user info: HTTP ${userRes.status}`);
    }

    const userJson = (await userRes.json()) as { login?: string };
    const login = userJson.login;
    if (!login || typeof login !== "string") {
      throw new Error("GitHub user response missing login field");
    }

    return { accessToken: json.access_token, login };
  }

  const err = "error" in json ? json.error : "unknown";

  if (err === "authorization_pending" || err === "slow_down") {
    return "pending";
  }

  if (err === "expired_token") {
    return "expired";
  }

  if (err === "access_denied") {
    return "denied";
  }

  throw new Error(`GitHub device flow error: ${err}`);
}
