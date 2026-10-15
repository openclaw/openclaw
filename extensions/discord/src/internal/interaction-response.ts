import { MessageFlags } from "discord-api-types/v10";

export type InteractionResponseState =
  | "unacknowledged"
  | "deferred"
  | "deferred-update"
  | "replied";

export function needsComponentsV2Query(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    "flags" in body &&
    typeof body.flags === "number" &&
    (body.flags & MessageFlags.IsComponentsV2) !== 0
  );
}
