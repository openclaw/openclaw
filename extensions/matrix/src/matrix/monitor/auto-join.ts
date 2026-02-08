import type { RuntimeEnv } from "openclaw/plugin-sdk";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { getMatrixRuntime } from "../../runtime.js";

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
  const autoJoinAllowlist = new Set(
    (cfg.channels?.matrix?.autoJoinAllowlist ?? [])
      .map((entry) => String(entry).trim())
      .filter(Boolean),
  );

  if (autoJoin === "off") {
    return;
  }

  if (autoJoin === "always") {
    logVerbose("matrix: auto-join enabled for all invites");
  } else {
    logVerbose("matrix: auto-join enabled for allowlist invites");
  }

  // Handle invites directly so both "always" and "allowlist" modes share the same path.
  client.on("room.invite", async (roomId: string, _inviteEvent: unknown) => {
    if (autoJoin === "allowlist") {
      let alias: string | undefined;
      let altAliases: string[] = [];
      try {
        const aliasState = await client
          .getRoomStateEvent(roomId, "m.room.canonical_alias", "")
          .catch(() => null);
        alias = aliasState && typeof aliasState.alias === "string" ? aliasState.alias : undefined;
        altAliases =
          aliasState && Array.isArray(aliasState.alt_aliases)
            ? aliasState.alt_aliases
                .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
                .filter(Boolean)
            : [];
      } catch {
        // Ignore errors
      }

      const allowed =
        autoJoinAllowlist.has("*") ||
        autoJoinAllowlist.has(roomId) ||
        (alias ? autoJoinAllowlist.has(alias) : false) ||
        altAliases.some((value) => autoJoinAllowlist.has(value));

      if (!allowed) {
        logVerbose(`matrix: invite ignored (not in allowlist) room=${roomId}`);
        return;
      }
    }

    try {
      await client.joinRoom(roomId);
      logVerbose(`matrix: joined room ${roomId}`);
    } catch (err) {
      runtime.error?.(`matrix: failed to join room ${roomId}: ${String(err)}`);
    }
  });
}
