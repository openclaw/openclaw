import { DiscordApiError } from "@openclaw/discord/api.js";
import type { QaChannelE2eDoctorResult } from "../shared/channel-e2e.types.js";

export type DiscordE2eRuntimeEnv = {
  guildId: string;
  channelId: string;
  driverBotToken: string;
  sutBotToken: string;
  sutApplicationId: string;
};
export type DiscordE2eChannel = {
  id: string;
  guild_id?: string;
  parent_id?: string;
  type: number;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
};

export async function inspectDiscordE2eReadiness(params: {
  runtimeEnv: DiscordE2eRuntimeEnv;
  driverId: string;
  sutId: string;
  request: <T>(route: string, options?: { token?: string }) => Promise<T>;
  assertActive: () => void;
  connectRecorder: () => Promise<void>;
  waitForSutReady: () => Promise<void>;
}) {
  params.assertActive();
  const env = params.runtimeEnv;
  const checks: QaChannelE2eDoctorResult["checks"] = [];
  let canDeleteThreads = false;
  const check = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      params.assertActive();
      checks.push({ name, ok: true });
    } catch (error) {
      // Authority failures escape instead of becoming a capability miss.
      params.assertActive();
      checks.push({
        name,
        ok: false,
        detail:
          error instanceof DiscordApiError
            ? `Discord API status ${error.status}; inspect bot membership and channel permissions`
            : error instanceof Error
              ? error.message
              : "readiness failed",
      });
    }
  };
  await check("leased bot identities and channel permissions", async () => {
    const roles = await params.request<Array<{ id: string; permissions: string }>>(
      `/guilds/${env.guildId}/roles`,
    );
    for (const [id, token] of [
      [params.driverId, env.driverBotToken],
      [params.sutId, env.sutBotToken],
    ] as const) {
      const identity = await params.request<{ id: string; bot?: boolean }>("/users/@me", { token });
      if (
        !identity.bot ||
        identity.id !== id ||
        params.driverId === params.sutId ||
        params.sutId !== env.sutApplicationId
      ) {
        throw new Error("Discord E2E requires the exact two distinct leased bot identities");
      }
      const target = await params.request<DiscordE2eChannel>(`/channels/${env.channelId}`, {
        token,
      });
      if (target.id !== env.channelId || target.guild_id !== env.guildId || target.type !== 0) {
        throw new Error(
          "Discord E2E requires the leased guild text channel, not a DM or foreign channel",
        );
      }
      const member = await params.request<{ roles: string[] }>(
        `/guilds/${env.guildId}/members/${id}`,
        { token },
      );
      const roleIds = new Set([env.guildId, ...member.roles]);
      let permissions = roles.reduce(
        (bits, role) => (roleIds.has(role.id) ? bits | BigInt(role.permissions) : bits),
        0n,
      );
      if ((permissions & 8n) === 0n) {
        const overwrites = target.permission_overwrites ?? [];
        const everyone = overwrites.find(
          (overwrite) => overwrite.id === env.guildId && overwrite.type === 0,
        );
        if (everyone) {
          permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
        }
        const roleOverwrites = overwrites.filter(
          (overwrite) =>
            overwrite.type === 0 && overwrite.id !== env.guildId && roleIds.has(overwrite.id),
        );
        const deny = roleOverwrites.reduce((bits, overwrite) => bits | BigInt(overwrite.deny), 0n);
        const allow = roleOverwrites.reduce(
          (bits, overwrite) => bits | BigInt(overwrite.allow),
          0n,
        );
        permissions = (permissions & ~deny) | allow;
        const personal = overwrites.find(
          (overwrite) => overwrite.type === 1 && overwrite.id === id,
        );
        if (personal) {
          permissions = (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow);
        }
        const required: Record<string, bigint> = {
          ViewChannel: 1n << 10n,
          SendMessages: 1n << 11n,
          ReadMessageHistory: 1n << 16n,
          SendMessagesInThreads: 1n << 38n,
          ...(id === params.driverId
            ? {
                AddReactions: 1n << 6n,
                AttachFiles: 1n << 15n,
                CreatePublicThreads: 1n << 35n,
              }
            : {}),
        };
        const missing = Object.entries(required)
          .filter(([, bit]) => (permissions & bit) === 0n)
          .map(([name]) => name);
        if (missing.length) {
          throw new Error(
            `${id === params.driverId ? "Driver" : "SUT"} missing ${missing.join(", ")}; request an appropriately scoped QA lease`,
          );
        }
      }
      if (id === params.driverId) {
        canDeleteThreads = (permissions & (8n | (1n << 34n))) !== 0n;
      }
      await params.request<unknown[]>(`/channels/${env.channelId}/messages?limit=1`, { token });
    }
  });
  await check("driver Gateway and MESSAGE_CONTENT intent", params.connectRecorder);
  await check("SUT Gateway connected", params.waitForSutReady);
  const result: QaChannelE2eDoctorResult = {
    ok: checks.every((entry) => entry.ok),
    checks,
    capabilities: {
      automated: [
        "mention/quiet/reply ingress",
        "read/paginate",
        "owned driver edit/delete",
        "owned-message reaction add/remove",
        "file upload",
        "owned public thread create",
        canDeleteThreads ? "owned thread delete" : "owned thread archive (not deletion)",
        "correlated SUT reply",
      ],
      observationOnly: [
        "SUT revisions/deletes/reactions/typing",
        "public attachment metadata/embeds/components",
      ],
      manualClient: [
        "slash commands",
        "user component clicks",
        "modals",
        "ephemeral interactions",
        "bot DMs",
      ],
      unavailable: checks
        .filter((entry) => !entry.ok)
        .map((entry) => ({ capability: entry.name, reason: entry.detail ?? "readiness failed" })),
    },
  };
  return { result, canDeleteThreads };
}
