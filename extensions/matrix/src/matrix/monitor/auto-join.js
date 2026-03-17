import { getMatrixRuntime } from "../../runtime.js";
import { loadMatrixSdk } from "../sdk-runtime.js";
function registerMatrixAutoJoin(params) {
  const { client, cfg, runtime } = params;
  const core = getMatrixRuntime();
  const logVerbose = (message) => {
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
    const { AutojoinRoomsMixin } = loadMatrixSdk();
    AutojoinRoomsMixin.setupOnClient(client);
    logVerbose("matrix: auto-join enabled for all invites");
    return;
  }
  client.on("room.invite", async (roomId, _inviteEvent) => {
    if (autoJoin !== "allowlist") {
      return;
    }
    let alias;
    let altAliases = [];
    try {
      const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "").catch(() => null);
      alias = aliasState?.alias;
      altAliases = Array.isArray(aliasState?.alt_aliases) ? aliasState.alt_aliases : [];
    } catch {
    }
    const allowed = autoJoinAllowlist.includes("*") || autoJoinAllowlist.includes(roomId) || (alias ? autoJoinAllowlist.includes(alias) : false) || altAliases.some((value) => autoJoinAllowlist.includes(value));
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
export {
  registerMatrixAutoJoin
};
