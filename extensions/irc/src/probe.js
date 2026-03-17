import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
function formatError(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}
async function probeIrc(cfg, opts) {
  const account = resolveIrcAccount({ cfg, accountId: opts?.accountId });
  const base = {
    ok: false,
    host: account.host,
    port: account.port,
    tls: account.tls,
    nick: account.nick
  };
  if (!account.configured) {
    return {
      ...base,
      error: "missing host or nick"
    };
  }
  const started = Date.now();
  try {
    const client = await connectIrcClient(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: opts?.timeoutMs ?? 8e3
      })
    );
    const elapsed = Date.now() - started;
    client.quit("probe");
    return {
      ...base,
      ok: true,
      latencyMs: elapsed
    };
  } catch (err) {
    return {
      ...base,
      error: formatError(err)
    };
  }
}
export {
  probeIrc
};
