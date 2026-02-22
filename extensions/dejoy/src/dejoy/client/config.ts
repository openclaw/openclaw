import { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { getDeJoyRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { ensureMatrixSdkLoggingConfigured } from "./logging.js";
import type { MatrixAuth, MatrixResolvedConfig } from "./types.js";

function clean(value?: string): string {
  return value?.trim() ?? "";
}

export function resolveMatrixConfig(
  cfg: CoreConfig = getDeJoyRuntime().config.loadConfig() as CoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const dejoy = cfg.channels?.dejoy ?? {};
  const homeserver = clean(dejoy.homeserver) || clean(env.DEJOY_HOMESERVER);
  const userId = clean(dejoy.userId) || clean(env.DEJOY_USER_ID);
  const accessToken = clean(dejoy.accessToken) || clean(env.DEJOY_ACCESS_TOKEN) || undefined;
  const password = clean(dejoy.password) || clean(env.DEJOY_PASSWORD) || undefined;
  const deviceName = clean(dejoy.deviceName) || clean(env.DEJOY_DEVICE_NAME) || undefined;
  const initialSyncLimit =
    typeof dejoy.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(dejoy.initialSyncLimit))
      : undefined;
  const encryption = dejoy.encryption ?? false;
  return {
    homeserver,
    userId,
    accessToken,
    password,
    deviceName,
    initialSyncLimit,
    encryption,
  };
}

export async function resolveMatrixAuth(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MatrixAuth> {
  const cfg = params?.cfg ?? (getDeJoyRuntime().config.loadConfig() as CoreConfig);
  const env = params?.env ?? process.env;
  const resolved = resolveMatrixConfig(cfg, env);
  if (!resolved.homeserver) {
    throw new Error("DeJoy homeserver is required (channels.dejoy.homeserver)");
  }

  const {
    loadMatrixCredentials,
    saveMatrixCredentials,
    credentialsMatchConfig,
    touchMatrixCredentials,
  } = await import("../credentials.js");

  const cached = loadMatrixCredentials(env);
  const cachedCredentials =
    cached &&
    credentialsMatchConfig(cached, {
      homeserver: resolved.homeserver,
      userId: resolved.userId || "",
    })
      ? cached
      : null;

  // If we have an access token, we can fetch userId via whoami if not provided
  if (resolved.accessToken) {
    let userId = resolved.userId;
    if (!userId) {
      // Fetch userId from access token via whoami
      ensureMatrixSdkLoggingConfigured();
      const tempClient = new MatrixClient(resolved.homeserver, resolved.accessToken);
      const whoami = await tempClient.getUserId();
      userId = whoami;
      // Save the credentials with the fetched userId
      saveMatrixCredentials({
        homeserver: resolved.homeserver,
        userId,
        accessToken: resolved.accessToken,
      });
    } else if (cachedCredentials && cachedCredentials.accessToken === resolved.accessToken) {
      touchMatrixCredentials(env);
    }
    return {
      homeserver: resolved.homeserver,
      userId,
      accessToken: resolved.accessToken,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  if (cachedCredentials) {
    touchMatrixCredentials(env);
    return {
      homeserver: cachedCredentials.homeserver,
      userId: cachedCredentials.userId,
      accessToken: cachedCredentials.accessToken,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
    };
  }

  if (!resolved.userId) {
    throw new Error(
      "DeJoy userId is required when no access token is configured (channels.dejoy.userId)",
    );
  }

  if (!resolved.password) {
    throw new Error(
      "DeJoy password is required when no access token is configured (channels.dejoy.password)",
    );
  }

  // Login with password using HTTP API
  const loginResponse = await fetch(`${resolved.homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: resolved.userId },
      password: resolved.password,
      initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway",
    }),
  });

  if (!loginResponse.ok) {
    const errorText = await loginResponse.text();
    throw new Error(`Matrix login failed: ${errorText}`);
  }

  const login = (await loginResponse.json()) as {
    access_token?: string;
    user_id?: string;
    device_id?: string;
  };

  const accessToken = login.access_token?.trim();
  if (!accessToken) {
    throw new Error("DeJoy login did not return an access token");
  }

  const auth: MatrixAuth = {
    homeserver: resolved.homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken,
    deviceName: resolved.deviceName,
    initialSyncLimit: resolved.initialSyncLimit,
    encryption: resolved.encryption,
  };

  saveMatrixCredentials({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    deviceId: login.device_id,
  });

  return auth;
}
