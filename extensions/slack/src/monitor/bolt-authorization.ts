import type { Authorize } from "@slack/bolt";
import type { AuthTestResponse, WebClientOptions } from "@slack/web-api";
import { createSlackStartupAuthClient } from "../client.js";

export function createSlackBoltAuthorization(token: string, clientOptions: WebClientOptions) {
  let cached: AuthTestResponse | undefined;
  let pending: Promise<AuthTestResponse> | undefined;
  const readAuthIdentity = async (refresh = false): Promise<AuthTestResponse> => {
    if (pending) {
      return await pending;
    }
    if (cached && !refresh) {
      return cached;
    }
    cached = undefined;
    // Each retry gets a fresh bounded auth client. A rejected request must not
    // poison authorization until restart; concurrent events share its outcome.
    pending = createSlackStartupAuthClient(token, clientOptions).auth.test();
    try {
      const auth = await pending;
      if (auth.user_id?.trim()) {
        cached = auth;
      }
      return auth;
    } finally {
      pending = undefined;
    }
  };
  const authorize: Authorize<boolean> = async ({ isEnterpriseInstall }) => {
    const auth = await readAuthIdentity();
    return {
      botToken: token,
      botUserId: auth.user_id,
      botId: auth.bot_id,
      isEnterpriseInstall,
    };
  };
  return { authorize, readAuthIdentity };
}
