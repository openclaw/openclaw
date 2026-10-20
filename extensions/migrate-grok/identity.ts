import {
  createMigrationConfigPatchItem,
  hasMigrationConfigPatchConflict,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { grokAvatarPath } from "./content.js";
import type { GrokSourceAgent } from "./source/types.js";
import type { GrokAgentTarget } from "./targets.js";

/** Existing config identity overrides IDENTITY.md; make that change visible in the preview. */
export function planGrokPrimaryIdentity(params: {
  agent: GrokSourceAgent;
  target: GrokAgentTarget;
  ctx: MigrationProviderContext;
  source: string;
}): MigrationItem[] {
  const { agent, target, ctx, source } = params;
  const current = ctx.config.agents?.entries?.[target.agentId];
  if (!current || !target.isPrimary) {
    return [];
  }
  const name = agent.name.replaceAll(/[\r\n]/g, " ");
  const avatar = grokAvatarPath(agent);
  const values = [
    { key: "name", path: ["name"], value: name, previous: current.name },
    {
      key: "identity.name",
      path: ["identity", "name"],
      value: name,
      previous: current.identity?.name,
    },
    ...(avatar
      ? [
          {
            key: "identity.avatar",
            path: ["identity", "avatar"],
            value: avatar,
            previous: current.identity?.avatar,
          },
        ]
      : []),
  ];
  return values.map(({ key, path, value, previous }) => {
    const configPath = ["agents", "entries", target.agentId, ...path];
    const item = createMigrationConfigPatchItem({
      id: `identity:${agent.id}:${key}`,
      source,
      path: configPath,
      target: configPath.join("."),
      value,
      message: `Import the primary bot's ${key}.`,
      conflict:
        previous !== value &&
        !ctx.overwrite &&
        hasMigrationConfigPatchConflict(ctx.config, configPath, value),
    });
    if (previous === value) {
      item.status = "skipped";
      item.reason = "already imported";
    }
    return item;
  });
}
