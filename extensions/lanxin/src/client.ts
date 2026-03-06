import type { ClawdbotConfig } from "openclaw/plugin-sdk/lanxin";
import { resolveLanxinAccount } from "./accounts.js";
import { logLanxinDebug } from "./debug.js";
import { getLanxinValidToken } from "./token.js";

type LanxinApiResponse<T = unknown> = {
  errCode?: number;
  errMsg?: string;
  data?: T;
};

export async function lanxinApiPost<T>(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  path: string;
  body: Record<string, unknown> | FormData;
}): Promise<LanxinApiResponse<T>> {
  const account = resolveLanxinAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = await getLanxinValidToken(account);
  const url = new URL(params.path.replace(/^\//, ""), account.apiBaseUrl);
  url.searchParams.set("app_token", token);
  logLanxinDebug(params.cfg, "HTTP POST start", {
    path: params.path,
    isFormData: params.body instanceof FormData,
    accountId: account.accountId,
    url: url.toString().replace(token, "***"),
  });

  const response = await fetch(url, {
    method: "POST",
    headers:
      params.body instanceof FormData
        ? {
            Accept: "application/json",
          }
        : {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
    body: params.body instanceof FormData ? params.body : JSON.stringify(params.body),
  });
  logLanxinDebug(params.cfg, "HTTP POST response", {
    path: params.path,
    status: response.status,
    ok: response.ok,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Lanxin POST ${params.path} failed: HTTP ${response.status} body=${text.slice(0, 500)}`,
    );
  }
  let data: LanxinApiResponse<T>;
  try {
    data = (await response.json()) as LanxinApiResponse<T>;
  } catch (err) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Lanxin POST ${params.path} returned non-JSON response: ${String(err)} body=${text.slice(0, 500)}`,
    );
  }
  logLanxinDebug(params.cfg, "HTTP POST parsed body", {
    path: params.path,
    errCode: data.errCode,
    errMsg: data.errMsg,
    hasData: data.data !== undefined,
  });
  if (data.errCode !== undefined && data.errCode !== 0) {
    throw new Error(
      `Lanxin POST ${params.path} errCode=${data.errCode} errMsg=${data.errMsg ?? ""}`,
    );
  }
  return data;
}
