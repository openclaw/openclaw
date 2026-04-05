import { getItems, getUiConfiguration, type C4Item } from "./client.js";

const STRUCTURAL_TYPES = new Set(["root", "site", "building", "floor", "room"]);

// Categories shown in the system prompt; maps C4 category → label.
// "motorization" is intentionally excluded — it covers both shades AND fireplaces; use proxy hints instead.
const PROMPT_CATEGORY_LABELS: Record<string, string> = {
  lights: "Lights",
  comfort: "Thermostat",
  hvac: "Thermostat",
  locks: "Locks",
  sensors: "Sensors",
  cameras: "Cameras",
};

// Proxy keyword fallbacks for devices without a recognized category label.
const PROXY_CATEGORY_HINTS: Array<[string, string]> = [
  ["light", "Lights"],
  ["dimmer", "Lights"],
  ["keypad", "Lights"],
  ["switch", "Lights"],
  ["therm", "Thermostat"],
  ["lock", "Locks"],
  ["shade", "Shades"],
  ["blind", "Shades"],
  ["motion", "Sensors"],
  ["camera", "Cameras"],
];

// Rooms to skip in the prompt (infrastructure/utility)
const SKIP_ROOM_NAMES = new Set([
  "c4 drivers",
  "shairbridge",
  "media support",
  "routines",
  "deck",
  "bbq",
  "hot tub",
]);

function getDeviceCategory(item: C4Item): string | null {
  for (const cat of item.categories ?? []) {
    const label = PROMPT_CATEGORY_LABELS[cat.toLowerCase()];
    if (label) return label;
  }
  // Fallback to proxy keyword
  const proxy = (item.proxy ?? "").toLowerCase();
  for (const [kw, label] of PROXY_CATEGORY_HINTS) {
    if (proxy.includes(kw)) return label;
  }
  return null;
}

function formatDeviceEntry(item: C4Item): string {
  return `${item.name}[${item.id}]`;
}

type AudioSource = {
  id: number;
  name: string;
  type: string;
};

type RoomAudioMap = Map<number, AudioSource[]>;

/**
 * Parse the ui_configuration response into a roomId → AudioSource[] map.
 * Handles: single source object vs array, missing sources, watch vs listen type.
 */
function parseUiConfig(rawConfig: unknown): RoomAudioMap {
  const map = new Map<number, AudioSource[]>();
  if (!rawConfig || typeof rawConfig !== "object") return map;

  const config = rawConfig as Record<string, unknown>;
  const experiences = config["experiences"];
  if (!Array.isArray(experiences)) return map;

  for (const exp of experiences) {
    if (!exp || typeof exp !== "object") continue;
    const e = exp as Record<string, unknown>;

    // Only care about "listen" type (audio zones, not video)
    if (e["type"] !== "listen") continue;

    const roomId = typeof e["room_id"] === "number" ? e["room_id"] : null;
    if (roomId == null) continue;

    const sourcesObj = e["sources"] as Record<string, unknown> | undefined;
    if (!sourcesObj) continue;

    // "source" can be a single object (when only one source) or an array
    const rawSources = sourcesObj["source"];
    const sourceList = Array.isArray(rawSources) ? rawSources : rawSources ? [rawSources] : [];

    const sources: AudioSource[] = [];
    for (const s of sourceList) {
      if (!s || typeof s !== "object") continue;
      const src = s as Record<string, unknown>;
      const id = typeof src["id"] === "number" ? src["id"] : null;
      const name = typeof src["name"] === "string" ? src["name"] : null;
      const type = typeof src["type"] === "string" ? src["type"] : "";
      if (id == null || name == null) continue;
      sources.push({ id, name, type });
    }

    if (sources.length > 0) {
      map.set(roomId, sources);
    }
  }

  return map;
}

type RoomSummary = {
  id: number;
  name: string;
  groups: Record<string, C4Item[]>;
  totalDevices: number;
  audioSources: AudioSource[];
};

function buildRoomSummaries(items: C4Item[], audioMap: RoomAudioMap): RoomSummary[] {
  const rooms = items.filter((i) => i.typeName === "room").sort((a, b) => a.id - b.id);
  const devices = items.filter((i) => !STRUCTURAL_TYPES.has(i.typeName));

  // Group devices by roomId
  const byRoomId = new Map<number, C4Item[]>();
  for (const d of devices) {
    const rid = d.roomId;
    if (rid == null) continue;
    if (!byRoomId.has(rid)) byRoomId.set(rid, []);
    byRoomId.get(rid)!.push(d);
  }

  const summaries: RoomSummary[] = [];
  for (const room of rooms) {
    if (SKIP_ROOM_NAMES.has(room.name.toLowerCase())) continue;

    const roomDevices = byRoomId.get(room.id) ?? [];
    const groups: Record<string, C4Item[]> = {};

    for (const d of roomDevices) {
      const cat = getDeviceCategory(d);
      if (!cat) continue;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(d);
    }

    summaries.push({
      id: room.id,
      name: room.name,
      groups,
      totalDevices: roomDevices.length,
      audioSources: audioMap.get(room.id) ?? [],
    });
  }
  return summaries;
}

function formatRoomBlock(room: RoomSummary): string {
  const catOrder = ["Lights", "Thermostat", "Locks", "Shades", "Sensors", "Cameras"];
  const lines: string[] = [`[${room.id}] ${room.name}`];

  for (const cat of catOrder) {
    const devs = room.groups[cat];
    if (!devs || devs.length === 0) continue;
    // For lights: list individual devices with IDs (useful for dimming)
    // For thermostats/locks: always show all (typically 1-2)
    // For sensors/cameras: just show count to save tokens
    if (cat === "Sensors" || cat === "Cameras") {
      lines.push(`  ${cat}: (${devs.length})`);
    } else {
      lines.push(`  ${cat}: ${devs.map(formatDeviceEntry).join(", ")}`);
    }
  }

  if (room.audioSources.length > 0) {
    const srcList = room.audioSources.map((s) => `[${s.id}] ${s.name}`).join(", ");
    lines.push(`  Audio sources: ${srcList} (send audio commands to room [${room.id}])`);
  }

  return lines.join("\n");
}

const PROMPT_MAX_RETRIES = 3;
const PROMPT_RETRY_DELAY_MS = 1000;

async function fetchWithRetry<T>(fn: () => Promise<T>, retries = PROMPT_MAX_RETRIES): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, PROMPT_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

/** Build and cache the full Control4 system prompt context. */
export async function buildControl4Prompt(): Promise<string> {
  if (_cachedPrompt) return _cachedPrompt;

  let body: string;
  try {
    const [items, uiConfig] = await Promise.all([
      fetchWithRetry(() => getItems()),
      fetchWithRetry(() => getUiConfiguration()).catch((err) => {
        process.stderr.write(`[control4] ui_configuration fetch failed: ${err}\n`);
        return null;
      }),
    ]);

    const audioMap = uiConfig ? parseUiConfig(uiConfig) : new Map<number, AudioSource[]>();
    const summaries = buildRoomSummaries(items, audioMap);
    const devices = items.filter((i) => !STRUCTURAL_TYPES.has(i.typeName));

    const roomBlocks = summaries.map(formatRoomBlock).join("\n\n");

    body = [
      `## Control4 Home (${summaries.length} rooms, ${devices.length} devices)`,
      "",
      "### Rooms and devices",
      roomBlocks,
      "",
      "### Commands",
      "- Lights ON/OFF: command=ON or OFF",
      "- Dim lights: command=RAMP_TO_LEVEL, params={LEVEL:'0'-'100'}",
      "- Thermostat mode: command=SET_HVAC_MODE, params={MODE:'COOL'|'HEAT'|'AUTO'|'OFF'}",
      "- Set heat target: command=SET_SETPOINT_HEAT, params={FAHRENHEIT:'72'}",
      "- Set cool target: command=SET_SETPOINT_COOL, params={FAHRENHEIT:'78'}",
      "- Audio source: command=SELECT_AUDIO_DEVICE, params={deviceid:'<source_id>'} → send to room ID",
      "- Volume: command=SET_VOLUME_LEVEL, params={LEVEL:'0'-'100'} → send to room ID",
      "- Playback: command=PLAY|PAUSE|STOP|SKIP FWD|SKIP REV → send to room ID",
      "- Audio off: command=DISCONNECT → send to room ID",
      "- Query state: use control4_status with device IDs",
      "",
      "### Usage",
      "When device IDs are shown above, call control4_command directly — no need for control4_find.",
      "Use control4_find only when looking for a device not listed above (e.g. by manufacturer, model, or a specific device type).",
    ].join("\n");
  } catch (err) {
    body = [
      "## Control4 Home",
      `Device inventory unavailable (${err instanceof Error ? err.message : String(err)}).`,
      "Use control4_find to locate devices, control4_command to control them, control4_status to query state.",
    ].join("\n");
  }

  _cachedPrompt = body;
  return body;
}

let _cachedPrompt: string | null = null;

/** Invalidate the cached prompt (e.g. after device list changes). */
export function invalidatePromptCache(): void {
  _cachedPrompt = null;
}
