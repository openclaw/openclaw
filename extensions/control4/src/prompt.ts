import { getItems } from "./client.js";

let cachedPrompt: string | null = null;

async function buildRoomList(): Promise<string> {
  try {
    const items = await getItems();
    const rooms = items
      .filter((item) => item.typeName === "room")
      .sort((a, b) => a.id - b.id)
      .map((r) => `[${r.id}] ${r.name}`)
      .join(", ");
    return rooms || "(no rooms found)";
  } catch {
    return "(room list unavailable)";
  }
}

/** Build and cache the Control4 system prompt context. */
export async function buildControl4Prompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;

  const rooms = await buildRoomList();
  cachedPrompt = [
    "You have access to Control4 home automation tools.",
    `Rooms: ${rooms}`,
    "Use control4_find to locate devices by name, room, or type.",
    "Use control4_command to control devices (ON/OFF/RAMP_TO_LEVEL/SET_SCALE/SET_HVAC_MODE).",
    "Use control4_status to query current device state.",
    "When the user mentions a room or device by name, use control4_find first to get the device ID, then control4_command to act on it.",
    "For lights: RAMP_TO_LEVEL with param LEVEL='0' to '100', or just ON/OFF.",
    "For thermostats: SET_HVAC_MODE with param MODE='COOL'|'HEAT'|'AUTO'|'OFF'.",
  ].join("\n");

  return cachedPrompt;
}

/** Invalidate the cached prompt (e.g. if devices change). */
export function invalidatePromptCache(): void {
  cachedPrompt = null;
}
