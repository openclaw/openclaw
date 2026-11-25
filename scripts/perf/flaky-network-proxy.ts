// TCP fault injector in front of the owned admission proxy. It shapes the byte stream,
// so HTTP, service-worker fetches, and WebSockets all share one simulated link.
import net from "node:net";

export type NetworkFaults = {
  /** Added round trip; each chunk waits half of it per direction. */
  rttMs: number;
  /** Uniform extra per-chunk delay in [0, jitterMs]. */
  jitterMs: number;
  /** Shared per-direction bandwidth in bytes per second; 0 is unlimited. */
  downBps: number;
  upBps: number;
  /**
   * Hold every byte; new connections are accepted but stay silent. Flows that carried
   * bytes meanwhile stay silently dead afterwards.
   */
  blackhole: boolean;
  /** Reset new connections immediately; existing flows are unaffected. */
  refuse: boolean;
};

type Direction = "down" | "up";
type Flow = {
  client: net.Socket;
  upstream: net.Socket;
  /** First request line, enough to tell a stuck fetch from a WebSocket upgrade. */
  label: string;
  blackholed: boolean;
  dead: boolean;
  pipes: Array<{ flush(): void; clear(): void }>;
};

export async function startFlakyNetworkProxy(options: { port: number; upstreamPort: number }) {
  const faults: NetworkFaults = {
    rttMs: 0,
    jitterMs: 0,
    downBps: 0,
    upBps: 0,
    blackhole: false,
    refuse: false,
  };
  const stats = { accepted: 0, refused: 0, bytesDown: 0, bytesUp: 0 };
  const flows = new Set<Flow>();
  // Each direction's link is busy until this time; flows share it like one radio.
  const linkFreeAt = { down: 0, up: 0 };
  const transmitMs = (direction: Direction, bytes: number) => {
    const bps = direction === "down" ? faults.downBps : faults.upBps;
    if (!bps) {
      return 0;
    }
    const now = Date.now();
    linkFreeAt[direction] = Math.max(now, linkFreeAt[direction]) + (bytes / bps) * 1000;
    return linkFreeAt[direction] - now;
  };

  const pipe = (flow: Flow, direction: Direction, from: net.Socket, to: net.Socket) => {
    const queue: Array<{ chunk: Buffer; due: number }> = [];
    let timer: NodeJS.Timeout | undefined;
    let lastDue = 0;
    let ended = false;
    const pump = () => {
      clearTimeout(timer);
      timer = undefined;
      if (flow.dead) {
        queue.length = 0;
        return;
      }
      if (faults.blackhole) {
        return;
      }
      const now = Date.now();
      while (queue[0] && queue[0].due <= now) {
        const { chunk } = queue.shift()!;
        if (!to.destroyed) {
          to.write(chunk);
          stats[direction === "down" ? "bytesDown" : "bytesUp"] += chunk.length;
        }
      }
      if (queue[0]) {
        timer = setTimeout(pump, Math.max(1, queue[0].due - now));
      } else if (ended && !to.destroyed && !to.writableEnded) {
        // Forward FIN only after queued bytes, so a close never overtakes data.
        to.end();
      }
    };
    from.on("data", (chunk: Buffer) => {
      if (flow.dead) {
        return;
      }
      if (faults.blackhole) {
        flow.blackholed = true;
        return;
      }
      const oneWayMs = faults.rttMs / 2 + Math.random() * faults.jitterMs;
      lastDue = Math.max(lastDue, Date.now() + oneWayMs + transmitMs(direction, chunk.length));
      queue.push({ chunk, due: lastDue });
      timer ??= setTimeout(pump, Math.max(1, lastDue - Date.now()));
    });
    from.once("end", () => {
      ended = true;
      timer ??= setTimeout(pump, 1);
    });
    return {
      flush: pump,
      clear() {
        queue.length = 0;
        clearTimeout(timer);
      },
    };
  };

  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    if (faults.refuse) {
      stats.refused++;
      client.resetAndDestroy();
      return;
    }
    stats.accepted++;
    const upstream = net.connect({
      port: options.upstreamPort,
      host: "127.0.0.1",
      allowHalfOpen: true,
    });
    const flow: Flow = {
      client,
      upstream,
      label: "",
      blackholed: faults.blackhole,
      dead: false,
      pipes: [],
    };
    client.once("data", (chunk: Buffer) => {
      flow.label = chunk.subarray(0, 120).toString("latin1").split("\r\n", 1)[0] ?? "";
    });
    flows.add(flow);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    flow.pipes = [pipe(flow, "up", client, upstream), pipe(flow, "down", upstream, client)];
    const destroy = () => {
      flows.delete(flow);
      for (const queued of flow.pipes) {
        queued.clear();
      }
      client.destroy();
      upstream.destroy();
    };
    client.once("close", destroy);
    client.once("error", destroy);
    upstream.once("error", destroy);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    stats,
    faults: () => ({ ...faults }),
    /** Open flows; dead ones never deliver again and show what is stuck after an outage. */
    flows: () => ({
      open: flows.size,
      dead: [...flows].filter((flow) => flow.dead).map((flow) => flow.label),
    }),
    setFaults(patch: Partial<NetworkFaults>) {
      const wasBlackhole = faults.blackhole;
      Object.assign(faults, patch);
      if (wasBlackhole && !faults.blackhole) {
        // Lost NAT state: these flows never deliver again, and neither side sees FIN or RST.
        for (const flow of flows) {
          flow.dead ||= flow.blackholed;
        }
      }
      if (!faults.blackhole) {
        for (const flow of flows) {
          for (const queued of flow.pipes) {
            queued.flush();
          }
        }
      }
    },
    /** Abruptly reset every live flow, as after an IP change or captive portal. */
    resetAll() {
      for (const flow of flows) {
        flow.client.resetAndDestroy();
        flow.upstream.destroy();
      }
    },
    async close() {
      for (const flow of flows) {
        flow.client.destroy();
        flow.upstream.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
