import { MessageFlags } from "discord-api-types/v10";
import type { serializePayload } from "./payload.js";

export type InteractionResponseState =
  | "unacknowledged"
  | "deferred"
  | "deferred-update"
  | "replied";

export function needsComponentsV2Query(body: ReturnType<typeof serializePayload>): boolean {
  return "flags" in body && ((body.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
}
