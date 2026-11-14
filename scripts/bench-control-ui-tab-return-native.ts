// Native 1/5-tab transport smoke. Usage: scripts/bench-control-ui-tab-return.md.
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CDPSession, Page } from "playwright";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../src/gateway/control-ui-root-assets.js";

type WireObservation = {
  sockets: number;
  open: number;
  closed: number;
  finals: number;
  chats: number;
  readAcknowledgements: number;
  errors: string[];
  buildId?: string;
  connectionId?: string;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    output: { type: "string", default: ".artifacts/tab-return-native" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-control-ui-tab-return-native.ts [--bundle-dir dist/control-ui] [--output .artifacts/tab-return-native]",
  );
  process.exit(0);
}
const output = path.resolve(values.output);
const bundleDir = path.resolve(values["bundle-dir"]);
const html = await readFile(path.join(bundleDir, "index.html"), "utf8");
const metadataText = /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{[^<]*\});<\/script>/u.exec(
  html,
)?.[1];
const metadata: unknown = metadataText ? JSON.parse(metadataText) : null;
if (!isRecord(metadata) || typeof metadata.buildId !== "string") {
  throw new Error("The selected production bundle has no build identity");
}
const expectedBuildId = metadata.buildId;
await mkdir(output, { recursive: true });
const stateRoot = await mkdtemp(path.join(output, "synthetic-state-"));
for (const directory of [path.join(stateRoot, "home"), path.join(stateRoot, "workspace")]) {
  await mkdir(directory, { recursive: true });
}
const inherited = process.env;
process.env = Object.fromEntries(
  Object.entries(inherited).filter(([name]) =>
    [
      "PATH",
      "LANG",
      "TMPDIR",
      "SYSTEMROOT",
      "PLAYWRIGHT_BROWSERS_PATH",
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
      "XDG_CACHE_HOME",
    ].includes(name),
  ),
);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateRoot,
  OPENCLAW_HOME: path.join(stateRoot, "home"),
  OPENCLAW_CONFIG_PATH: path.join(stateRoot, "openclaw.json"),
  HOME: path.join(stateRoot, "home"),
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_NO_RESPAWN: "1",
  NODE_DISABLE_COMPILE_CACHE: "1",
  TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
});
const { getFreePort } = await import("./lib/gateway-bench-probes.ts");
const { startScrollInferenceFixture } =
  await import("../ui/src/e2e/chat-collaborator-scroll.real-gateway.test-support.ts");
const provider = await startScrollInferenceFixture();
let removeState = true;
const failures: unknown[] = [];
try {
  const gatewayPort = await getFreePort();
  const token = "synthetic-tab-return-gateway-token";
  const config = {
    browser: { enabled: false },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: "off" } },
    cron: { enabled: false },
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token", token },
      tailscale: { mode: "off" },
      controlUi: {
        enabled: true,
        root: bundleDir,
        allowedOrigins: [`http://127.0.0.1:${gatewayPort}`],
      },
    },
    agents: {
      defaults: {
        model: "tab-return-fixture/echo",
        modelPolicy: { allow: ["tab-return-fixture/*"] },
      },
      entries: {
        main: {
          workspace: path.join(stateRoot, "workspace"),
          identity: { name: "Synthetic tab return assistant" },
        },
      },
    },
    models: {
      catalogRefresh: { enabled: false },
      providers: {
        "tab-return-fixture": {
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "synthetic-unused-provider-key",
          models: [
            { id: "echo", name: "Synthetic fixture model", contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      },
    },
    plugins: { enabled: false },
    logging: { file: path.join(output, "gateway.log") },
  };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  const { ensureCanonicalGatewayOwnerProfile, setCanonicalUserProfileAvatar } =
    await import("../src/state/user-profile-writes.js");
  const owner = await ensureCanonicalGatewayOwnerProfile("Synthetic tab return viewer", {
    env: process.env,
  });
  await setCanonicalUserProfileAvatar(
    owner.id,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/CfcAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
    { env: process.env },
  );
  const seed = createHash("sha256").update("synthetic-tab-return-device").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const identity = {
    version: 1,
    deviceId: createHash("sha256").update(publicKey).digest("hex"),
    publicKey: publicKey.toString("base64url"),
    privateKey: seed.toString("base64url"),
    createdAtMs: Date.now(),
  };
  const scopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.pairing",
  ];
  const { requestDevicePairing } = await import("../src/infra/device-pairing.js");
  const { approveDevicePairing } = await import("../src/infra/device-pairing-approval.js");
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    role: "operator",
    scopes,
  });
  const approval = await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes });
  if (approval?.status !== "approved") {
    throw new Error("Synthetic device pairing failed");
  }
  const { startGatewayServer } = await import("../src/gateway/server.js");
  const { acquireGatewayTestClient } = await import("../test/helpers/gateway-client.ts");
  const { launchTalkObservationBrowser } = await import("./lib/control-ui-talk-fixture.ts");
  const { gatewayOriginScope } =
    await import("../packages/gateway-client/src/gateway-origin-scope.ts");
  const { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } =
    await import("../src/shared/control-ui-storage.ts");
  const { controlUiSessionUrl } =
    await import("../ui/src/test-helpers/control-ui-e2e-session-urls.ts");
  const gateway = await startGatewayServer(gatewayPort, {
    bind: "loopback",
    sidecarStartup: "defer",
  });
  let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
  let browser: Awaited<ReturnType<typeof launchTalkObservationBrowser>> | undefined;
  const results: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    bundleDir,
    expectedBuildId,
    contract:
      "Standalone count/CPU smoke; one sample per tab count, no A/A control and no comparative latency or performance claim. One-tab hidden delivery asserts no target sessions.patch unread=false request; rendering completion does not prove settled unread, Web Push or OS notifications.",
    startedAt: new Date().toISOString(),
    hostLoad: loadavg(),
    cases: results,
    syntheticInference: true,
    nativeTransport: true,
    serviceWorkers: "native launcher default; unmodified",
    connectionLimit:
      "A successful five-tab run proves a lower bound of five authenticated connections, not the browser's maximum.",
    notifications:
      "Only target sessions.patch unread=false requests are counted; settled unread state, Web Push and OS notification delivery are not asserted.",
  };
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  try {
    await gateway.startupSettled;
    const readyDeadline = Date.now() + 60000;
    while ((await fetch(`http://127.0.0.1:${gatewayPort}/readyz`)).status !== 200) {
      if (Date.now() > readyDeadline) {
        throw new Error("Synthetic Gateway did not become ready");
      }
      await delay(100);
    }
    client = await acquireGatewayTestClient(
      {
        url: `ws://127.0.0.1:${gatewayPort}`,
        token,
        env: process.env,
        clientName: "cli",
        mode: "cli",
        role: "operator",
        instanceId: randomUUID(),
        scopes: ["operator.admin"],
        deviceIdentity: null,
        deviceAuthScope: `ws://127.0.0.1:${gatewayPort}`,
        sharedStateMode: "read-only",
        requestTimeoutMs: 30000,
      },
      {
        timeoutMs: 30000,
        timeoutMessage: "Synthetic control client connect timeout",
        closeMessage: "Synthetic control client closed",
      },
    );
    console.log("NATIVE_SMOKE_READY");
    browser = await launchTalkObservationBrowser(output, false);
    const tokenKey =
      CONTROL_UI_TOKEN_SESSION_KEY_PREFIX + gatewayOriginScope(`ws://127.0.0.1:${gatewayPort}`);
    await browser.context.addInitScript(
      ({ identity: deviceIdentity, tokenKey: storageKey, token: gatewayToken }) => {
        localStorage.setItem("openclaw-device-identity-v1", JSON.stringify(deviceIdentity));
        sessionStorage.setItem(storageKey, gatewayToken);
      },
      { identity, tokenKey, token },
    );
    for (const tabCount of [1, 5]) {
      const sessionKey = `agent:main:tab-return-${tabCount}-${Date.now()}`;
      await client.request("sessions.create", {
        key: sessionKey,
        agentId: "main",
        label: `Synthetic ${tabCount}-tab return ${Date.now()}`,
      });
      const tabs: Array<{
        page: Page;
        wire: WireObservation;
        metrics: CDPSession;
        htmlBuildId: string | null;
      }> = [];
      for (let index = 0; index < tabCount; index++) {
        const page = await browser.context.newPage();
        const wire: WireObservation = {
          sockets: 0,
          open: 0,
          closed: 0,
          finals: 0,
          chats: 0,
          readAcknowledgements: 0,
          errors: [],
        };
        page.on("websocket", (socket) => {
          wire.sockets++;
          wire.open++;
          socket.on("close", () => {
            wire.open--;
            wire.closed++;
          });
          socket.on("framesent", ({ payload }) => {
            const frame: unknown = JSON.parse(payload.toString());
            if (
              isRecord(frame) &&
              frame.method === "sessions.patch" &&
              isRecord(frame.params) &&
              frame.params.key === sessionKey &&
              frame.params.unread === false
            ) {
              wire.readAcknowledgements++;
            }
            if (
              isRecord(frame) &&
              frame.method === "connect" &&
              isRecord(frame.params) &&
              isRecord(frame.params.client) &&
              typeof frame.params.client.buildId === "string"
            ) {
              wire.buildId = frame.params.client.buildId;
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame: unknown = JSON.parse(payload.toString());
            if (!isRecord(frame) || !isRecord(frame.payload)) {
              return;
            }
            if (
              frame.payload.type === "hello-ok" &&
              isRecord(frame.payload.server) &&
              typeof frame.payload.server.connId === "string"
            ) {
              wire.connectionId = frame.payload.server.connId;
            }
            if (frame.event === "chat") {
              wire.chats++;
              if (frame.payload.state === "final") {
                wire.finals++;
              }
            }
          });
        });
        page.on("pageerror", (error) => wire.errors.push(error.message));
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(controlUiSessionUrl(`http://127.0.0.1:${gatewayPort}`, sessionKey));
        await page.waitForFunction(
          () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
          undefined,
          { timeout: 60000 },
        );
        await page
          .getByRole("textbox", { name: "Chat composer", exact: true })
          .waitFor({ timeout: 60000 });
        const metrics = await browser.context.newCDPSession(page);
        await metrics.send("Performance.enable", { timeDomain: "threadTicks" });
        const htmlBuildId = await page.evaluate(
          (attribute) => document.documentElement.getAttribute(attribute),
          CONTROL_UI_BUILD_ID_ATTRIBUTE,
        );
        // Gateway intentionally strips the document cache stamp for custom roots.
        if (wire.buildId !== expectedBuildId) {
          throw new Error(
            `Selected bundle and native client build identities did not match: ${JSON.stringify({
              expectedBuildId,
              clientBuildId: wire.buildId,
              htmlBuildId,
            })}`,
          );
        }
        tabs.push({ page, wire, metrics, htmlBuildId });
      }
      const active = tabs[0]!;
      await active.page.bringToFront();
      await delay(300);
      const visibilityBefore = await Promise.all(
        tabs.map(({ page }) => page.evaluate(() => document.visibilityState)),
      );
      if (
        visibilityBefore.some((visible, index) => visible !== (index === 0 ? "visible" : "hidden"))
      ) {
        throw new Error(`Wrong native tab visibility: ${visibilityBefore.join(", ")}`);
      }
      const cpu = async () =>
        Promise.all(
          tabs.map(async ({ metrics }) => (await metrics.send("Performance.getMetrics")).metrics),
        );
      const beforeCpu = await cpu();
      const typingStarted = performance.now();
      const composer = active.page.getByRole("textbox", { name: "Chat composer", exact: true });
      await composer.pressSequentially("Synthetic instruction for native tab return proof.", {
        delay: 20,
      });
      const typingMs = performance.now() - typingStarted;
      const afterCpu = await cpu();
      const typingCpu = tabs.map((_, index) => {
        const delta = (name: string) => {
          const before = beforeCpu[index]!.find((metric) => metric.name === name)?.value;
          const after = afterCpu[index]!.find((metric) => metric.name === name)?.value;
          if (before === undefined || after === undefined) {
            throw new Error(`Chromium did not expose ${name}`);
          }
          return (after - before) * 1000;
        };
        return {
          index,
          visibility: visibilityBefore[index],
          taskMs: delta("TaskDuration"),
          scriptMs: delta("ScriptDuration"),
        };
      });
      const turn = provider.plan();
      await active.page.getByRole("button", { name: /^(Send|Queue) message$/ }).click();
      const prefix = "Native transport reply begins. ";
      await turn.append(prefix);
      await active.page
        .locator(".chat-bubble.streaming")
        .waitFor({ state: "visible", timeout: 60000 });
      const visibility = await browser.context.newCDPSession(active.page);
      const { windowId } = await visibility.send("Browser.getWindowForTarget");
      if (tabCount === 1) {
        await visibility.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
        await active.page.waitForFunction(() => document.visibilityState === "hidden", undefined, {
          polling: 50,
        });
      }
      const hiddenReadAcknowledgements = tabCount === 1 ? active.wire.readAcknowledgements : null;
      const chunks = Array.from({ length: 20 }, (_, index) => `Part ${index}. `);
      for (const chunk of chunks) {
        await turn.append(chunk);
        await delay(25);
      }
      const final = "The final native reply is retained in every tab.";
      await turn.append(final);
      await turn.finish();
      for (const tab of tabs) {
        const deadline = Date.now() + 30000;
        while (tab.wire.finals < 1 && Date.now() < deadline) {
          await delay(100);
        }
        if (tab.wire.finals < 1) {
          throw new Error("A native socket missed the final event");
        }
      }
      const hiddenEndpoint = await Promise.all(
        tabs.map(async ({ page, wire, htmlBuildId }) => ({
          visibility: await page.evaluate(() => document.visibilityState),
          wire: { ...wire },
          htmlBuildId,
        })),
      );
      if (
        hiddenReadAcknowledgements !== null &&
        hiddenEndpoint[0]!.wire.readAcknowledgements !== hiddenReadAcknowledgements
      ) {
        throw new Error("The hidden native tab acknowledged its session as read");
      }
      if (
        hiddenEndpoint.some(
          ({ visibility: documentVisibility }, index) =>
            documentVisibility !== (tabCount > 1 && index === 0 ? "visible" : "hidden"),
        )
      ) {
        throw new Error("Native document visibility changed during streaming");
      }
      if (
        tabs.some(
          ({ wire }) =>
            wire.open !== 1 ||
            !wire.connectionId ||
            !wire.buildId ||
            wire.finals !== 1 ||
            wire.errors.length,
        )
      ) {
        throw new Error("Native Gateway connection/final assertion failed");
      }
      if (new Set(tabs.map(({ wire }) => wire.connectionId)).size !== tabCount) {
        throw new Error("Gateway connection identities were not distinct");
      }
      if (tabCount === 1) {
        await visibility.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
      const returns = [];
      for (const { page } of tabs) {
        const started = performance.now();
        await page.bringToFront();
        await page.waitForFunction(
          (expected) =>
            document.visibilityState === "visible" &&
            document.querySelector(".chat-thread")?.textContent?.includes(expected) &&
            !document.querySelector(".chat-bubble.streaming"),
          prefix + chunks.join("") + final,
          { timeout: 30000 },
        );
        returns.push({
          driverRevealToAssertionMs: performance.now() - started,
          finalVisible: true,
          streamingRemoved: true,
        });
      }
      results.push({
        tabCount,
        sessionKey,
        typingMs,
        typingCpu,
        visibilityBefore,
        hiddenEndpoint,
        hiddenReadAcknowledgements:
          hiddenReadAcknowledgements === null
            ? null
            : {
                before: hiddenReadAcknowledgements,
                after: hiddenEndpoint[0]!.wire.readAcknowledgements,
              },
        returns,
        providerRequests: provider.requests(),
        providerFailures: [...provider.failures],
        hostLoad: loadavg(),
      });
      await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
      await visibility.detach();
      for (const { page, metrics } of tabs) {
        await metrics.detach();
        await page.close();
      }
    }
    report.finishedAt = new Date().toISOString();
  } catch (error) {
    failures.push(error);
  }
  const cleanup = await Promise.allSettled([
    browser?.close(),
    client?.stopAndWait({ timeoutMs: 1000 }),
    gateway.close({ reason: "Synthetic native tab return proof complete" }),
  ]);
  removeState = cleanup[2]?.status === "fulfilled";
  failures.push(
    ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );
  report.cleanup = cleanup.map((result) => result.status);
  report.hostLoadEnd = loadavg();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
} catch (error) {
  failures.push(error);
} finally {
  try {
    await provider.close();
  } catch (error) {
    failures.push(error);
  }
  if (removeState) {
    try {
      await rm(stateRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length === 1) {
  throw failures[0];
}
if (failures.length > 1) {
  throw new AggregateError(failures, "Native smoke work or cleanup failed");
}
console.log("NATIVE_SMOKE_COMPLETE");
