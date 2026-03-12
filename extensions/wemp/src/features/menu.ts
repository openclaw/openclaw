import { createHash } from "node:crypto";
import { getAccessToken, isTokenExpiredCode } from "../api.js";
import type { ResolvedWempAccount, WempMenuItem } from "../types.js";

export interface MenuFeatureConfig {
  enabled?: boolean;
  items?: WempMenuItem[];
}

interface WechatMenuApiResponse {
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

export interface WechatMenuResult<T = unknown> {
  ok: boolean;
  data?: T;
  errcode?: number;
  errmsg?: string;
}

export interface ApplyWechatMenuOptions {
  deleteWhenDisabled?: boolean;
}

export interface WechatMenuApplyResult<T = unknown> extends WechatMenuResult<T> {
  action: "create" | "delete" | "noop";
}

export function normalizeMenuFeature(cfg?: MenuFeatureConfig): Required<MenuFeatureConfig> {
  return {
    enabled: cfg?.enabled ?? false,
    items: Array.isArray(cfg?.items) ? cfg.items.map((item) => ({ ...item })) : [],
  };
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (obj[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableSerialize(obj[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sha256Hex(payload: unknown): string {
  return createHash("sha256").update(stableSerialize(payload)).digest("hex");
}

export function buildMenuConfigSignature(cfg?: MenuFeatureConfig): string {
  const normalized = normalizeMenuFeature(cfg);
  return sha256Hex({
    enabled: normalized.enabled,
    items: normalized.items,
  });
}

export function buildAccountConfigSignature(account: ResolvedWempAccount): string {
  return sha256Hex({
    accountId: account.accountId,
    enabled: account.enabled,
    name: account.name ?? "",
    appId: account.appId,
    appSecret: account.appSecret,
    token: account.token,
    encodingAESKey: account.encodingAESKey ?? "",
    webhookPath: account.webhookPath,
    dm: account.dm,
    routing: account.routing,
    features: account.features,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

async function requestWechatMenu<T extends WechatMenuApiResponse>(
  account: ResolvedWempAccount,
  action: "create" | "get" | "delete",
  init?: RequestInit,
  forceRefreshToken = false,
): Promise<WechatMenuResult<T>> {
  let token: string;
  try {
    token = await getAccessToken(account, forceRefreshToken);
  } catch (error) {
    return {
      ok: false,
      errcode: -1,
      errmsg: `token_error:${errorMessage(error)}`,
    };
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/menu/${action}?access_token=${encodeURIComponent(token)}`,
      init,
    );
  } catch (error) {
    return {
      ok: false,
      errcode: -1,
      errmsg: `request_error:${errorMessage(error)}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      errcode: res.status,
      errmsg: `http_${res.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return {
      ok: false,
      errcode: -1,
      errmsg: "invalid_json",
    };
  }

  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      errcode: -1,
      errmsg: "invalid_json",
    };
  }

  const data = payload as T;
  const errcode = typeof data.errcode === "number" ? data.errcode : undefined;
  const errmsg = typeof data.errmsg === "string" ? data.errmsg : undefined;
  if (errcode && errcode !== 0) {
    if (!forceRefreshToken && isTokenExpiredCode(errcode)) {
      return requestWechatMenu<T>(account, action, init, true);
    }
    return {
      ok: false,
      data,
      errcode,
      errmsg: errmsg ?? "wechat_api_error",
    };
  }

  return {
    ok: true,
    data,
    errcode,
    errmsg,
  };
}

export async function syncWechatMenu(
  account: ResolvedWempAccount,
): Promise<WechatMenuResult<WechatMenuApiResponse>> {
  const result = await applyWechatMenuConfig(account, account.features.menu);
  return result;
}

export async function applyWechatMenuConfig(
  account: ResolvedWempAccount,
  cfg?: MenuFeatureConfig,
  options: ApplyWechatMenuOptions = {},
): Promise<WechatMenuApplyResult<WechatMenuApiResponse>> {
  const feature = normalizeMenuFeature(cfg);
  const shouldDeleteWhenDisabled = options.deleteWhenDisabled ?? false;
  if (!feature.enabled || !feature.items.length) {
    if (!shouldDeleteWhenDisabled) return { ok: true, action: "noop" };
    const deleted = await deleteWechatMenu(account);
    return {
      ...deleted,
      action: "delete",
    };
  }

  const button = feature.items.map((item) => ({
    type: item.type,
    name: item.name,
    key: item.key,
    url: item.url,
  }));

  const created = await requestWechatMenu<WechatMenuApiResponse>(account, "create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ button }),
  });
  return {
    ...created,
    action: "create",
  };
}

export async function getWechatMenu(
  account: ResolvedWempAccount,
): Promise<WechatMenuResult<WechatMenuApiResponse>> {
  return requestWechatMenu<WechatMenuApiResponse>(account, "get");
}

export async function deleteWechatMenu(
  account: ResolvedWempAccount,
): Promise<WechatMenuResult<WechatMenuApiResponse>> {
  return requestWechatMenu<WechatMenuApiResponse>(account, "delete");
}
