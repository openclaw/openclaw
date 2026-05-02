import {
  type Announcement,
  defaultIdentityPath,
  formatPubkey,
  fromHex,
  type Identity,
  loadOrCreateIdentity,
  signAnnouncement,
  sign,
  toHex,
} from "@lobstah/protocol";
import { startWorker } from "@lobstah/worker";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const enc = new TextEncoder();

const announceOnce = async (
  identity: Identity,
  trackerUrl: string,
  announceUrl: string,
  label: string,
  ttlSeconds: number,
  models: string[],
): Promise<{ ok: boolean; error?: string }> => {
  const announcement: Announcement = {
    version: 1,
    pubkey: formatPubkey(identity.publicKey),
    url: announceUrl,
    label,
    models,
    ttlSeconds,
    announcedAt: Date.now(),
  };
  const signed = signAnnouncement(announcement, identity.secretKey);
  try {
    const res = await fetch(`${trackerUrl.replace(/\/$/, "")}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${await res.text()}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const unannounce = async (identity: Identity, trackerUrl: string): Promise<void> => {
  const pubkey = formatPubkey(identity.publicKey);
  const timestamp = Date.now();
  const sig = sign(enc.encode(`unannounce:${pubkey}:${timestamp}`), identity.secretKey);
  try {
    await fetch(`${trackerUrl.replace(/\/$/, "")}/unannounce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, timestamp, signature: toHex(sig) }),
    });
  } catch {
    // best effort
  }
};

const fetchLocalModels = async (port: number): Promise<string[]> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/capacity`);
    if (!r.ok) return [];
    const cap = (await r.json()) as { models?: string[] };
    return cap.models ?? [];
  } catch {
    return [];
  }
};

export const worker = async (args: string[]): Promise<void> => {
  const portArg = flag(args, "--port");
  const hostArg = flag(args, "--host");
  const announceTo = flag(args, "--announce-to");
  const announceUrl = flag(args, "--announce-url");
  const announceLabel = flag(args, "--announce-label") ?? "lobstah-worker";
  const announceTtl = Number(flag(args, "--announce-ttl") ?? "300");
  const port = portArg ? Number(portArg) : undefined;

  if (announceTo && !announceUrl) {
    process.stderr.write("--announce-to requires --announce-url <reachable-url-of-this-worker>\n");
    process.exit(2);
  }

  const { identity } = await loadOrCreateIdentity();
  const pk = formatPubkey(identity.publicKey);

  const w = await startWorker({ identity, port, host: hostArg });

  process.stdout.write(`lobstah-worker listening on :${w.port}\n`);
  process.stdout.write(`  identity: ${defaultIdentityPath()}\n`);
  process.stdout.write(`  pubkey:   ${pk}\n`);
  process.stdout.write(`  engine:   ${w.engine}\n`);
  process.stdout.write(`  ollama:   ${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}\n`);

  let heartbeatTimer: NodeJS.Timeout | undefined;
  if (announceTo && announceUrl) {
    const models = await fetchLocalModels(w.port);
    const first = await announceOnce(
      identity,
      announceTo,
      announceUrl,
      announceLabel,
      announceTtl,
      models,
    );
    process.stdout.write(
      `  tracker:  ${announceTo}  ${first.ok ? `(announced as ${announceUrl})` : `(FAILED: ${first.error})`}\n`,
    );
    const heartbeatMs = Math.max(Math.floor((announceTtl * 1000) / 2), 30_000);
    heartbeatTimer = setInterval(() => {
      void (async () => {
        const m = await fetchLocalModels(w.port);
        const r = await announceOnce(
          identity,
          announceTo,
          announceUrl,
          announceLabel,
          announceTtl,
          m,
        );
        if (!r.ok) {
          process.stderr.write(`heartbeat announce FAILED: ${r.error}\n`);
        }
      })();
    }, heartbeatMs);
  }
  // Use unref so the heartbeat doesn't keep the process alive past server shutdown.
  heartbeatTimer?.unref();

  const shutdown = async (sig: string): Promise<void> => {
    process.stdout.write(`\nreceived ${sig}, shutting down...\n`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (announceTo) {
      process.stdout.write(`  unannouncing from ${announceTo}...\n`);
      await unannounce(identity, announceTo);
    }
    await w.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};
