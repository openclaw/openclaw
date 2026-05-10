import { readOperatorInheritedEnvAllowlist } from "../daemon/service-managed-env.js";
import type { ExecAsk, ExecHost, ExecSecurity } from "../infra/exec-approvals.js";

// In trusted local exec posture (host=gateway, security=full, ask=off), the
// gateway may inherit operator-curated keys from `~/.openclaw/.env`
// (advertised via `OPENCLAW_SERVICE_MANAGED_ENV_KEYS`) into exec children.
// Outside that posture the allowlist is `undefined`, and
// `sanitizeHostExecEnv` keeps its strict default behavior.
export function resolveTrustedExecAllowlist(params: {
  host: ExecHost;
  security: ExecSecurity;
  ask: ExecAsk;
  env?: Record<string, string | undefined>;
}): Set<string> | undefined {
  if (params.host !== "gateway" || params.security !== "full" || params.ask !== "off") {
    return undefined;
  }
  return readOperatorInheritedEnvAllowlist(params.env ?? process.env);
}
