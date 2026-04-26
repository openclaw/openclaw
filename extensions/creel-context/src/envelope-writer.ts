import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Envelope } from "./envelope.js";

// Writes the per-turn envelope summary to disk in the location
// bisque/skills/chat-history/scripts/search_context.py reads
// (`<workspaceDir>/state/envelope-summary.json` by default — overridable
// via the plugin config so operators can re-target during local debugging).
//
// File contents intentionally include only the fields the Python
// consumer touches, NOT the full envelope. Any extra debug fields we
// want to inspect should land in a sibling file (envelope-debug.json),
// not pollute the contract surface that the scope filter trusts.
export async function writeEnvelopeSummary(args: {
  path: string;
  envelope: Envelope;
}): Promise<void> {
  const summary = {
    sender_role: args.envelope.sender_role,
    is_owner: args.envelope.is_owner,
    context_type: args.envelope.context_type,
    owner_dm_unlock_for_turn: args.envelope.owner_dm_unlock_for_turn ?? false,
    // Optional metadata block the consumer ignores but that helps on-call
    // diagnose stale envelopes via `cat envelope-summary.json`.
    _meta: {
      channel: args.envelope.channel,
      handle: args.envelope.handle,
      session_key: args.envelope.session_key,
      user_id: args.envelope.user_id,
      handle_display: args.envelope.handle_display,
      resolved_at: args.envelope.resolved_at,
    },
  };
  await mkdir(dirname(args.path), { recursive: true });
  await writeFile(args.path, JSON.stringify(summary, null, 2), "utf8");
}
