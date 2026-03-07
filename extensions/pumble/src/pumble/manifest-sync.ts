import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { AddonManifest } from "pumble-sdk";
import { PUMBLE_API_BASE } from "./client.js";

// ~/.pumblerc contains admin credentials written by `pumble-cli login`.
// The path uses homedir() at import time — in containerized deployments where
// HOME changes at runtime, set PUMBLE_RC_PATH to override. The file should
// be mode 0600 (user-only read/write); pumble-cli manages permissions.
const RC_PATH = process.env.PUMBLE_RC_PATH?.trim() || join(homedir(), ".pumblerc");

type PumbleRc = {
  accessToken: string;
  refreshToken: string;
  workspaceId: string;
  userId: string;
};

async function loadPumbleRc(): Promise<PumbleRc | null> {
  try {
    const raw = await readFile(RC_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    const accessToken = parsed.accessToken || parsed.PUMBLE_ACCESS_TOKEN;
    const refreshToken = parsed.refreshToken || parsed.PUMBLE_REFRESH_TOKEN;
    const workspaceId = parsed.workspaceId || parsed.PUMBLE_WORKSPACE_ID;
    const userId = parsed.userId || parsed.PUMBLE_WORKSPACE_USER_ID;
    if (!accessToken || !workspaceId || !userId) return null;
    return { accessToken, refreshToken: refreshToken ?? "", workspaceId, userId };
  } catch {
    return null;
  }
}

async function savePumbleRcTokens(accessToken: string, refreshToken: string): Promise<void> {
  try {
    const raw = await readFile(RC_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed.PUMBLE_ACCESS_TOKEN !== undefined) {
      parsed.PUMBLE_ACCESS_TOKEN = accessToken;
      parsed.PUMBLE_REFRESH_TOKEN = refreshToken;
    } else {
      parsed.accessToken = accessToken;
      parsed.refreshToken = refreshToken;
    }
    await writeFile(RC_PATH, JSON.stringify(parsed, null, 4) + "\n", "utf-8");
  } catch {
    // Non-fatal
  }
}

function isTokenExpired(token: string): boolean {
  try {
    const payload = Buffer.from(token.split(".")[1], "base64").toString();
    const decoded = JSON.parse(payload) as { exp?: number };
    if (!decoded.exp) return false;
    return Date.now() > decoded.exp * 1000;
  } catch {
    return true;
  }
}

async function refreshAccessToken(
  rc: PumbleRc,
  log?: (msg: string) => void,
): Promise<string | null> {
  if (!rc.refreshToken) return null;
  try {
    const { response: res, release } = await fetchWithSsrFGuard({
      url: `${PUMBLE_API_BASE}/workspaces/${rc.workspaceId}/refresh`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rc.refreshToken }),
      },
    });
    if (!res.ok) {
      await release();
      log?.(`pumble: token refresh failed (${res.status})`);
      return null;
    }
    const data = (await res.json()) as { token?: string; refreshToken?: string };
    await release();
    if (!data.token) return null;
    await savePumbleRcTokens(data.token, data.refreshToken ?? rc.refreshToken);
    log?.("pumble: admin token refreshed");
    return data.token;
  } catch (err) {
    log?.(`pumble: token refresh error: ${String(err)}`);
    return null;
  }
}

async function resolveAdminToken(
  rc: PumbleRc,
  log?: (msg: string) => void,
): Promise<string | null> {
  if (!isTokenExpired(rc.accessToken)) return rc.accessToken;
  return refreshAccessToken(rc, log);
}

/**
 * Push the local manifest (webhook URLs, event subscriptions) to Pumble's
 * server so incoming events are routed to the correct endpoint.
 *
 * Fetches the current app config first and merges webhook-related fields,
 * since Pumble's PUT /apps/{id} requires the full app object.
 *
 * Requires admin credentials in `~/.pumblerc` (written by `pumble-cli login`).
 */
export async function syncManifestToServer(
  manifest: AddonManifest,
  log?: (msg: string) => void,
): Promise<boolean> {
  const rc = await loadPumbleRc();
  if (!rc) {
    log?.(
      `pumble: ~/.pumblerc not found or incomplete — skipping manifest sync. ` +
        `Set webhook URLs manually in the Pumble app dashboard, or run \`pumble-cli login\` first.`,
    );
    return false;
  }

  // Warn if .pumblerc has overly permissive file permissions
  try {
    const st = await stat(RC_PATH);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      log?.(
        `pumble: warning: ${RC_PATH} has insecure permissions (mode ${mode.toString(8)}); recommend chmod 600`,
      );
    }
  } catch {
    // Non-fatal — stat failure doesn't block manifest sync
  }

  const token = await resolveAdminToken(rc, log);
  if (!token) {
    log?.("pumble: admin token expired and refresh failed — run `pumble-cli login`");
    return false;
  }

  const appUrl =
    `${PUMBLE_API_BASE}/workspaces/${rc.workspaceId}` + `/workspaceUsers/${rc.userId}/apps`;

  try {
    // Fetch current app to get required fields (name, displayName, etc.)
    const { response: getRes, release: releaseGet } = await fetchWithSsrFGuard({
      url: `${appUrl}/mine/${manifest.id}`,
      init: { headers: { Authtoken: token } },
    });
    if (!getRes.ok) {
      const detail = await getRes.text().catch(() => getRes.statusText);
      await releaseGet();
      log?.(`pumble: failed to fetch app (${getRes.status}): ${detail}`);
      return false;
    }
    const currentApp = (await getRes.json()) as Record<string, unknown>;
    await releaseGet();

    // Strip fields that Pumble rejects on PUT (null sub-values, auto-generated URLs)
    const blockInteraction = currentApp.blockInteraction as Record<string, unknown> | undefined;
    if (blockInteraction?.url == null) delete currentApp.blockInteraction;
    const viewAction = currentApp.viewAction as Record<string, unknown> | undefined;
    if (viewAction?.url == null) delete currentApp.viewAction;
    delete currentApp.listingUrl; // auto-generated from redirectUrls
    delete currentApp.avatar; // read-only

    // Merge our webhook changes into the full app object
    const updatedApp = {
      ...currentApp,
      socketMode: manifest.socketMode,
      eventSubscriptions: manifest.eventSubscriptions,
      redirectUrls: manifest.redirectUrls,
    };

    const { response: putRes, release: releasePut } = await fetchWithSsrFGuard({
      url: `${appUrl}/${manifest.id}`,
      init: {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authtoken: token },
        body: JSON.stringify(updatedApp),
      },
    });

    if (!putRes.ok) {
      const detail = await putRes.text().catch(() => putRes.statusText);
      await releasePut();
      log?.(`pumble: manifest sync failed (${putRes.status}): ${detail}`);
      return false;
    }
    await releasePut();

    log?.(`pumble: manifest synced — webhook URL: ${manifest.eventSubscriptions.url}`);
    return true;
  } catch (err) {
    log?.(`pumble: manifest sync error: ${String(err)}`);
    return false;
  }
}
