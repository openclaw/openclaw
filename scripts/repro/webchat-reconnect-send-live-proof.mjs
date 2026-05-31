#!/usr/bin/env node
/**
 * Live Control UI + Gateway proof: defer chat.send ACK, drop the WebSocket, verify one replay.
 *
 * Run:
 *   pnpm ui:build
 *   node scripts/repro/webchat-reconnect-send-live-proof.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function waitForGatewayReady(child, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`gateway did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      if (buffer.includes("[gateway] ready") || buffer.includes("http server listening")) {
        cleanup();
        resolve(buffer);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`gateway exited early code=${code ?? "null"} signal=${signal ?? "null"}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function stopGateway(child) {
  if (!child || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 5_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

const WS_SHIM = String.raw`
(() => {
  if (window.__openclawWsProofInstalled) {
    return;
  }
  window.__openclawWsProofInstalled = true;
  const Native = window.WebSocket;
  const state = {
    deferNextChatSend: false,
    deferredResponseId: null,
    chatSends: [],
    sockets: [],
  };
  window.__openclawWsProof = {
    deferNextChatSend() {
      state.deferNextChatSend = true;
    },
    closeActive(code = 4001, reason = "live proof ack loss") {
      const latest = state.sockets.at(-1);
      latest?.native.close(code, reason);
    },
    snapshot() {
      return {
        chatSends: state.chatSends.map((entry) => ({
          id: entry.id,
          idempotencyKey: entry.params?.idempotencyKey ?? null,
          message: entry.params?.message ?? null,
        })),
        deferredResponseId: state.deferredResponseId,
        socketCount: state.sockets.length,
      };
    },
  };

  function ProofWebSocket(url, protocols) {
    const native =
      protocols === undefined ? new Native(url) : new Native(url, protocols);
    const listeners = { open: [], message: [], close: [], error: [] };
    const entry = { native };
    state.sockets.push(entry);

    native.addEventListener("open", (ev) => {
      for (const listener of listeners.open) {
        listener.call(native, ev);
      }
    });
    native.addEventListener("message", (ev) => {
      const raw = String(ev.data ?? "");
      try {
        const frame = JSON.parse(raw);
        if (frame.type === "res" && frame.id && frame.id === state.deferredResponseId) {
          return;
        }
      } catch {
        // ignore parse errors
      }
      const messageEvent = typeof MessageEvent === "function" ? new MessageEvent("message", { data: raw }) : ev;
      for (const listener of listeners.message) {
        listener.call(native, messageEvent);
      }
    });
    native.addEventListener("close", (ev) => {
      for (const listener of listeners.close) {
        listener.call(native, ev);
      }
    });
    native.addEventListener("error", (ev) => {
      for (const listener of listeners.error) {
        listener.call(native, ev);
      }
    });

    const proxy = {
      get readyState() {
        return native.readyState;
      },
      get url() {
        return native.url;
      },
      get protocol() {
        return native.protocol;
      },
      get extensions() {
        return native.extensions;
      },
      get bufferedAmount() {
        return native.bufferedAmount;
      },
      send(data) {
        try {
          const frame = JSON.parse(String(data));
          if (frame.type === "req" && frame.method === "chat.send") {
            state.chatSends.push({
              id: frame.id,
              params: frame.params ?? {},
              at: Date.now(),
            });
            if (state.deferNextChatSend) {
              state.deferNextChatSend = false;
              state.deferredResponseId = frame.id;
            }
          }
        } catch {
          // ignore parse errors
        }
        native.send(data);
      },
      close(code, reason) {
        native.close(code, reason);
      },
      addEventListener(type, listener) {
        listeners[type]?.push(listener);
      },
      removeEventListener(type, listener) {
        const bucket = listeners[type];
        if (!bucket) {
          return;
        }
        const index = bucket.indexOf(listener);
        if (index >= 0) {
          bucket.splice(index, 1);
        }
      },
      dispatchEvent(event) {
        return native.dispatchEvent(event);
      },
    };
    return proxy;
  }
  ProofWebSocket.CONNECTING = Native.CONNECTING;
  ProofWebSocket.OPEN = Native.OPEN;
  ProofWebSocket.CLOSING = Native.CLOSING;
  ProofWebSocket.CLOSED = Native.CLOSED;
  window.WebSocket = ProofWebSocket;
})();
`;

async function waitForProofSnapshot(page, predicate, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await page.evaluate(() => window.__openclawWsProof.snapshot());
    if (predicate(snapshot)) {
      return snapshot;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for websocket proof condition after ${timeoutMs}ms`);
}

async function main() {
  const indexPath = path.join(repoRoot, "dist", "control-ui", "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error("missing dist/control-ui/index.html; run pnpm ui:build first");
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-reconnect-proof-"));
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");

  const port = await getFreePort();
  const chatUrl = `http://127.0.0.1:${port}/chat`;
  const screenshotPath = path.join(tmpRoot, "live-webchat-reconnect-send.png");

  const gateway = spawn(
    "pnpm",
    [
      "openclaw",
      "gateway",
      "run",
      "--dev",
      "--allow-unconfigured",
      "--auth",
      "none",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--force",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let browser;
  try {
    await waitForGatewayReady(gateway);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(WS_SHIM);
    await page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(
      () =>
        typeof window.__openclawWsProof?.snapshot === "function" &&
        window.__openclawWsProof.snapshot().socketCount >= 1,
      undefined,
      { timeout: 60_000 },
    );

    const prompt = "live reconnect send queue proof";
    await page.evaluate(() => window.__openclawWsProof.deferNextChatSend());
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();

    const afterFirstSend = await waitForProofSnapshot(
      page,
      (snapshot) => snapshot.chatSends.length >= 1 && snapshot.deferredResponseId != null,
    );

    await page.evaluate(() => window.__openclawWsProof.closeActive(4001, "live proof ack loss"));

    const afterReplay = await waitForProofSnapshot(
      page,
      (snapshot) => snapshot.chatSends.length >= 2,
      90_000,
    );

    await page
      .locator(".chat-queue")
      .waitFor({ state: "detached", timeout: 60_000 })
      .catch(async () => {
        const queueCount = await page.locator(".chat-queue .chat-queue__item").count();
        if (queueCount !== 0) {
          throw new Error(`expected empty chat queue, found ${queueCount} items`);
        }
      });

    const userBubbleCount = await page
      .locator(".chat-group.user .chat-text")
      .filter({ hasText: prompt })
      .count();
    if (userBubbleCount !== 1) {
      throw new Error(`expected exactly one user bubble for prompt, found ${userBubbleCount}`);
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
    await context.close();

    const firstKey = afterReplay.chatSends[0]?.idempotencyKey;
    const secondKey = afterReplay.chatSends[1]?.idempotencyKey;
    if (!firstKey || firstKey !== secondKey) {
      throw new Error(
        `expected replay to reuse idempotency key, got first=${String(firstKey)} second=${String(secondKey)}`,
      );
    }

    log("REAL_WEBCHAT_RECONNECT_PROOF");
    log(`url=${chatUrl}`);
    log(`prompt=${prompt}`);
    log(`first.idempotencyKey=${firstKey}`);
    log(`replay.idempotencyKey=${secondKey}`);
    log(`chat.send.count=${afterReplay.chatSends.length}`);
    log(`deferredResponseId=${afterFirstSend.deferredResponseId}`);
    log(`socketCount=${afterReplay.socketCount}`);
    log(`userBubbleCount=${userBubbleCount}`);
    log(`queueCleared=true`);
    log(`screenshot=${screenshotPath}`);
    log(`stateDir=${stateDir}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await stopGateway(gateway);
  }
}

await main();
