import type { NotifyChannelTarget } from "./notify-types.js";
import type { RobotOwner } from "./robot-identity.js";
import type { ClaworksRuntime } from "./runtime-types.js";

/** 从 ObjectStore RobotOwner + robot.md Owner 解析通知目标。 */
export async function resolveNotifyTargets(
  runtime: ClaworksRuntime,
  channelId: string,
): Promise<NotifyChannelTarget[]> {
  const targets: NotifyChannelTarget[] = [];
  const seen = new Set<string>();

  const push = (channel: string, to: string) => {
    const key = `${channel}:${to}`;
    if (!to || seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push({ channel, to });
  };

  try {
    const { items } = await runtime.objectStore.query("RobotOwner", { limit: 50 });
    for (const row of items) {
      const ownerChannel = typeof row.channel_id === "string" ? row.channel_id : undefined;
      if (ownerChannel && ownerChannel !== channelId) {
        continue;
      }
      const ownerId = typeof row.owner_id === "string" ? row.owner_id : row.id;
      if (typeof ownerId === "string") {
        push(channelId, ownerId);
      }
    }
  } catch {
    // ObjectStore 未就绪时忽略
  }

  const owner = runtime.identity.owner;
  if (owner?.ownerId) {
    const ch = owner.channelId ?? channelId;
    push(ch, owner.ownerId);
  }

  return targets;
}

export function robotOwnerFromObject(row: Record<string, unknown>): RobotOwner | null {
  const ownerId = typeof row.owner_id === "string" ? row.owner_id : undefined;
  if (!ownerId) {
    return null;
  }
  return {
    ownerId,
    channelId: typeof row.channel_id === "string" ? row.channel_id : undefined,
    shiftSchedule: typeof row.shift_schedule === "string" ? row.shift_schedule : undefined,
  };
}
