import { getStoredSession } from "../auth/index.js";
import { type VRChatSession } from "../auth/types.js";

const VRCHAT_API_BASE = "https://api.vrchat.cloud/api/1";

async function fetchWithAuth(url: string, session: VRChatSession) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: `auth=${session.authToken}`,
      "User-Agent": "OpenClaw/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`VRChat API Error: ${res.statusText} (${res.status})`);
  }

  return res.json();
}

/**
 * Fetch the current user's location (World ID and Instance)
 */
export async function fetchCurrentUserLocation(): Promise<{
  worldId: string;
  instanceId: string;
  location: string;
}> {
  const session = getStoredSession();
  if (!session) {
    throw new Error("Not authenticated with VRChat");
  }

  const user = (await fetchWithAuth(`${VRCHAT_API_BASE}/auth/user`, session)) as any;
  const location = user.location || "offline";

  let worldId = "";
  let instanceId = "";

  if (location !== "offline" && location !== "private") {
    const parts = location.split(":");
    worldId = parts[0];
    instanceId = parts[1] || "";
  }

  return { worldId, instanceId, location };
}

/**
 * Fetch details about a specific World ID
 */
export async function fetchWorldInfo(worldId: string): Promise<any> {
  const session = getStoredSession();
  if (!session) {
    throw new Error("Not authenticated with VRChat");
  }

  if (!worldId || !worldId.startsWith("wrld_")) {
    throw new Error("Invalid World ID format");
  }

  return fetchWithAuth(`${VRCHAT_API_BASE}/worlds/${worldId}`, session);
}

/**
 * Fetch a list of currently online friends
 */
export async function fetchOnlineFriends(): Promise<any[]> {
  const session = getStoredSession();
  if (!session) {
    throw new Error("Not authenticated with VRChat");
  }

  // Fetches top 100 online friends
  const friends = (await fetchWithAuth(
    `${VRCHAT_API_BASE}/auth/user/friends?offline=false&n=100`,
    session,
  )) as any[];
  return friends.map((f) => ({
    id: f.id,
    displayName: f.displayName,
    location: f.location,
    status: f.status,
    statusDescription: f.statusDescription,
  }));
}
