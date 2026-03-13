import { resolvePilotAccount } from "./accounts.js";
import * as pilotctl from "./pilotctl.js";
import type { CoreConfig, PilotProbe } from "./types.js";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probePilot(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<PilotProbe> {
  const account = resolvePilotAccount({ cfg, accountId: opts?.accountId });
  const base: PilotProbe = {
    ok: false,
    daemonRunning: false,
    hostname: account.hostname || undefined,
  };

  if (!account.configured) {
    return {
      ...base,
      error: "missing hostname",
    };
  }

  const started = Date.now();
  try {
    const status = await pilotctl.daemonStatus({
      socketPath: account.socketPath,
      pilotctlPath: account.pilotctlPath,
      timeoutMs: opts?.timeoutMs ?? 8000,
    });
    const elapsed = Date.now() - started;

    if (!status.running) {
      return {
        ...base,
        error: "daemon not running",
      };
    }

    const peers = await pilotctl.trustList({
      socketPath: account.socketPath,
      pilotctlPath: account.pilotctlPath,
      timeoutMs: opts?.timeoutMs ?? 8000,
    });

    return {
      ...base,
      ok: true,
      daemonRunning: true,
      address: status.address,
      hostname: status.hostname ?? account.hostname,
      trustedPeers: peers.length,
      latencyMs: elapsed,
    };
  } catch (err) {
    return {
      ...base,
      error: formatError(err),
    };
  }
}
