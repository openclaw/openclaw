import { resolveIrcAccount } from "./accounts.js";
import { getLiveIrcClient } from "./client-registry.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import type { CoreConfig, IrcProbe } from "./types.js";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probeIrc(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<IrcProbe> {
  const account = resolveIrcAccount({ cfg, accountId: opts?.accountId });
  const base: IrcProbe = {
    ok: false,
    host: account.host,
    port: account.port,
    tls: account.tls,
    nick: account.nick,
  };

  if (!account.configured) {
    return {
      ...base,
      error: "missing host or nick",
    };
  }

  // If the monitor is already connected and healthy, report success without
  // opening a second connection (which would collide on the same nick).
  const liveClient = getLiveIrcClient(account.accountId);
  if (liveClient) {
    return {
      ...base,
      ok: true,
      latencyMs: 0,
    };
  }

  // No live monitor connection — open a temporary probe connection using the
  // configured nick. If the nick is in use the client's built-in 433 handler
  // will attempt NickServ GHOST recovery and then fall back to nick_ via
  // buildFallbackNick, matching the same path the monitor would take. This
  // keeps probe results representative of real startup success rather than
  // depending on the availability of an unrelated alternate nick.
  const started = Date.now();
  try {
    const client = await connectIrcClient(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: opts?.timeoutMs ?? 8000,
      }),
    );
    const elapsed = Date.now() - started;
    client.quit("probe");
    return {
      ...base,
      ok: true,
      latencyMs: elapsed,
    };
  } catch (err) {
    return {
      ...base,
      error: formatError(err),
    };
  }
}
