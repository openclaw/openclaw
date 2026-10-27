import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createVisitorAccessReader } from "./src/access.js";
import { VisitorPolicyClient } from "./src/cloudflare.js";
import { visitorConfigSchema, visitorPluginSchema } from "./src/config.js";
import { visitorErrorText } from "./src/errors.js";
import type { VisitorGrant } from "./src/grant-record.js";
import { resolveVisitorSignInUrl } from "./src/invite-result.js";
import { profileUsesVisitorRole, resolveVisitorRole } from "./src/roles.js";
import { visitorRuntimeStore, type VisitorRuntime } from "./src/runtime.js";
import { createVisitorTools } from "./src/tools.js";
import { VisitorAccessService } from "./src/visitors.js";
import { VisitorWelcome, WELCOME_ENSURE_METHOD } from "./src/welcome.js";

function registerVisitorPlugin(api: OpenClawPluginApi): void {
  if (api.registrationMode === "cli-metadata") {
    return;
  }
  for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (ctx) => createVisitorTools(ctx).find((tool) => tool.name === name),
      },
      { name },
    );
  }
  if (api.registrationMode !== "full") {
    return;
  }
  const config = visitorConfigSchema.parse(api.pluginConfig);
  const lifetime = new AbortController();
  const store = api.runtime.state.openKeyedStore<VisitorGrant>({
    namespace: "visitor-grants",
    // Fixed storage bound survives config reload; maxVisitors controls admission.
    maxEntries: 500,
    overflowPolicy: "reject-new",
  });
  const service = new VisitorAccessService(
    config,
    store,
    new VisitorPolicyClient(
      config,
      fetch,
      lifetime.signal,
      () => api.runtime.config.current().gateway?.auth?.trustedProxy?.cloudflareAccessOidc,
    ),
    api.logger,
    createVisitorAccessReader(api.runtime),
    api.runtime.gateway.resolveGitHubAccount,
    lifetime.signal,
  );
  const runtime: VisitorRuntime = {
    service,
    async readInviter() {
      // Best-effort attribution only. users.self uses the bound requester, never a tool argument,
      // sender ID, or session owner. Unidentified/system turns must not borrow a human identity.
      try {
        const { profile } = await api.runtime.gateway.request<{
          profile: { id: string; displayName?: string | null };
        }>("users.self", {}, { scopes: ["operator.read"] });
        return profile.id === "gateway-owner"
          ? undefined
          : {
              profileId: profile.id,
              ...(profile.displayName ? { label: profile.displayName } : {}),
            };
      } catch {
        return undefined;
      }
    },
    readSignInUrl: () => resolveVisitorSignInUrl(api.runtime.config.current()),
    errorText: (error) => visitorErrorText(error, config.apiToken),
  };

  // Read only while setting up a welcome session, at most once per invitation.
  const welcome = new VisitorWelcome(
    service,
    api.runtime.gateway,
    () => api.runtime.config.current({ clone: true }),
    api.logger,
  );
  // Pulled by the guest Control UI on load; params select nothing (see README "Welcome session").
  api.registerGatewayMethod(
    WELCOME_ENSURE_METHOD,
    async ({ client, respond }) => {
      respond(true, await welcome.ensure(client));
    },
    { scope: "operator.sessions.write", profileAccess: "required" },
  );

  api.registerGatewayAccessPolicy({
    resume({ profile, grantId }) {
      return service.resume(profile.emails, grantId, profile.githubAccountIds);
    },
    authorize({ config: currentConfig, profile, requiredByRole }) {
      const roles = currentConfig.gateway?.roles;
      if (
        !requiredByRole ||
        !profileUsesVisitorRole(roles, { id: profile.profileId, role: profile.assignedRole })
      ) {
        return undefined;
      }
      resolveVisitorRole(currentConfig);
      return service.authorize(profile.emails, profile.githubAccountIds);
    },
  });

  let interval: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  const sweep = () => {
    sweeping ??= (api.lifecycle.runInBackgroundContext?.(() => service.sweep()) ?? service.sweep())
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted) {
          api.logger.error(
            `visitor-access sweep failed: ${visitorErrorText(error, config.apiToken)}`,
          );
        }
      })
      .finally(() => {
        sweeping = undefined;
      });
    return sweeping;
  };
  const start = () => {
    lifetime.signal.throwIfAborted();
    const active = visitorRuntimeStore.tryGetRuntime();
    if (active && active !== runtime) {
      throw new Error("A visitor-access Gateway service is already running.");
    }
    return (starting ??= (async () => {
      await service.initialize();
      lifetime.signal.throwIfAborted();
      const current = visitorRuntimeStore.tryGetRuntime();
      if (current && current !== runtime) {
        service.close();
        throw new Error("A visitor-access Gateway service is already running.");
      }
      visitorRuntimeStore.setRuntime(runtime);
      interval ??= setInterval(() => {
        void sweep();
      }, 3_600_000);
      interval.unref();
      // Admission checks the loaded grant's expiry; provider cleanup need not delay connects.
      void sweep();
    })());
  };
  api.on("gateway_start", start);
  // Services, unlike gateway hooks alone, stop on plugin hot replacement too.
  api.registerService({
    id: "visitor-access-expiry",
    start,
    async stop() {
      clearInterval(interval);
      interval = undefined;
      service.close();
      lifetime.abort();
      await service.waitForIdle();
      await sweeping;
      if (visitorRuntimeStore.tryGetRuntime() === runtime) {
        visitorRuntimeStore.clearRuntime();
      }
    },
  });
}

export default definePluginEntry({
  id: "visitor-access",
  name: "Visitor Access",
  description: "Internal Cloudflare Access visitor grants with managed expiry.",
  configSchema: visitorPluginSchema,
  register: registerVisitorPlugin,
});
