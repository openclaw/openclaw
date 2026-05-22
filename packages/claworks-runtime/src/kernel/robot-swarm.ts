/**
 * robot-swarm.ts — ClaWorks 机器人群协作（Robot Swarm）
 *
 * 基于 A2A 协议实现对等机器人发现与配置同步。
 *
 * 协作维度（Collaboration）：
 *   - 通过 A2A agent-card 端点发现对等机器人
 *   - 从对等机器人同步技能、Playbook、身份信息
 *   - 广播自己的能力供对等机器人发现
 *
 * 事件：
 *   swarm.peer_discovered  — 发现新对等机器人
 *   swarm.peer_lost        — 对等机器人离线
 *   swarm.sync_completed   — 与对等机器人同步完成
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import type { CapabilityDescriptor } from "./capability-registry.js";

// ── 类型 ──────────────────────────────────────────────────────────────────

export type PeerRobotStatus = "online" | "offline" | "unknown";

export type PeerRobot = {
  id: string;
  name: string;
  endpoint: string;
  capabilities: string[];
  role?: string;
  organization?: string;
  domain?: string;
  lastSeen: Date;
  syncedAt?: Date;
  status: PeerRobotStatus;
};

export type SwarmSyncTarget = "skills" | "playbooks" | "identity" | "kb";

export type SwarmSyncResult = {
  synced: Record<SwarmSyncTarget, number>;
  peerId: string;
  duration_ms: number;
};

export type A2aAgentCard = {
  name?: string;
  description?: string;
  capabilities?: { skills?: Array<{ name: string; description?: string }> };
  tags?: string[];
  metadata?: {
    role?: string;
    organization?: string;
    domain?: string;
    claworks_version?: string;
    capabilities?: string[];
  };
};

export type SwarmAnnouncement = {
  id: string;
  name: string;
  endpoint: string;
  capabilities: string[];
  role?: string;
  organization?: string;
  domain?: string;
  announced_at: string;
};

export type RobotSwarm = {
  discover(broadcastOrRegistry?: string): Promise<PeerRobot[]>;
  syncFrom(peerId: string, what: SwarmSyncTarget[]): Promise<SwarmSyncResult>;
  announce(): Promise<void>;
  ping(peerId: string): Promise<boolean>;
  listPeers(): PeerRobot[];
  getPeer(id: string): PeerRobot | undefined;
};

// ── 内部状态 ──────────────────────────────────────────────────────────────

// ── HTTP 工具 ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── Agent Card 解析 ───────────────────────────────────────────────────────

function cardToPeer(endpoint: string, card: A2aAgentCard): PeerRobot {
  const caps: string[] = [];

  if (card.capabilities?.skills) {
    caps.push(...card.capabilities.skills.map((s) => s.name));
  }
  if (card.metadata?.capabilities) {
    caps.push(...card.metadata.capabilities);
  }

  const id = `peer:${new URL(endpoint).host}`;

  return {
    id,
    name: card.name ?? id,
    endpoint,
    capabilities: [...new Set(caps)],
    role: card.metadata?.role,
    organization: card.metadata?.organization,
    domain: card.metadata?.domain,
    lastSeen: new Date(),
    status: "online",
  };
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createRobotSwarm(runtime: ClaworksRuntime): RobotSwarm {
  const peers = new Map<string, PeerRobot>();

  // 从 config 加载已知 peers
  const configPeers = runtime.config.a2a?.peers ?? [];
  for (const p of configPeers) {
    const id = `peer:${new URL(p.url).host}`;
    peers.set(id, {
      id,
      name: p.name ?? id,
      endpoint: p.url,
      capabilities: [],
      lastSeen: new Date(0),
      status: "unknown",
    });
  }

  function updatePeer(peer: PeerRobot): void {
    const existing = peers.get(peer.id);
    peers.set(peer.id, { ...existing, ...peer });
  }

  return {
    async discover(broadcastOrRegistry?: string): Promise<PeerRobot[]> {
      const discovered: PeerRobot[] = [];

      // 1. 从配置的 peers 列表探测
      const endpointsToProbe: string[] = configPeers.map((p) => p.url);

      // 2. 如果提供了注册表 URL，从注册表获取 peers 列表
      if (broadcastOrRegistry) {
        const registry = await fetchJson<{ peers?: Array<{ endpoint: string }> }>(
          broadcastOrRegistry,
        );
        if (registry?.peers) {
          endpointsToProbe.push(...registry.peers.map((p) => p.endpoint));
        }
      }

      // 并发探测所有端点
      await Promise.all(
        endpointsToProbe.map(async (endpoint) => {
          const cardUrl = `${endpoint.replace(/\/$/, "")}/a2a/agent-card`;
          const card = await fetchJson<A2aAgentCard>(cardUrl, 3000);

          if (card) {
            const peer = cardToPeer(endpoint, card);
            updatePeer(peer);
            discovered.push(peer);

            // 发布发现事件
            await runtime.kernel.publish("swarm.peer_discovered", "robot-swarm", {
              peer_id: peer.id,
              peer_name: peer.name,
              capabilities: peer.capabilities,
              endpoint,
            });
            runtime.logger?.(`[swarm] 发现对等机器人：${peer.name} @ ${endpoint}`);
          } else {
            // 探测失败 — 标记为 offline
            const id = `peer:${new URL(endpoint).host}`;
            const existing = peers.get(id);
            if (existing && existing.status === "online") {
              updatePeer({ ...existing, status: "offline" });
              await runtime.kernel.publish("swarm.peer_lost", "robot-swarm", {
                peer_id: id,
                last_seen: existing.lastSeen.toISOString(),
              });
            }
          }
        }),
      );

      return discovered;
    },

    async syncFrom(peerId: string, what: SwarmSyncTarget[]): Promise<SwarmSyncResult> {
      const start = Date.now();
      const peer = peers.get(peerId);
      const synced: Record<SwarmSyncTarget, number> = {
        skills: 0,
        playbooks: 0,
        identity: 0,
        kb: 0,
      };

      if (!peer) {
        return { synced, peerId, duration_ms: Date.now() - start };
      }

      const baseUrl = peer.endpoint.replace(/\/$/, "");

      // 同步技能（从 agent-card）
      if (what.includes("skills")) {
        const card = await fetchJson<A2aAgentCard>(`${baseUrl}/a2a/agent-card`, 3000);
        if (card?.capabilities?.skills) {
          for (const skill of card.capabilities.skills) {
            await runtime.kb
              .ingest(
                `# 对等机器人技能：${skill.name}\n${skill.description ?? ""}\n\n来源：${peer.name} (${peer.endpoint ?? String((peer as Record<string, unknown>).url ?? "")})`,
                { source: `swarm:${peerId}`, namespace: "swarm" },
              )
              .catch(() => null);
            synced.skills++;
          }
        }
      }

      // 同步身份信息（更新本地 peer 记录）
      if (what.includes("identity")) {
        const status = await fetchJson<{
          robot?: { name?: string; role?: string; organization?: string };
        }>(`${baseUrl}/v1/status`, 3000);
        if (status?.robot) {
          updatePeer({
            ...peer,
            name: status.robot.name ?? peer.name,
            role: status.robot.role ?? peer.role,
            organization: status.robot.organization ?? peer.organization,
            syncedAt: new Date(),
          });
          synced.identity++;
        }
      }

      // 发布同步完成事件
      await runtime.kernel.publish("swarm.sync_completed", "robot-swarm", {
        peer_id: peerId,
        synced,
        duration_ms: Date.now() - start,
      });

      return { synced, peerId, duration_ms: Date.now() - start };
    },

    async announce(): Promise<void> {
      const announcement: SwarmAnnouncement = {
        id: runtime.robot.name,
        name: runtime.robot.name,
        endpoint:
          runtime.robot.endpoint ?? `http://localhost:${runtime.config.robot?.port ?? 8000}`,
        capabilities: runtime.capabilities.list().map((c) => c.id),
        role: runtime.robot.role,
        organization: runtime.config.robot?.organization,
        domain: runtime.config.robot?.domain,
        announced_at: new Date().toISOString(),
      };

      // 向所有已知 peers 广播
      const endpointsToNotify = configPeers.map((p) => p.url);

      await Promise.all(
        endpointsToNotify.map(async (endpoint) => {
          try {
            const url = `${endpoint.replace(/\/$/, "")}/a2a/tasks/send`;
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: `announce-${Date.now()}`,
                message: {
                  role: "user",
                  parts: [{ type: "text", text: `SWARM_ANNOUNCE:${JSON.stringify(announcement)}` }],
                },
              }),
              signal: AbortSignal.timeout(3000),
            });
          } catch {
            // 广播失败不阻断
          }
        }),
      );

      runtime.logger?.(`[swarm] 已广播自身能力（${announcement.capabilities.length} 个能力）`);

      await runtime.kernel.publish("swarm.announced", "robot-swarm", {
        capabilities_count: announcement.capabilities.length,
        peers_notified: endpointsToNotify.length,
      });
    },

    async ping(peerId: string): Promise<boolean> {
      const peer = peers.get(peerId);
      if (!peer) {
        return false;
      }

      const cardUrl = `${peer.endpoint.replace(/\/$/, "")}/a2a/agent-card`;
      const card = await fetchJson<A2aAgentCard>(cardUrl, 2000);

      if (card) {
        updatePeer({ ...peer, lastSeen: new Date(), status: "online" });
        return true;
      }
      updatePeer({ ...peer, status: "offline" });
      return false;
    },

    listPeers(): PeerRobot[] {
      return [...peers.values()];
    },

    getPeer(id: string): PeerRobot | undefined {
      return peers.get(id);
    },
  };
}

// ── 能力描述符 ────────────────────────────────────────────────────────────

export function makeSwarmCapabilities(swarm: RobotSwarm): CapabilityDescriptor[] {
  return [
    {
      id: "swarm.discover",
      verb: "acquire",
      description: "发现对等机器人（通过 A2A agent-card 探测）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        properties: {
          registry_url: { type: "string", description: "对等机器人注册表 URL（可选）" },
        },
      },
      handler: async (_ctx, params) => {
        const peers = await swarm.discover(params.registry_url as string | undefined);
        return {
          discovered: peers.length,
          peers: peers.map((p) => ({
            id: p.id,
            name: p.name,
            endpoint: p.endpoint,
            status: p.status,
          })),
        };
      },
    },
    {
      id: "swarm.sync_from",
      verb: "acquire",
      description: "从对等机器人同步配置（技能/Playbook/身份/知识库）",
      owner: { kind: "core" },
      paramsSchema: {
        type: "object",
        required: ["peer_id"],
        properties: {
          peer_id: { type: "string" },
          what: {
            type: "array",
            items: { type: "string", enum: ["skills", "playbooks", "identity", "kb"] },
            default: ["skills", "identity"],
          },
        },
      },
      handler: async (_ctx, params) => {
        const peerId = String(params.peer_id ?? "");
        const what = (params.what as SwarmSyncTarget[] | undefined) ?? ["skills", "identity"];
        return swarm.syncFrom(peerId, what);
      },
    },
    {
      id: "swarm.announce",
      verb: "control",
      description: "向所有对等机器人广播自己的能力",
      owner: { kind: "core" },
      handler: async () => {
        await swarm.announce();
        return { status: "announced", peers_count: swarm.listPeers().length };
      },
    },
    {
      id: "swarm.list",
      verb: "query",
      description: "列出所有已知的对等机器人",
      owner: { kind: "core" },
      handler: async () => ({
        peers: swarm.listPeers().map((p) => ({
          id: p.id,
          name: p.name,
          endpoint: p.endpoint,
          capabilities_count: p.capabilities.length,
          status: p.status,
          last_seen: p.lastSeen.toISOString(),
          synced_at: p.syncedAt?.toISOString() ?? null,
        })),
        count: swarm.listPeers().length,
      }),
    },
  ];
}
