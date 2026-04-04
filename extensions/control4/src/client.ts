import https from "node:https";
import { getDirectorToken, invalidateDirectorToken } from "./auth.js";

export type C4Item = {
  id: number;
  name: string;
  typeName: string;
  roomId?: number;
  roomName?: string;
  parentId?: number;
  categories?: string[];
  proxy?: string;
  floorName?: string;
  buildingName?: string;
  isOnline?: boolean;
};

export type C4Variable = {
  id: number;
  name: string;
  value: string | number | boolean;
  type?: string;
};

const ITEMS_CACHE_TTL_MS = 5 * 60 * 1000;
let itemsCache: C4Item[] | null = null;
let itemsCacheAt = 0;

function getControllerIp(): string {
  const ip = process.env["CONTROL4_CONTROLLER_IP"];
  if (!ip) {
    throw new Error("CONTROL4_CONTROLLER_IP environment variable is required");
  }
  return ip;
}

function directorRequest(
  method: string,
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const host = getControllerIp();
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const options = {
      host,
      path,
      method,
      port: 443,
      rejectUnauthorized: false,
      headers,
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk: Buffer) => (responseData += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseData }));
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Director request timed out"));
    });

    if (data) req.write(data);
    req.end();
  });
}

async function directorGet(path: string): Promise<unknown> {
  const token = await getDirectorToken();
  const response = await directorRequest("GET", path, null, token);
  if (response.status === 401) {
    invalidateDirectorToken();
    const freshToken = await getDirectorToken();
    const retry = await directorRequest("GET", path, null, freshToken);
    if (retry.status !== 200) {
      throw new Error(`Director GET ${path} failed: HTTP ${retry.status}`);
    }
    return JSON.parse(retry.body);
  }
  if (response.status !== 200) {
    throw new Error(`Director GET ${path} failed: HTTP ${response.status}`);
  }
  return JSON.parse(response.body);
}

async function directorPost(path: string, body: unknown): Promise<unknown> {
  const token = await getDirectorToken();
  const response = await directorRequest("POST", path, body, token);
  if (response.status === 401) {
    invalidateDirectorToken();
    const freshToken = await getDirectorToken();
    const retry = await directorRequest("POST", path, body, freshToken);
    if (retry.status < 200 || retry.status >= 300) {
      throw new Error(`Director POST ${path} failed: HTTP ${retry.status}`);
    }
    return retry.body ? JSON.parse(retry.body) : {};
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Director POST ${path} failed: HTTP ${response.status} — ${response.body}`);
  }
  return response.body ? JSON.parse(response.body) : {};
}

function buildRoomMap(items: C4Item[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const item of items) {
    if (item.typeName === "room") {
      map.set(item.id, item.name);
    }
  }
  return map;
}

/** Return all items with room names resolved. Cached for 5 minutes. */
export async function getItems(): Promise<C4Item[]> {
  const now = Date.now();
  if (itemsCache && now - itemsCacheAt < ITEMS_CACHE_TTL_MS) {
    return itemsCache;
  }

  const raw = (await directorGet("/api/v1/items")) as C4Item[];
  const roomMap = buildRoomMap(raw);

  const enriched = raw.map((item) => ({
    ...item,
    roomName: item.roomId != null ? roomMap.get(item.roomId) : undefined,
  }));

  itemsCache = enriched;
  itemsCacheAt = now;
  return enriched;
}

/** Invalidate the items cache (e.g. after commands that change device list). */
export function invalidateItemsCache(): void {
  itemsCache = null;
  itemsCacheAt = 0;
}

/** Send a command to a device. */
export async function sendCommand(
  deviceId: number,
  command: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const body: { command: string; params?: Record<string, string> } = { command };
  if (params && Object.keys(params).length > 0) {
    body.params = params;
  }
  return directorPost(`/api/v1/items/${deviceId}/commands`, body);
}

/** Get all variable values for a device. */
export async function getVariables(deviceId: number): Promise<C4Variable[]> {
  const result = await directorGet(`/api/v1/items/${deviceId}/variables`);
  if (Array.isArray(result)) {
    return result as C4Variable[];
  }
  return [];
}
