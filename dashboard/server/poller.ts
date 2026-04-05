/**
 * State poller: fetches Control4 device state every 5s, diffs against previous,
 * and broadcasts SSE events to connected clients.
 */
import { getItems, getVariables, getUiConfiguration } from "./c4.js";
import type { C4Item, C4Variable } from "./c4.js";
import type {
  HomeState,
  RoomState,
  LightState,
  ThermostatState,
  AudioZoneState,
  LockState,
  AudioSource,
} from "./types.js";
import type { Response } from "express";

// ---------------------------------------------------------------------------
// SSE client registry
// ---------------------------------------------------------------------------

type SSEClient = { res: Response; id: number };
let clientSeq = 0;
const sseClients = new Map<number, SSEClient>();

export function addSSEClient(res: Response): number {
  const id = ++clientSeq;
  sseClients.set(id, { res, id });
  return id;
}

export function removeSSEClient(id: number): void {
  sseClients.delete(id);
}

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients.values()) {
    try {
      client.res.write(payload);
    } catch {
      // Client disconnected mid-write — will be cleaned up via close event
    }
  }
}

// ---------------------------------------------------------------------------
// State snapshot
// ---------------------------------------------------------------------------

let currentState: HomeState | null = null;

export function getCurrentState(): HomeState | null {
  return currentState;
}

// ---------------------------------------------------------------------------
// Device classification helpers
// ---------------------------------------------------------------------------

const STRUCTURAL_TYPES = new Set(["root", "site", "building", "floor", "room"]);
const SKIP_ROOM_NAMES = new Set([
  "c4 drivers",
  "shairbridge",
  "media support",
  "routines",
  "deck",
  "bbq",
  "hot tub",
]);

function isLight(item: C4Item): boolean {
  const cats = (item.categories ?? []).map((c) => c.toLowerCase());
  if (cats.includes("lights")) return true;
  const proxy = (item.proxy ?? "").toLowerCase();
  return proxy.includes("light") || proxy.includes("dimmer") || proxy.includes("keypad");
}

function isThermostat(item: C4Item): boolean {
  const cats = (item.categories ?? []).map((c) => c.toLowerCase());
  return cats.includes("comfort") || cats.includes("hvac");
}

function isLock(item: C4Item): boolean {
  const cats = (item.categories ?? []).map((c) => c.toLowerCase());
  return cats.includes("locks");
}

// ---------------------------------------------------------------------------
// Variable parsing helpers
// ---------------------------------------------------------------------------

function numVar(vars: C4Variable[], name: string): number | null {
  const v = vars.find((v) => v.name === name);
  if (v == null) return null;
  const n = Number(v.value);
  return isNaN(n) ? null : n;
}

function strVar(vars: C4Variable[], name: string): string | null {
  const v = vars.find((v) => v.name === name);
  return v != null ? String(v.value) : null;
}

function parseLightVars(vars: C4Variable[]): { on: boolean; level: number } {
  const level = numVar(vars, "LightLevel") ?? 0;
  return { on: level > 0, level };
}

function parseThermostatVars(
  vars: C4Variable[],
): Pick<ThermostatState, "tempF" | "heatSetpointF" | "coolSetpointF" | "hvacMode"> {
  const deciKtoF = (dk: number) => Math.round(((dk / 10 - 273.15) * 9) / 5 + 32);

  const getTempF = (): number | null => {
    // Prefer _F suffixed vars (already in °F)
    const dispTemp = numVar(vars, "DISPLAY_TEMPERATURE");
    if (dispTemp != null) return dispTemp;
    const tempF = numVar(vars, "TEMPERATURE_F");
    if (tempF != null) return tempF;
    return null;
  };

  const getSetpointF = (base: string): number | null => {
    const fVar = numVar(vars, `${base}_F`);
    if (fVar != null) return fVar;
    const raw = numVar(vars, base);
    if (raw != null && raw > 2500) return deciKtoF(raw);
    return null;
  };

  return {
    tempF: getTempF(),
    heatSetpointF: getSetpointF("HEAT_SETPOINT"),
    coolSetpointF: getSetpointF("COOL_SETPOINT"),
    hvacMode: strVar(vars, "HVAC_MODE"),
  };
}

function parseLockVars(vars: C4Variable[]): boolean | null {
  const relay = numVar(vars, "RelayState");
  if (relay == null) return null;
  // 0 = locked, 1 = unlocked
  return relay === 0;
}

// ---------------------------------------------------------------------------
// Audio source map (parsed from ui_configuration)
// ---------------------------------------------------------------------------

type RoomAudioMap = Map<number, AudioSource[]>;

function parseUiConfig(rawConfig: unknown): RoomAudioMap {
  const map = new Map<number, AudioSource[]>();
  if (!rawConfig || typeof rawConfig !== "object") return map;
  const config = rawConfig as Record<string, unknown>;
  const experiences = config["experiences"];
  if (!Array.isArray(experiences)) return map;
  for (const exp of experiences) {
    if (!exp || typeof exp !== "object") continue;
    const e = exp as Record<string, unknown>;
    if (e["type"] !== "listen") continue;
    const roomId = typeof e["room_id"] === "number" ? e["room_id"] : null;
    if (roomId == null) continue;
    const sourcesObj = e["sources"] as Record<string, unknown> | undefined;
    if (!sourcesObj) continue;
    const rawSources = sourcesObj["source"];
    const sourceList = Array.isArray(rawSources) ? rawSources : rawSources ? [rawSources] : [];
    const sources: AudioSource[] = [];
    for (const s of sourceList) {
      if (!s || typeof s !== "object") continue;
      const src = s as Record<string, unknown>;
      const id = typeof src["id"] === "number" ? src["id"] : null;
      const name = typeof src["name"] === "string" ? src["name"] : null;
      if (id == null || name == null) continue;
      sources.push({ id, name });
    }
    if (sources.length > 0) map.set(roomId, sources);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Full state fetch
// ---------------------------------------------------------------------------

async function fetchFullState(
  rooms: C4Item[],
  devicesByRoom: Map<number, C4Item[]>,
  audioMap: RoomAudioMap,
): Promise<HomeState> {
  const roomStates: RoomState[] = [];

  await Promise.allSettled(
    rooms.map(async (room) => {
      const devices = devicesByRoom.get(room.id) ?? [];
      const lights = devices.filter(isLight);
      const thermostats = devices.filter(isThermostat);
      const locks = devices.filter(isLock);

      // Fetch variables in parallel
      const lightVarResults = await Promise.allSettled(
        lights.map((l) => getVariables(l.id)),
      );
      const thermoVarResults = await Promise.allSettled(
        thermostats.map((t) => getVariables(t.id)),
      );
      const lockVarResults = await Promise.allSettled(
        locks.map((l) => getVariables(l.id)),
      );

      // Audio room variables
      let currentVolume: number | null = null;
      let currentSourceId: number | null = null;
      const audioSources = audioMap.get(room.id);
      if (audioSources && audioSources.length > 0) {
        try {
          const audioVars = await getVariables(room.id);
          currentVolume = numVar(audioVars, "CURRENT_VOLUME");
          currentSourceId = numVar(audioVars, "CURRENT_AUDIO_DEVICE_ID");
        } catch {
          // Audio vars may not be available — ignore
        }
      }

      const lightStates: LightState[] = lights.map((l, i) => {
        const r = lightVarResults[i];
        const vars = r.status === "fulfilled" ? r.value : [];
        const { on, level } = parseLightVars(vars);
        return { id: l.id, name: l.name, on, level };
      });

      const thermoStates: ThermostatState[] = thermostats.map((t, i) => {
        const r = thermoVarResults[i];
        const vars = r.status === "fulfilled" ? r.value : [];
        return { id: t.id, name: t.name, ...parseThermostatVars(vars) };
      });

      const lockStates: LockState[] = locks.map((l, i) => {
        const r = lockVarResults[i];
        const vars = r.status === "fulfilled" ? r.value : [];
        return { id: l.id, name: l.name, locked: parseLockVars(vars) };
      });

      const audio: AudioZoneState | null =
        audioSources && audioSources.length > 0
          ? { roomId: room.id, sources: audioSources, currentVolume, currentSourceId }
          : null;

      roomStates.push({
        id: room.id,
        name: room.name,
        lights: lightStates,
        thermostats: thermoStates,
        audio,
        locks: lockStates,
      });
    }),
  );

  // Sort rooms: known living areas first
  const PRIORITY = ["living", "kitchen", "dining", "family", "master", "bedroom", "office", "library", "gym", "garage"];
  roomStates.sort((a, b) => {
    const aP = PRIORITY.findIndex((p) => a.name.toLowerCase().includes(p));
    const bP = PRIORITY.findIndex((p) => b.name.toLowerCase().includes(p));
    if (aP === -1 && bP === -1) return a.name.localeCompare(b.name);
    if (aP === -1) return 1;
    if (bP === -1) return -1;
    return aP - bP;
  });

  return { rooms: roomStates, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Diff detection
// ---------------------------------------------------------------------------

function diffRooms(prev: HomeState, next: HomeState): RoomState[] {
  const changed: RoomState[] = [];
  const prevMap = new Map(prev.rooms.map((r) => [r.id, r]));
  for (const room of next.rooms) {
    const prevRoom = prevMap.get(room.id);
    if (!prevRoom || JSON.stringify(prevRoom) !== JSON.stringify(room)) {
      changed.push(room);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
let roomModel: { rooms: C4Item[]; byRoom: Map<number, C4Item[]>; audioMap: RoomAudioMap } | null = null;

async function buildRoomModel() {
  const [items, uiConfig] = await Promise.all([
    getItems(),
    getUiConfiguration().catch(() => null),
  ]);

  const audioMap = uiConfig ? parseUiConfig(uiConfig) : new Map<number, AudioSource[]>();

  const rooms = items.filter(
    (i) =>
      i.typeName === "room" && !SKIP_ROOM_NAMES.has(i.name.toLowerCase()),
  );

  const devices = items.filter((i) => !STRUCTURAL_TYPES.has(i.typeName));
  const byRoom = new Map<number, C4Item[]>();
  for (const d of devices) {
    if (d.roomId == null) continue;
    if (!byRoom.has(d.roomId)) byRoom.set(d.roomId, []);
    byRoom.get(d.roomId)!.push(d);
  }

  return { rooms, byRoom, audioMap };
}

async function poll() {
  if (!roomModel) return;
  try {
    const next = await fetchFullState(roomModel.rooms, roomModel.byRoom, roomModel.audioMap);
    if (!currentState) {
      currentState = next;
      broadcast("init", next);
    } else {
      const changed = diffRooms(currentState, next);
      currentState = next;
      if (changed.length > 0) {
        broadcast("patch", { rooms: changed, fetchedAt: next.fetchedAt });
      } else {
        broadcast("ping", {});
      }
    }
  } catch (err) {
    console.error("[poller] poll error:", err);
  }
}

export async function startPoller(): Promise<void> {
  console.log("[poller] building room model…");
  roomModel = await buildRoomModel();
  console.log(`[poller] ${roomModel.rooms.length} rooms loaded`);

  // Initial fetch
  await poll();

  // 5s interval
  pollTimer = setInterval(() => {
    poll().catch((err) => console.error("[poller] interval error:", err));
  }, 5000);
}

export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Force an immediate re-poll (called after commands). */
export async function triggerPoll(): Promise<void> {
  await poll();
}
