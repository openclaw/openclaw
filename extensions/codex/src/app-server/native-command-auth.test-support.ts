import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { runQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";
import { isJsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

/** Seed only the caller's synthetic native home through Codex's actual OAuth/storage owner. */
export async function loginNativeCommandGatewayForTest(params: {
  launcher: string;
  codexHome: string;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}) {
  const command = resolveManagedCodexNativeCommand(params.launcher);
  if (!command) {
    throw new Error("Missing pinned native Codex executable");
  }
  const env = { ...params.env, CODEX_HOME: params.codexHome };
  const client = await createIsolatedCodexAppServerClient({
    startOptions: {
      transport: "stdio",
      command,
      commandSource: "config",
      args: ["app-server"],
      headers: {},
      homeScope: "user",
      cwd: params.cwd,
      env,
      clearEnv: Object.keys(process.env).filter((key) => !(key in env)),
    },
    authRequirement: "native-command",
    abandonSignal: params.signal,
  });
  const authorization = Promise.withResolvers<string>();
  const remove = client.addNotificationHandler((notification) => {
    if (
      notification.method === "account/gatewayOAuth/changed" &&
      isJsonObject(notification.params) &&
      typeof notification.params.authUrl === "string"
    ) {
      authorization.resolve(notification.params.authUrl);
    }
  });
  await runQaGatewayFixture(
    async () => {
      const login = client.request("account/gatewayOAuth/login", undefined, {
        signal: params.signal,
      });
      const url = new URL(
        await Promise.race([
          authorization.promise,
          login.then(() => {
            throw new Error("Missing native authorization URL");
          }),
        ]),
      );
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      if (
        callback.protocol !== "http:" ||
        callback.hostname !== "127.0.0.1" ||
        !url.searchParams.get("state")
      ) {
        throw new Error("Native fixture requires its loopback OAuth callback");
      }
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", url.searchParams.get("state")!);
      const guarded = await fetchWithSsrFGuard({
        url: callback.href,
        signal: params.signal,
        policy: {
          ...ssrfPolicyFromHttpBaseUrlAllowedOrigin(callback.origin),
          hostnameAllowlist: ["127.0.0.1"],
        },
        maxRedirects: 0,
      });
      try {
        await guarded.response.arrayBuffer();
        if (!guarded.response.ok) {
          throw new Error("Synthetic OAuth callback failed");
        }
      } finally {
        await guarded.release();
      }
      await login;
    },
    async () => {
      remove();
      const closed = await client.closeAndWait();
      if (!closed.exited) {
        throw new Error("Native OAuth setup process did not exit");
      }
    },
  );
}
