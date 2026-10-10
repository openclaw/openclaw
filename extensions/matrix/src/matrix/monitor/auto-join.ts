import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { normalizeStringifiedEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixInviteAutoJoinTarget } from "../target-ids.js";

export function registerMatrixAutoJoin(params: {
  client: MatrixClient;
  accountConfig: Pick<MatrixConfig, "autoJoin" | "autoJoinAllowlist">;
  runtime: RuntimeEnv;
  runDetachedTask: (label: string, task: () => Promise<void>) => Promise<void>;
}): () => void {
  const { client, accountConfig, runtime } = params;
  const core = getMatrixRuntime();
  const logVerbose = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    runtime.log?.(message);
  };
  const autoJoin = accountConfig.autoJoin ?? "off";
  const rawAllowlist = normalizeStringifiedEntries(accountConfig.autoJoinAllowlist ?? []);
  const autoJoinAllowlist = new Set(rawAllowlist);
  const allowedRoomIds = new Set(rawAllowlist.filter((entry) => entry.startsWith("!")));
  const allowedAliases = rawAllowlist.filter((entry) => entry.startsWith("#"));
  const resolvedAliasRoomIds = new Map<string, string>();

  if (autoJoin === "off") {
    return () => {};
  }

  if (autoJoin === "always") {
    logVerbose("matrix: auto-join enabled for all invites");
  } else {
    logVerbose("matrix: auto-join enabled for allowlist invites");
    // Room-scoped matching only understands a room ID, an alias, or "*". Surface
    // entries that can never match (for example a Matrix user ID, which is not a
    // room target) at the default log level, otherwise an inert allowlist
    // silently ignores every invite. This observes the same target contract the
    // setup wizard enforces; it reports, and never rejects, saved config.
    const inertEntries = rawAllowlist.filter((entry) => !isMatrixInviteAutoJoinTarget(entry));
    if (inertEntries.length > 0) {
      core.logging
        .getChildLogger({ module: "matrix-auto-join" })
        .warn(
          `matrix: autoJoinAllowlist entries cannot match an invited room and are ignored: ${inertEntries.join(", ")}`,
        );
    }
  }

  const resolveAllowedAliasRoomId = async (alias: string): Promise<string | null> => {
    if (resolvedAliasRoomIds.has(alias)) {
      return resolvedAliasRoomIds.get(alias) ?? null;
    }
    const resolved = await params.client.resolveRoom(alias);
    if (resolved) {
      resolvedAliasRoomIds.set(alias, resolved);
    }
    return resolved;
  };

  const resolveAllowedAliasRoomIds = async (): Promise<string[]> => {
    const resolved = await Promise.all(
      allowedAliases.map(async (alias) => {
        try {
          return await resolveAllowedAliasRoomId(alias);
        } catch (err) {
          runtime.error?.(`matrix: failed resolving allowlisted alias ${alias}: ${String(err)}`);
          return null;
        }
      }),
    );
    return resolved.filter((roomId): roomId is string => Boolean(roomId));
  };
  // Handle invites directly so both "always" and "allowlist" modes share the same path.
  const onInvite = (roomId: string, _inviteEvent: unknown) => {
    void params.runDetachedTask(`auto-join invite handler room=${roomId}`, async () => {
      if (autoJoin === "allowlist") {
        const allowedAliasRoomIds = await resolveAllowedAliasRoomIds();
        const allowed =
          autoJoinAllowlist.has("*") ||
          allowedRoomIds.has(roomId) ||
          allowedAliasRoomIds.some((resolvedRoomId) => resolvedRoomId === roomId);

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
  };
  client.on("room.invite", onInvite);
  return () => {
    client.off("room.invite", onInvite);
  };
}
