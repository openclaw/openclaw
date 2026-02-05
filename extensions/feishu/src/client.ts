import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig, FeishuDomain } from "./types.js";
import { resolveFeishuCredentials } from "./accounts.js";

let cachedClient: Lark.Client | null = null;
let cachedConfig: { appId: string; appSecret: string; domain: FeishuDomain } | null = null;

function resolveDomain(domain: FeishuDomain): Lark.Domain | string {
  if (domain === "lark") return Lark.Domain.Lark;
  if (domain === "feishu") return Lark.Domain.Feishu;
  return domain.replace(/\/+$/, ""); // Custom URL, remove trailing slashes
}

export function createFeishuClient(cfg: FeishuConfig): Lark.Client {
  const creds = resolveFeishuCredentials(cfg);
  if (!creds) {
    throw new Error("Feishu credentials not configured (appId, appSecret required)");
  }

  if (
    cachedClient &&
    cachedConfig &&
    cachedConfig.appId === creds.appId &&
    cachedConfig.appSecret === creds.appSecret &&
    cachedConfig.domain === creds.domain
  ) {
    return cachedClient;
  }

  const client = new Lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(creds.domain),
  });

  cachedClient = client;
  cachedConfig = { appId: creds.appId, appSecret: creds.appSecret, domain: creds.domain };

  return client;
}

export function createFeishuWSClient(cfg: FeishuConfig): Lark.WSClient {
  const creds = resolveFeishuCredentials(cfg);
  if (!creds) {
    throw new Error("Feishu credentials not configured (appId, appSecret required)");
  }

  return new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain: resolveDomain(creds.domain),
    loggerLevel: Lark.LoggerLevel.info,
  });
}

export function createEventDispatcher(cfg: FeishuConfig): Lark.EventDispatcher {
  const creds = resolveFeishuCredentials(cfg);
  return new Lark.EventDispatcher({
    encryptKey: creds?.encryptKey,
    verificationToken: creds?.verificationToken,
  });
}

export function clearClientCache() {
  cachedClient = null;
  cachedConfig = null;
}
