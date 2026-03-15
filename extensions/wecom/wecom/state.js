import { AsyncLocalStorage } from "node:async_hooks";
import { WEBHOOK_BOT_SEND_URL } from "./constants.js";
import { resolveAgentConfigForAccount, resolveAccount } from "./accounts.js";

const runtimeState = {
  runtime: null,
  openclawConfig: null,
  ensuredDynamicAgentIds: new Set(),
  ensureDynamicAgentWriteQueue: Promise.resolve(),
};

export const dispatchLocks = new Map();
export const messageBuffers = new Map();
export const webhookTargets = new Map();
export const activeStreams = new Map();
export const activeStreamHistory = new Map();
export const lastStreamByKey = new Map();
export const streamMeta = new Map();
export const responseUrls = new Map();
export const streamContext = new AsyncLocalStorage();
export const kfPeerDispatchVersions = new Map();

export function setRuntime(runtime) {
  runtimeState.runtime = runtime;
}

export function getRuntime() {
  if (!runtimeState.runtime) {
    throw new Error("[wecom] Runtime not initialized");
  }
  return runtimeState.runtime;
}

export function setOpenclawConfig(config) {
  runtimeState.openclawConfig = config;
}

export function getOpenclawConfig() {
  return runtimeState.openclawConfig;
}

export function getEnsuredDynamicAgentIds() {
  return runtimeState.ensuredDynamicAgentIds;
}

export function getEnsureDynamicAgentWriteQueue() {
  return runtimeState.ensureDynamicAgentWriteQueue;
}

export function setEnsureDynamicAgentWriteQueue(queuePromise) {
  runtimeState.ensureDynamicAgentWriteQueue = queuePromise;
}

/**
 * Extract Agent API config from the runtime openclaw config.
 * Returns null when Agent mode is not configured.
 *
 * @param {string} [accountId] - Optional account ID. When omitted, first tries
 *   the streamContext async store, then falls back to the default account.
 */
export function resolveAgentConfig(accountId) {
  const config = getOpenclawConfig();
  // Determine effective accountId: explicit param > async context > default.
  const effectiveId =
    accountId || streamContext.getStore()?.accountId || undefined;
  return resolveAgentConfigForAccount(config, effectiveId);
}

/**
 * Resolve a webhook name to a full webhook URL.
 * Supports both full URLs and bare keys in config.
 * Returns null when the webhook name is not configured.
 *
 * @param {string} name - Webhook name from the `to` field (e.g. "ops-group")
 * @param {string} [accountId] - Optional account ID for multi-account lookup.
 * @returns {string|null}
 */
export function resolveWebhookUrl(name, accountId) {
  const config = getOpenclawConfig();
  const effectiveId =
    accountId || streamContext.getStore()?.accountId || undefined;
  const account = resolveAccount(config, effectiveId);
  const webhooks = account?.config?.webhooks;
  if (!webhooks || !webhooks[name]) return null;
  const value = webhooks[name];
  if (value.startsWith("http")) return value;
  return `${WEBHOOK_BOT_SEND_URL}?key=${encodeURIComponent(value)}`;
}

export function buildKfPeerKey(accountId, openKfId, externalUserId) {
  if (!openKfId || !externalUserId) return "";
  return `${accountId || "default"}:${openKfId}:${externalUserId}`;
}

export function nextKfPeerDispatchVersion(peerKey) {
  if (!peerKey) return 0;
  const next = (kfPeerDispatchVersions.get(peerKey) || 0) + 1;
  kfPeerDispatchVersions.set(peerKey, next);
  return next;
}

export function getKfPeerDispatchVersion(peerKey) {
  if (!peerKey) return 0;
  return kfPeerDispatchVersions.get(peerKey) || 0;
}
