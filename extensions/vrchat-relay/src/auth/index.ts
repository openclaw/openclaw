import type { VRChatCredentials, VRChatSession, VRChatUser, Result } from "./types.js";
import { ok, err } from "./types.js";

const VRCHAT_API_BASE = "https://api.vrchat.cloud/api/1";

/**
 * Authenticate with VRChat API
 */
export async function authenticate(credentials: VRChatCredentials): Promise<Result<VRChatSession>> {
  try {
    const { username, password, otpCode } = credentials;

    // Step 1: Get API key
    const apiKeyRes = await fetch(`${VRCHAT_API_BASE}/config`);
    if (!apiKeyRes.ok) {
      return err({ message: "Failed to fetch API config", statusCode: apiKeyRes.status });
    }

    const config = (await apiKeyRes.json()) as { clientApiKey?: string };
    const apiKey = config.clientApiKey;

    if (!apiKey) {
      return err({ message: "API key not found in config", statusCode: 500 });
    }

    // Step 2: Attempt login
    const authString = Buffer.from(`${username}:${password}`).toString("base64");
    const loginUrl = `${VRCHAT_API_BASE}/auth/user?apiKey=${apiKey}`;

    const loginRes = await fetch(loginUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${authString}`,
        "User-Agent": "OpenClaw/1.0",
      },
    });

    // Handle 2FA requirement
    if (loginRes.status === 401) {
      const loginData = (await loginRes.json()) as { requiresTwoFactorAuth?: string[] };

      if (loginData.requiresTwoFactorAuth && !otpCode) {
        return err({
          message: `Two-factor authentication required. Provide OTP code.`,
          statusCode: 401,
        });
      }

      if (otpCode && loginData.requiresTwoFactorAuth) {
        // Determine which 2FA method
        const method = loginData.requiresTwoFactorAuth[0] || "totp";

        // Verify 2FA
        const verifyUrl = `${VRCHAT_API_BASE}/auth/twofactorauth/${method}/verify?apiKey=${apiKey}`;
        const verifyRes = await fetch(verifyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${authString}`,
            "User-Agent": "OpenClaw/1.0",
          },
          body: JSON.stringify({ code: otpCode }),
        });

        if (!verifyRes.ok) {
          return err({ message: "Invalid 2FA code", statusCode: verifyRes.status });
        }

        // Retry login after 2FA
        const retryRes = await fetch(loginUrl, {
          method: "GET",
          headers: {
            Authorization: `Basic ${authString}`,
            "User-Agent": "OpenClaw/1.0",
          },
        });

        if (!retryRes.ok) {
          return err({ message: "Login failed after 2FA", statusCode: retryRes.status });
        }

        const userData = (await retryRes.json()) as VRChatUser;
        const cookies = retryRes.headers.get("set-cookie") || "";
        const authToken = extractCookie(cookies, "auth");
        const twoFactorAuth = extractCookie(cookies, "twoFactorAuth");

        if (!authToken) {
          return err({ message: "No auth token received", statusCode: 500 });
        }

        return ok({
          authToken,
          twoFactorAuth,
          userId: userData.id,
          displayName: userData.displayName,
        });
      }

      return err({ message: "Authentication failed", statusCode: 401 });
    }

    if (!loginRes.ok) {
      return err({ message: "Login failed", statusCode: loginRes.status });
    }

    const userData = (await loginRes.json()) as VRChatUser;
    const cookies = loginRes.headers.get("set-cookie") || "";
    const authToken = extractCookie(cookies, "auth");

    if (!authToken) {
      return err({ message: "No auth token received", statusCode: 500 });
    }

    return ok({
      authToken,
      userId: userData.id,
      displayName: userData.displayName,
    });
  } catch (error) {
    return err({
      message: error instanceof Error ? error.message : "Unknown error",
      statusCode: 500,
    });
  }
}

/**
 * Logout from VRChat
 */
export async function logout(authToken: string): Promise<Result<void>> {
  try {
    const res = await fetch(`${VRCHAT_API_BASE}/logout`, {
      method: "PUT",
      headers: {
        Cookie: `auth=${authToken}`,
        "User-Agent": "OpenClaw/1.0",
      },
    });

    if (!res.ok && res.status !== 200) {
      return err({ message: "Logout failed", statusCode: res.status });
    }

    return ok(undefined);
  } catch (error) {
    return err({
      message: error instanceof Error ? error.message : "Unknown error",
      statusCode: 500,
    });
  }
}

/**
 * Get current user info
 */
export async function getCurrentUser(authToken: string): Promise<Result<VRChatUser>> {
  try {
    const res = await fetch(`${VRCHAT_API_BASE}/auth/user`, {
      headers: {
        Cookie: `auth=${authToken}`,
        "User-Agent": "OpenClaw/1.0",
      },
    });

    if (!res.ok) {
      return err({ message: "Failed to get user info", statusCode: res.status });
    }

    const user = (await res.json()) as VRChatUser;
    return ok(user);
  } catch (error) {
    return err({
      message: error instanceof Error ? error.message : "Unknown error",
      statusCode: 500,
    });
  }
}

function extractCookie(cookieString: string, name: string): string | undefined {
  const match = cookieString.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}

// Token storage helpers (in-memory for now, can be extended to use keytar)
let storedSession: VRChatSession | null = null;

export function storeSession(session: VRChatSession): void {
  storedSession = session;
}

export function getStoredSession(): VRChatSession | null {
  return storedSession;
}

export function clearSession(): void {
  storedSession = null;
}

export function isAuthenticated(): boolean {
  return storedSession !== null;
}
