// Irc tests cover probe plugin behavior.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { onIrcTestLine, startIrcTestServer as startServer } from "./irc-server.test-support.js";
import { probeIrc } from "./probe.js";
import type { CoreConfig } from "./types.js";

async function startRegisteringServer() {
  const server = await startServer((socket) => {
    onIrcTestLine(socket, (line) => {
      if (line.startsWith("USER ")) {
        socket.write(":server 001 bot :welcome\r\n");
      }
    });
  });
  onTestFinished(() => server.close());
  return server;
}

function asConfig(irc: unknown): CoreConfig {
  return { channels: { irc } } as CoreConfig;
}

describe("probeIrc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ok with a real latency on success", async () => {
    const server = await startRegisteringServer();
    const cfg = asConfig({ host: "127.0.0.1", port: server.port, tls: false, nick: "bot" });

    const result = await probeIrc(cfg);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThan(5_000);
  });

  it("measures latency on the monotonic clock when the wall clock steps", async () => {
    const server = await startRegisteringServer();
    const cfg = asConfig({ host: "127.0.0.1", port: server.port, tls: false, nick: "bot" });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValue(1_700_000_000_000 - 3_600_000);
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValue(1_045);

    const result = await probeIrc(cfg);

    expect(result).toMatchObject({ ok: true, latencyMs: 45 });
  });
});
