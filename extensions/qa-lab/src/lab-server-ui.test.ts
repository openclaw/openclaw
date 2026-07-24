// Qa Lab tests cover lab server ui plugin behavior.
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectContentType,
  missingUiHtml,
  proxyUpgradeRequest,
  resolveUiAssetVersion,
  tryResolveUiAsset,
} from "./lab-server-ui.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server ui helpers", () => {
  it("detects basic UI asset content types", () => {
    expect(detectContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(detectContentType("styles.css")).toBe("text/css; charset=utf-8");
    expect(detectContentType("main.js")).toBe("text/javascript; charset=utf-8");
    expect(detectContentType("icon.svg")).toBe("image/svg+xml");
  });

  it("renders the missing-ui placeholder html", () => {
    expect(missingUiHtml()).toContain("QA Lab UI not built");
    expect(missingUiHtml()).toContain("pnpm qa:lab:build");
  });

  it("hashes built UI assets and changes when bundle contents change", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-dist-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const version1 = resolveUiAssetVersion(uiDistDir);
    expect(version1).toMatch(/^[0-9a-f]{12}$/);

    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab Updated</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const version2 = resolveUiAssetVersion(uiDistDir);
    expect(version2).toMatch(/^[0-9a-f]{12}$/);
    expect(version2).not.toBe(version1);
  });

  it("never resolves sibling files outside the UI dist root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-boundary-"));
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });
    const uiDistDir = path.join(rootDir, "dist");
    const siblingDir = path.join(rootDir, "dist-other");
    await mkdir(uiDistDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><body>bundle-root</body></html>",
      "utf8",
    );
    await writeFile(path.join(siblingDir, "secret.txt"), "sibling-secret", "utf8");

    expect(tryResolveUiAsset("/", uiDistDir, rootDir)).toBe(path.join(uiDistDir, "index.html"));
    expect(tryResolveUiAsset("/../dist-other/secret.txt", uiDistDir, rootDir)).toBeNull();
  });

  it("rejects malformed percent-encoded UI asset paths", async () => {
    const uiDistDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-ui-malformed-"));
    cleanups.push(async () => {
      await rm(uiDistDir, { recursive: true, force: true });
    });
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><body>bundle-root</body></html>",
      "utf8",
    );

    expect(tryResolveUiAsset("/%E0%A4", uiDistDir, uiDistDir)).toBeNull();
  });
});

// Emulates the timeout behavior of a real net.Socket: setTimeout(ms) schedules
// a 'timeout' emission after ms (0 cancels it), matching what Node does so the
// connect-stage deadline is testable with fake timers.
class FakeUpstreamSocket extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | undefined;

  setTimeout = (ms: number) => {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (ms > 0) {
      this.timer = setTimeout(() => this.emit("timeout"), ms);
    }
  };
  destroy = vi.fn(() => {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.emit("close");
  });
  write = vi.fn();
  pipe = vi.fn(() => this);
  destroyed = false;
}

function buildClientSocket(): Duplex {
  const socket = new EventEmitter();
  // proxyUpgradeRequest pipes the upstream <-> client socket and destroys both
  // on cleanup; provide the minimum surface the proxy touches.
  const fake = Object.assign(socket, {
    destroyed: false,
    destroy: vi.fn(() => {
      fake.destroyed = true;
    }),
    pipe: vi.fn(() => fake),
    write: vi.fn(() => true),
  });
  return fake as unknown as Duplex;
}

describe("proxyUpgradeRequest", () => {
  let tlsSpy: ReturnType<typeof vi.spyOn>;
  let netSpy: ReturnType<typeof vi.spyOn>;
  let upstream: FakeUpstreamSocket;

  beforeEach(() => {
    upstream = new FakeUpstreamSocket();
    // vi.mock does not intercept `node:tls`/`node:net` built-ins reliably in
    // vitest, so spy on the live default-export object that lab-server-ui.ts
    // imports. Node applies the `timeout` option by calling socket.setTimeout
    // internally; mirror that so the connect-stage deadline is observable.
    tlsSpy = vi.spyOn(tls, "connect").mockImplementation((options) => {
      upstream.setTimeout((options as { timeout?: number }).timeout ?? 0);
      return upstream as never;
    });
    netSpy = vi.spyOn(net, "connect").mockImplementation((options) => {
      upstream.setTimeout((options as { timeout?: number }).timeout ?? 0);
      return upstream as never;
    });
  });

  afterEach(() => {
    tlsSpy.mockRestore();
    netSpy.mockRestore();
    vi.useRealTimers();
  });

  it("clears the connect-stage deadline once the upstream handshake succeeds", () => {
    const clientSocket = buildClientSocket();
    const setTimeoutSpy = vi.spyOn(upstream, "setTimeout");
    const req = { url: "/ws", method: "GET", rawHeaders: [], httpVersion: "1.1" };
    proxyUpgradeRequest({
      req: req as never,
      socket: clientSocket,
      head: Buffer.alloc(0),
      target: new URL("https://upstream.local"),
    });

    // The connect-stage deadline (10s) was applied via the `timeout` option.
    expect(tlsSpy).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10_000 }));
    upstream.emit("connect");

    // The established stream must not carry the connect-stage deadline.
    expect(setTimeoutSpy).toHaveBeenCalledWith(0);
    // The upgrade request line was forwarded to the upstream.
    expect(upstream.write).toHaveBeenCalledWith(expect.stringContaining("HTTP/1.1"));
  });

  it("replies 504 and tears down both sockets when the upstream stalls past the connect deadline", async () => {
    vi.useFakeTimers();
    const clientSocket = buildClientSocket();
    const writes: string[] = [];
    (clientSocket as unknown as { write: ReturnType<typeof vi.fn> }).write.mockImplementation(
      (chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      },
    );
    const req = { url: "/ws", method: "GET", rawHeaders: [], httpVersion: "1.1" };
    proxyUpgradeRequest({
      req: req as never,
      socket: clientSocket,
      head: Buffer.alloc(0),
      target: new URL("https://upstream.local"),
    });

    // No connect, no error: a silent stall. Advance to the connect deadline.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(writes).toContain("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n");
    expect(upstream.destroy).toHaveBeenCalled();
    expect((clientSocket as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});
