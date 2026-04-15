/**
 * WebSocket 客户端多账号存储
 *
 * 使用 Map<accountId, WsClient> 管理多个并发连接，
 * 在 ws-gateway 启动时保存对应账号的 WsClient 引用，
 * 供 channel.ts 的 outbound.sendText 使用。
 */
import type { YuanbaoWsClient } from "./client.js";

const activeClients = new Map<string, YuanbaoWsClient>();

/**
 * 保存指定账号的 WebSocket 客户端引用
 * @param accountId - Account ID
 * @param client - WsClient 实例，传 null 表示移除该账号的引用
 */
export function setActiveWsClient(accountId: string, client: YuanbaoWsClient | null): void {
  if (client) {
    activeClients.set(accountId, client);
  } else {
    activeClients.delete(accountId);
  }
}

/**
 * 获取指定账号的 WebSocket 客户端引用
 * @param accountId - Account ID
 * @returns WsClient 实例或 null
 */
export function getActiveWsClient(accountId: string): YuanbaoWsClient | null {
  return activeClients.get(accountId) ?? null;
}

/**
 * 获取所有活跃的 WebSocket 客户端
 * @returns 只读的 accountId → WsClient 映射
 */
export function getAllActiveWsClients(): ReadonlyMap<string, YuanbaoWsClient> {
  return activeClients;
}
