// Real isolated Gateway subscriptions; fixture preparation stays outside measurement scopes.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { measureGatewayAllocations, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    child: { type: "boolean" },
    "owner-suffix": { type: "string" },
    revision: { type: "string" },
    port: { type: "string", default: "41567" },
    clients: { type: "string", default: "8" },
    keys: { type: "string", default: "50" },
    operations: { type: "string", default: "1000" },
    subscribes: { type: "string", default: "256" },
    "interval-ms": { type: "string", default: "20" },
    "start-at": { type: "string" },
  },
});
const integer = (value: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw: value, label, fallback: min, min });
const port = integer(values.port, "--port", 40000);
assert(port <= 65535);
const channel = "session-pr-subscriptions-bench";
type BenchReply = {
  notifications: number;
  scopeCount: number;
  drainMs: number;
  pendingScopes: number;
};

if (values.child) {
  const ownerLoads = new Set<string>();
  if (values["owner-suffix"]) {
    assert(/^[a-z0-9-]+$/.test(values["owner-suffix"]));
    const owners = new Set(
      ["control-ui-session-task-prs", "control-ui-session-pr-subscriptions"].map(
        (name) => new URL(`../../src/gateway/${name}.ts`, import.meta.url).href,
      ),
    );
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (!owners.has(resolved.url)) {
          return resolved;
        }
        ownerLoads.add(resolved.url);
        return { ...resolved, url: resolved.url.replace(/\.ts$/, `.${values["owner-suffix"]}.ts`) };
      },
    });
  }
  await import("../lib/gateway-bench-profile-preload.ts");
  const { sessionChanges, sessionChangeScopeAffectsStoredRows } =
    await import("../../src/sessions/session-row-changes.ts");
  const { AsyncWorkScope } = await import("../../src/shared/async-work-scope.ts");
  const scopes = new Set<InstanceType<typeof AsyncWorkScope>>();
  // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver; arm restores the method.
  const nativeTrack = AsyncWorkScope.prototype.track;
  // Capture the subscription owner during setup, excluding ingress/connection lifetime scopes.
  AsyncWorkScope.prototype.track = new Proxy(nativeTrack, {
    apply(target, scope: InstanceType<typeof AsyncWorkScope>, args) {
      const caller = new Error().stack?.split("\n")[2] ?? "";
      if (/\/control-ui-session-pr-subscriptions(?:\.[a-z0-9-]+)?\.ts:\d+:\d+\)?$/.test(caller)) {
        scopes.add(scope);
      }
      return Reflect.apply(target, scope, args);
    },
  });
  const { startGatewayServer } = await import("../../src/gateway/server.ts");
  let notifications = 0;
  let active = false;
  const stop = sessionChanges.subscribeFacts((change) => {
    if (
      active &&
      sessionChangeScopeAffectsStoredRows(change) &&
      !("facts" in change && change.facts?.kind === "unchanged")
    ) {
      notifications++;
    }
  });
  process.on("message", (message: unknown) => {
    if (!isRecord(message) || message.channel !== channel) {
      return;
    }
    void (async () => {
      let drainMs = 0;
      if (message.action === "capture") {
        scopes.clear();
      }
      if (message.action === "arm") {
        AsyncWorkScope.prototype.track = nativeTrack;
        assert.equal(
          scopes.size,
          1,
          "Subscription setup must capture exactly its native work owner",
        );
      }
      if (message.action === "arm" || message.action === "settle") {
        const started = performance.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            AsyncWorkScope.runWhenAllIdle(
              () => [...scopes],
              () => undefined,
            ),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Native subscription scope did not settle within 30s (${scopes.size} captured, ${[...scopes].filter((scope) => scope.hasPendingWork).length} pending)`,
                    ),
                  ),
                30000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        drainMs = performance.now() - started;
      }
      if (message.action === "start") {
        active = true;
        notifications = 0;
      } else if (message.action === "stop") {
        active = false;
      }
      process.send?.({
        channel,
        action: message.action,
        notifications,
        scopeCount: scopes.size,
        pendingScopes: [...scopes].filter((scope) => scope.hasPendingWork).length,
        drainMs,
      });
    })().catch((error: unknown) => {
      process.send?.({ channel, action: message.action, error: String(error) });
    });
  });
  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  if (values["owner-suffix"]) {
    assert.equal(ownerLoads.size, 2, "Both candidate owners must be loaded");
  }
  process.send?.({ channel, action: "ready" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stop();
      void server
        .close({ reason: "Synthetic subscription benchmark complete" })
        .then(() => process.exit(0));
    });
  }
} else {
  assert(values.root && values.output, "--root and --output are required");
  const root = path.resolve(values.root);
  const output = path.resolve(values.output);
  mkdirSync(output, { recursive: true });
  const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
  assert.equal(fixture.format, "openclaw-team-shape-v1");
  assert.equal(fixture.sessionCount, 5000);
  const clients = integer(values.clients, "--clients");
  const keyCount = integer(values.keys, "--keys");
  const operations = integer(values.operations, "--operations");
  const subscribes = integer(values.subscribes, "--subscribes");
  const interval = integer(values["interval-ms"], "--interval-ms");
  const env = createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
    caseEnv: {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });
  const log = createWriteStream(path.join(output, "gateway.log"));
  let gateway: ChildProcess | undefined;
  const peers: ReturnType<typeof createGatewayWsClient>[] = [];
  let failure: Error | undefined;
  let closing = false;
  const frames: Array<{ client: number; payload: unknown }> = [];
  const key = (index: number) => `agent:main:team-shape-session-${index}`;
  // Shared visible roots, each with seeded descendants; exclude the fixture's draft rows.
  const keys = Array.from({ length: keyCount }, (_, i) => key(Math.floor(i / 7) * 10 + (i % 7)));
  const subscription = { sessionKeys: keys.slice(0, 1), passiveSessionKeys: keys.slice(1) };
  function snapshotState() {
    const latest = Array.from({ length: clients }, () => new Map<string, unknown>());
    for (const frame of frames) {
      assert(isRecord(frame.payload) && isRecord(frame.payload.sessions));
      for (const [sessionKey, snapshot] of Object.entries(frame.payload.sessions)) {
        latest[frame.client]!.set(sessionKey, snapshot);
      }
    }
    return latest.map((sessions, client) => {
      for (const sessionKey of keys) {
        assert(sessions.has(sessionKey), `Client ${client} did not receive ${sessionKey}`);
      }
      return {
        client,
        sessions: [...sessions].toSorted(([left], [right]) => left.localeCompare(right)),
      };
    });
  }
  function snapshotHash(state: ReturnType<typeof snapshotState>) {
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
  }
  async function command(action: string) {
    assert(gateway);
    const child = gateway;
    return await new Promise<BenchReply>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Benchmark ${action} timed out`)), 180000);
      function finish(value: BenchReply | Error) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (value instanceof Error) {
          reject(value);
        } else {
          resolve(value);
        }
      }
      function onMessage(message: unknown) {
        if (isRecord(message) && message.channel === channel && message.action === action) {
          finish(
            message.error
              ? new Error(
                  typeof message.error === "string" ? message.error : JSON.stringify(message.error),
                )
              : {
                  notifications: Number(message.notifications ?? 0),
                  scopeCount: Number(message.scopeCount ?? 0),
                  pendingScopes: Number(message.pendingScopes ?? 0),
                  drainMs: Number(message.drainMs ?? 0),
                },
          );
        }
      }
      function onExit() {
        finish(new Error(`Gateway exited before ${action}; inspect ${output}`));
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      if (action !== "ready") {
        child.send({ channel, action });
      }
    });
  }
  async function rpc(peer: (typeof peers)[number], method: string, params: unknown) {
    if (failure) {
      throw failure;
    }
    const started = performance.now();
    const response = await peer.request(method, params, 60000);
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return { elapsedMs: performance.now() - started, payload: response.payload };
  }
  async function cleanup() {
    closing = true;
    for (const peer of peers) {
      peer.close();
    }
    if (gateway) {
      await stopChild(gateway, { teardownGraceMs: 30000, killGraceMs: 2000 });
    }
    await new Promise<void>((resolve) => {
      log.end(resolve);
    });
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130));
    });
  }
  function summarize(samples: number[]) {
    const sorted = samples.toSorted((a, b) => a - b);
    return {
      count: sorted.length,
      meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      maxMs: sorted.at(-1),
    };
  }
  function familyBytes(profilePath: string) {
    const profile: HeapProfiler.SamplingHeapProfile = JSON.parse(readFileSync(profilePath, "utf8"));
    const visit = (node: HeapProfiler.SamplingHeapProfileNode, owned = false): number => {
      const family =
        owned ||
        /control-ui-session-(?:task-prs|pr-read|pr-subscriptions|pr-prepared-read)/.test(
          node.callFrame.url,
        );
      return (
        (family ? node.selfSize : 0) +
        node.children.reduce((sum, child) => sum + visit(child, family), 0)
      );
    };
    return visit(profile.head);
  }
  try {
    gateway = spawn(
      process.execPath,
      [
        "--trace-gc-nvp",
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(import.meta.url),
        "--child",
        "--port",
        String(port),
        ...(values["owner-suffix"] ? ["--owner-suffix", values["owner-suffix"]] : []),
      ],
      {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    gateway.stdout?.pipe(log, { end: false });
    const errors = createWriteStream(path.join(output, "gateway-stderr.log"));
    gateway.stderr?.pipe(errors);
    await command("ready");
    for (let index = 0; index < clients; index++) {
      const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
      const peer = createGatewayWsClient({
        url: `ws://127.0.0.1:${port}`,
        onEvent(event) {
          if (event.event === "connect.challenge" && isRecord(event.payload)) {
            challenge.resolve({ nonce: String(event.payload.nonce), ts: Number(event.payload.ts) });
          }
          if (event.event === "controlUi.sessionPullRequests.changed") {
            frames.push({ client: index, payload: event.payload });
          }
        },
      });
      peer.ws.on("error", (error) => {
        failure ??= error;
      });
      peer.ws.on("close", () => {
        if (!closing) {
          failure ??= new Error("Unexpected subscriber disconnect");
        }
      });
      peers.push(peer);
      await peer.waitOpen();
      const { nonce, ts } = await challenge.promise;
      const pair = generateKeyPairSync("ed25519");
      const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
        pair.publicKey.export({ type: "spki", format: "pem" }),
      );
      const deviceId = createHash("sha256")
        .update(Buffer.from(publicKey, "base64url"))
        .digest("hex");
      const client = { id: "gateway-client", version: "dev", platform: "web", mode: "backend" };
      const scopes = ["operator.admin", "operator.read", "operator.write"];
      await rpc(peer, "connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes,
        caps: [],
        device: {
          id: deviceId,
          publicKey,
          nonce,
          signedAt: ts,
          signature: signEd25519Payload(
            pair.privateKey.export({ type: "pkcs8", format: "pem" }),
            buildDeviceAuthPayloadV3({
              deviceId,
              clientId: client.id,
              clientMode: client.mode,
              platform: client.platform,
              role: "operator",
              scopes,
              signedAtMs: ts,
              nonce,
            }),
          ),
        },
      });
    }
    // Long-lived connection work is not part of the subscription owner's completion barrier.
    await command("capture");
    for (const peer of peers) {
      const result = await rpc(peer, "controlUi.sessionPullRequests.subscribe", subscription);
      assert(isRecord(result.payload) && result.payload.subscribed === true);
    }
    await delay(2000);
    const setupSettlement = await command("arm");
    const initialState = snapshotState();
    const initialSnapshotHash = snapshotHash(initialState);
    const initialFrameCount = frames.length;
    writeFileSync(path.join(output, "initial-frames.json"), JSON.stringify(frames));
    for (let index = 0; index < 10; index++) {
      await rpc(peers[0]!, "sessions.patch", { key: key(4991), category: `warmup-${index % 2}` });
    }
    const warmupSettlement = await command("settle");
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at");
      assert(Date.now() < startAt, "Gateway setup missed the paired start time");
      await delay(startAt - Date.now());
    }
    const subscribeLatency: number[] = [];
    for (let index = 0; index < subscribes; index++) {
      subscribeLatency.push(
        (
          await rpc(
            peers[index % clients]!,
            "controlUi.sessionPullRequests.subscribe",
            subscription,
          )
        ).elapsedMs,
      );
    }
    const preMeasurementSettlement = await command("settle");
    if (values["start-at"]) {
      const notifyAt = integer(values["start-at"], "--start-at") + 30000;
      assert(Date.now() < notifyAt, "Subscribe phase missed the paired notification start");
      await delay(notifyAt - Date.now());
    }
    const notifyLatency: number[] = [];
    const schedulingDelay: number[] = [];
    const profilePath = path.join(output, "notify.heapprofile");
    let finalSettlement: BenchReply | undefined;
    await command("start");
    const allocation = await measureGatewayAllocations(
      gateway,
      profilePath,
      operations,
      async () => {
        const start = performance.now();
        for (let index = 0; index < operations; index++) {
          const scheduled = start + index * interval;
          await delay(Math.max(0, scheduled - performance.now()));
          schedulingDelay.push(Math.max(0, performance.now() - scheduled));
          notifyLatency.push(
            (
              await rpc(peers[0]!, "sessions.patch", {
                key: key(4991),
                category: `measure-${index % 2}`,
              })
            ).elapsedMs,
          );
        }
        finalSettlement = await command("settle");
      },
    );
    const { notifications } = await command("stop");
    assert(notifications >= operations, "The stored-row notification path was not exercised");
    await delay(100);
    const promotion = readGatewayGcTrace(path.join(output, "gateway.log"), profilePath);
    const family = familyBytes(profilePath);
    // A response on each transport also consumes all earlier frames sent after settlement.
    for (const peer of peers) {
      await rpc(peer, "sessions.describe", { key: keys[0] });
    }
    const finalState = snapshotState();
    const finalSnapshotHash = snapshotHash(finalState);
    assert.equal(
      finalSnapshotHash,
      initialSnapshotHash,
      "Unrelated category writes changed PR snapshots",
    );
    writeFileSync(path.join(output, "frames.json"), JSON.stringify(frames));
    writeFileSync(
      path.join(output, "snapshots.json"),
      JSON.stringify({ initialState, finalState }),
    );
    const result = {
      format: "session-pr-subscriptions-v1",
      setupSettlement,
      warmupSettlement,
      preMeasurementSettlement,
      finalSettlement,
      revision: values.revision ?? null,
      testedOwners: Object.fromEntries(
        ["control-ui-session-task-prs", "control-ui-session-pr-subscriptions"].map((name) => {
          const suffix = values["owner-suffix"] ? `.${values["owner-suffix"]}` : "";
          const owner = new URL(`../../src/gateway/${name}${suffix}.ts`, import.meta.url);
          return [name, createHash("sha256").update(readFileSync(owner)).digest("hex")];
        }),
      ),
      fixture: {
        sessions: fixture.sessionCount,
        runs: fixture.retainedRuns,
        agentDatabaseBytes: fixture.agentDatabaseBytes,
      },
      clients,
      keysPerClient: keyCount,
      operations,
      intervalMs: interval,
      notifications,
      subscribeLatency: summarize(subscribeLatency),
      notifyRpcLatency: summarize(notifyLatency),
      schedulingDelay: summarize(schedulingDelay),
      initialSnapshotHash,
      finalSnapshotHash,
      snapshotsBeforeMeasurement: initialFrameCount,
      snapshotsAfterMeasurement: frames.length,
      allocation,
      promotion,
      familyAllocatedBytes: family,
      familyShare: family / allocation.sampledAllocatedBytes,
      allocatedBytesPerNotification: allocation.sampledAllocatedBytes / notifications,
      allocatedBytesPerNotificationPerTab:
        allocation.sampledAllocatedBytes / notifications / clients,
      familyBytesPerNotificationPerTab: family / notifications / clients,
    };
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally {
    await cleanup();
  }
}
