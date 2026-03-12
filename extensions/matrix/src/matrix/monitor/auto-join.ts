import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk/matrix";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { loadMatrixSdk } from "../sdk-runtime.js";

export function registerMatrixAutoJoin(params: {
  client: MatrixClient;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
}) {
  const { client, cfg, runtime } = params;
  const core = getMatrixRuntime();
  const logVerbose = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    runtime.log?.(message);
  };
  const autoJoin = cfg.channels?.matrix?.autoJoin ?? "always";
  const autoJoinAllowlist = cfg.channels?.matrix?.autoJoinAllowlist ?? [];

  if (autoJoin === "off") {
    return;
  }

  if (autoJoin === "always") {
    // Use the built-in autojoin mixin for "always" mode
    const { AutojoinRoomsMixin } = loadMatrixSdk();
    AutojoinRoomsMixin.setupOnClient(client);
    logVerbose("matrix: auto-join enabled for all invites");
    return;
  }

  // For "allowlist" mode, handle invites manually
  client.on("room.invite", async (roomId: string, inviteEvent: unknown) => {
    if (autoJoin !== "allowlist") {
      return;
    }

    const sender =
      inviteEvent && typeof inviteEvent === "object" && "sender" in inviteEvent
        ? String((inviteEvent as { sender?: unknown }).sender ?? "").trim()
        : "";

    // Get room alias if available
    let alias: string | undefined;
    let altAliases: string[] = [];
    try {
      const aliasState = await client
        .getRoomStateEvent(roomId, "m.room.canonical_alias", "")
        .catch(() => null);
      alias = aliasState?.alias;
      altAliases = Array.isArray(aliasState?.alt_aliases) ? aliasState.alt_aliases : [];
    } catch {
      // Ignore errors
    }

    const allowed =
      autoJoinAllowlist.includes("*") ||
      (sender ? autoJoinAllowlist.includes(sender) : false) ||
      autoJoinAllowlist.includes(roomId) ||
      (alias ? autoJoinAllowlist.includes(alias) : false) ||
      altAliases.some((value) => autoJoinAllowlist.includes(value));

    if (!allowed) {
      logVerbose(`matrix: invite ignored (not in allowlist) room=${roomId}`);
      return;
    }

    try {
      await client.joinRoom(roomId);
      logVerbose(`matrix: joined room ${roomId}`);
    } catch (err) {
      runtime.error?.(`matrix: failed to join room ${roomId}: ${String(err)}`);
    }
  });
}
