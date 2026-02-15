import type { FeishuProbeResult } from "./types.js";
import { createFeishuClient, type FeishuClientCredentials } from "./client.js";

// Cache bot info per account so periodic health probes can skip the
// expensive GET /open-apis/bot/v3/info call that counts toward Feishu's
// monthly "basic API call" quota (10 000/month on the free tier).
const botInfoCache = new Map<string, { botName?: string; botOpenId?: string }>();

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  const accountId = creds.accountId ?? "default";

  try {
    const client = createFeishuClient(creds);

    // After the first successful probe we cache bot metadata and switch to
    // a lightweight token-validity check for subsequent calls.  The SDK's
    // TokenManager keeps the tenant_access_token in memory (~2 h TTL) and
    // only refreshes via POST /auth/v3/tenant_access_token/internal — an
    // auth-infrastructure endpoint that does not consume the basic-API-call
    // quota.
    const cached = botInfoCache.get(accountId);
    if (cached) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal SDK tokenManager
      await (client as any).tokenManager.getTenantAccessToken();
      return {
        ok: true,
        appId: creds.appId,
        botName: cached.botName,
        botOpenId: cached.botOpenId,
      };
    }

    // First probe: use bot/v3/info API to get bot information
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK generic request method
    const response = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code !== 0) {
      return {
        ok: false,
        appId: creds.appId,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
    }

    const bot = response.bot || response.data?.bot;

    // Cache bot info for future lightweight probes
    botInfoCache.set(accountId, {
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    });

    return {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
