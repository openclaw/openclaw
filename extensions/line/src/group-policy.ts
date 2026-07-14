// Line plugin module implements group policy behavior.
import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import {
  hasControlCommand,
  shouldComputeCommandAuthorized,
} from "openclaw/plugin-sdk/command-auth-native";
import { resolveExactLineGroupConfigKey, type OpenClawConfig } from "./channel-api.js";

type LineGroupContext = { cfg: OpenClawConfig; accountId?: string | null; groupId?: string | null };

export function resolveLineGroupRequireMention(params: LineGroupContext): boolean {
  const tree = buildChannelGroupsScopeTree(params.cfg, "line", params.accountId);
  const matchedKey = resolveExactLineGroupConfigKey({
    groups: tree.scopes,
    groupId: params.groupId,
  });
  return resolveScopeRequireMention({
    tree,
    path: matchedKey ? [matchedKey] : [],
  });
}

// Resolve the control-command flag consumed by mention gating. Groups gate
// mention-bypass on this flag, so they need the precise "starts with a real
// command" check; the broad shouldCompute* detector (true for any inline
// "/x"/"!x" token) would bypass requireMention on plain messages. DMs have no
// mention gate, so the broad detector is fine there. Mirrors googlechat.
export function resolveLineControlCommand(
  isGroup: boolean,
  text: string | undefined,
  cfg: OpenClawConfig,
): boolean {
  return isGroup ? hasControlCommand(text, cfg) : shouldComputeCommandAuthorized(text, cfg);
}
