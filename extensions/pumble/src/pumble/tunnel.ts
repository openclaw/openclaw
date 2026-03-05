import localtunnel from "localtunnel";

export type TunnelHandle = {
  url: string;
  /** Resolves when the tunnel connection dies (for reconnection). */
  died: Promise<Error>;
  close: () => void;
};

/**
 * Interval between health-check pings to the tunnel URL (ms).
 * localtunnel can silently lose its relay connection (503) without
 * emitting error/close events, so we ping periodically to detect it.
 */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/**
 * Open a localtunnel to expose a local port as a public HTTPS URL.
 *
 * If `staticUrl` is provided, the tunnel is skipped and the static URL
 * is returned directly (useful when the host already has a public address).
 *
 * The returned `died` promise resolves when the tunnel's underlying TCP
 * connection drops OR when the periodic health check detects the relay
 * is returning 503 — callers should race this against `addon.start()` so
 * `runWithReconnect` can tear down and re-establish the tunnel.
 */
export async function startTunnel(port: number, staticUrl?: string): Promise<TunnelHandle> {
  if (staticUrl) {
    // Static URLs are externally managed (e.g. ngrok, Cloudflare Tunnel).
    // `died` never resolves because the URL lifecycle is outside our control;
    // callers must use their own abort signal for clean shutdown. `close()` is
    // a no-op since there is no tunnel process to tear down.
    return { url: staticUrl.replace(/\/+$/, ""), died: new Promise(() => {}), close: () => {} };
  }

  const tunnel = await localtunnel({ port });

  let healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const died = new Promise<Error>((resolve) => {
    const onDeath = (err: Error) => {
      if (closed) return;
      closed = true;
      if (healthCheckTimer) clearInterval(healthCheckTimer);
      resolve(err);
    };

    // Standard localtunnel events
    tunnel.on("error", (err) => onDeath(err instanceof Error ? err : new Error(String(err))));
    tunnel.on("close", () => onDeath(new Error("localtunnel closed")));

    // Periodic health check: ping the tunnel URL to detect silent 503s.
    // localtunnel relay can stop routing traffic without closing the TCP
    // connection, so the error/close events never fire.
    healthCheckTimer = setInterval(async () => {
      if (closed) return;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(tunnel.url, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "manual",
        });
        clearTimeout(timeout);
        if (res.status === 503) {
          onDeath(new Error("tunnel health check failed: 503 relay unavailable"));
        }
      } catch (err) {
        // Network errors (ECONNREFUSED, timeout, etc.) also indicate death
        if (!closed) {
          onDeath(new Error(`tunnel health check failed: ${String(err)}`));
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  });

  return {
    url: tunnel.url,
    died,
    close: () => {
      closed = true;
      if (healthCheckTimer) clearInterval(healthCheckTimer);
      tunnel.close();
    },
  };
}
