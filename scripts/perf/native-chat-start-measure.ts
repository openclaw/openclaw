// Attach to an explicitly prepared synthetic native Gateway; never starts or reconfigures it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GatewayClient } from "../../packages/gateway-client/src/client.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../../src/infra/device-identity-material.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { extractTextFromChatContent } from "../../src/shared/chat-content.ts";
import { createDeferredCore, type Deferred } from "../../src/shared/deferred.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { observeTurnStartReceipt } from "./turn-start-report.ts";

const syntheticToken = "synthetic-native-chat-measure";
const model = "openai/gpt-4.1";

/** Generate only a synthetic input artifact; the runtime owner chooses its guest workspace. */
export function createNativeChatStartConfig(gatewayPort: number, mockPort: number): OpenClawConfig {
  for (const port of [gatewayPort, mockPort]) {
    assert(Number.isSafeInteger(port) && port >= 30000 && port <= 65534);
  }
  assert.notEqual(gatewayPort, mockPort);
  const config: OpenClawConfig = {
    browser: { enabled: false },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: "off" } },
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token", token: syntheticToken },
      tailscale: { mode: "off" },
    },
  };
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: model });
  return config;
}

export async function measureNativeChatStart(options: {
  url: string;
  mockUrl: string;
  samples: number;
  timeoutMs: number;
  stopTarget?: { pid: number; ownerId: string; port: number };
}) {
  const url = new URL(options.url);
  const mockUrl = new URL(options.mockUrl);
  for (const target of [url, mockUrl]) {
    assert.equal(target.hostname, "127.0.0.1", "Use an explicitly prepared loopback fixture");
    assert(!target.username && !target.password && !target.search && !target.hash);
    assert(Number(target.port) >= 30000 && Number(target.port) <= 65534);
  }
  assert.equal(url.protocol, "ws:");
  assert.equal(url.pathname, "/");
  assert.equal(mockUrl.protocol, "http:");
  assert.equal(mockUrl.pathname, "/v1");
  assert(Number.isSafeInteger(options.samples) && options.samples > 0 && options.samples <= 20);
  assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0);
  if (options.stopTarget) {
    assert(Number.isSafeInteger(options.stopTarget.pid) && options.stopTarget.pid > 0);
    assert(typeof options.stopTarget.ownerId === "string" && options.stopTarget.ownerId.length > 0);
    assert.equal(
      options.stopTarget.port,
      Number(url.port),
      "Stop target must match this fixture port",
    );
  }

  const startedAt = performance.now();
  const controller = new AbortController();
  const mockState = async () => {
    const response = await fetch(new URL("/health", mockUrl), {
      signal: controller.signal,
    });
    assert(response.ok, "Mock provider health request failed");
    const value: unknown = await response.json();
    assert(isRecord(value) && isRecord(value.requests) && isRecord(value.requests.ingress));
    assert(typeof value.requests.id === "string");
    assert(
      isRecord(value.requests.accounting) && value.requests.accounting.version === 1,
      "Enable content-free MOCK_NATIVE_CHAT_ACCOUNTING=1 before starting the mock",
    );
    const count = value.requests.ingress.responses;
    assert(typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
    const embeddings = value.requests.ingress.embeddings;
    assert(typeof embeddings === "number" && Number.isSafeInteger(embeddings) && embeddings >= 0);
    return { id: value.requests.id, responses: count, embeddings };
  };
  const ready = createDeferredCore();
  const samples: Array<{
    sample: number;
    runId: string;
    acknowledgedMs: number;
    firstAssistantDeltaMs: number;
    completedMs: number;
    mockRequests: number;
    mockBefore: Awaited<ReturnType<typeof mockState>>;
    mockAfter: Awaited<ReturnType<typeof mockState>>;
  }> = [];
  let active:
    | {
        sessionKey: string;
        runId: string;
        startedAt: number;
        firstAssistantDeltaMs?: number;
        firstToolStartMs?: number;
        completedMs?: number;
        finalText?: string | null;
        done: Deferred;
      }
    | undefined;
  const client = new GatewayClient({
    url: url.href,
    token: syntheticToken,
    clientName: "gateway-client",
    clientDisplayName: "synthetic-native-chat-measure",
    clientVersion: "1.0.0",
    mode: "ui",
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: ["chat-only-assistant-text", "tool-events"],
    requestTimeoutMs: options.timeoutMs,
    deviceIdentity: generateStoredDeviceIdentity(),
    hostDeps: {
      signDevicePayload: signEd25519Payload,
      publicKeyRawBase64UrlFromPem: publicKeyRawBase64UrlFromEd25519Pem,
    },
    onHelloOk: () => ready.resolve(),
    onConnectError: ready.reject,
    onClose: () => {
      const error = new Error("Synthetic Gateway connection closed");
      ready.reject(error);
      active?.done.reject(error);
    },
    onEvent: (event) => {
      if (!active) {
        return;
      }
      const payload = event.payload;
      if (
        !isRecord(payload) ||
        payload.sessionKey !== active.sessionKey ||
        payload.runId !== active.runId
      ) {
        return;
      }
      observeTurnStartReceipt(active, event, performance.now() - active.startedAt);
      if (event.event === "chat" && payload.state === "final") {
        active.completedMs = performance.now() - active.startedAt;
        active.finalText = isRecord(payload.message)
          ? extractTextFromChatContent(payload.message.content)
          : null;
        active.done.resolve();
      } else if (
        event.event === "chat" &&
        (payload.state === "error" || payload.state === "aborted")
      ) {
        active.completedMs = performance.now() - active.startedAt;
        active.done.reject(new Error("Synthetic chat did not complete successfully"));
      }
    },
  });
  const deadline = setTimeout(() => {
    const error = new Error("Synthetic native chat measurement deadline exceeded");
    controller.abort(error);
    ready.reject(error);
    active?.done.reject(error);
  }, options.timeoutMs);
  try {
    client.start();
    await ready.promise;
    const snapshot = await client.request<{ config?: unknown }>(
      "config.get",
      {},
      {
        timeoutMs: Math.max(1, options.timeoutMs - (performance.now() - startedAt)),
      },
    );
    assert(isRecord(snapshot.config), "Expected the synthetic Gateway config snapshot");
    const config = snapshot.config;
    const providers = isRecord(config.models) ? config.models.providers : undefined;
    const agents = isRecord(config.agents) ? config.agents : undefined;
    const defaults = agents && isRecord(agents.defaults) ? agents.defaults : undefined;
    const selected = defaults && isRecord(defaults.model) ? defaults.model : undefined;
    assert(isRecord(providers) && Object.keys(providers).join(",") === "openai");
    assert(
      isRecord(providers.openai) && providers.openai.baseUrl === mockUrl.href,
      "Configure only the selected loopback mock provider before running this workload",
    );
    assert(
      isRecord(providers.openai.agentRuntime) && providers.openai.agentRuntime.id === "openclaw",
      "Pin the mock provider to the OpenClaw agent runtime",
    );
    assert(selected?.primary === model);
    const models = defaults && isRecord(defaults.models) ? defaults.models : undefined;
    const route = models && isRecord(models[model]) ? models[model] : undefined;
    assert(
      route && isRecord(route.agentRuntime) && route.agentRuntime.id === "openclaw",
      "Pin the fixture model route to the OpenClaw agent runtime",
    );
    assert(
      selected.fallbacks === undefined ||
        (Array.isArray(selected.fallbacks) && !selected.fallbacks.length),
    );
    const entries = agents?.entries;
    assert(
      entries === undefined ||
        (isRecord(entries) &&
          (Object.keys(entries).length === 0 ||
            (Object.keys(entries).length === 1 &&
              isRecord(entries.main) &&
              Object.keys(entries.main).length === 0))),
      "Use only defaults or the released empty main entry; agent overrides are not this fixture",
    );
    assert(defaults?.utilityModel === undefined, "Do not route utility work outside the fixture");
    assert(agents?.list === undefined, "Do not use a legacy agent roster in this fixture");

    const mockInitial = await mockState();
    const sessionKey = `agent:main:gateway-perf-${randomUUID()}`;
    for (let sample = 0; sample < options.samples; sample++) {
      const before = await mockState();
      const marker = `OPENCLAW_E2E_NATIVE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
      active = {
        sessionKey,
        runId: randomUUID(),
        startedAt: performance.now(),
        done: createDeferredCore(),
      };
      // Observe rejection immediately even if the terminal frame precedes the ACK.
      void active.done.promise.catch(() => {});
      const remainingMs = Math.max(
        1,
        Math.floor(options.timeoutMs - (performance.now() - startedAt)),
      );
      const accepted = await client.request<{
        runId?: string;
        status?: string;
        interruptedActiveRun?: boolean;
      }>(
        "chat.send",
        {
          sessionKey,
          message: `Synthetic Gateway startup measurement. Reply with ${marker}.`,
          idempotencyKey: active.runId,
          timeoutMs: remainingMs,
        },
        { timeoutMs: remainingMs },
      );
      const acknowledgedMs = performance.now() - active.startedAt;
      assert.equal(accepted.runId, active.runId);
      assert.equal(accepted.status, "started", "Queued/replayed input is not this workload");
      assert(
        accepted.interruptedActiveRun !== true,
        "Do not mix interrupted runs into startup samples",
      );
      await active.done.promise;
      assert(active.firstAssistantDeltaMs !== undefined, "No semantic assistant delta received");
      assert.equal(active.finalText, marker, "Final reply did not contain the mock's exact marker");
      assert(active.completedMs !== undefined);
      const after = await mockState();
      assert.equal(after.id, before.id, "Mock provider restarted during the sample");
      assert.equal(before.id, mockInitial.id, "Mock provider changed during the campaign");
      assert(after.responses > before.responses, "No matching mock-provider request was observed");
      samples.push({
        sample,
        runId: active.runId,
        acknowledgedMs,
        firstAssistantDeltaMs: active.firstAssistantDeltaMs,
        completedMs: active.completedMs,
        mockRequests: after.responses - before.responses,
        mockBefore: before,
        mockAfter: after,
      });
      active = undefined;
    }
    let shutdownRequest: { status: "scheduled"; pid: number } | undefined;
    let shutdownFailure: string | undefined;
    if (options.stopTarget) {
      try {
        const status = await client.request<{ pid?: number }>(
          "status",
          { includeChannelSummary: false },
          { timeoutMs: 5000 },
        );
        assert.equal(
          status.pid,
          options.stopTarget.pid,
          "Connected process no longer matches the task lock",
        );
        const stopped = await client.request<{ ok?: boolean; pid?: number; status?: string }>(
          "gateway.stop.request",
          { target: options.stopTarget },
          { timeoutMs: 5000 },
        );
        assert(
          stopped.ok && stopped.pid === options.stopTarget.pid && stopped.status === "scheduled",
        );
        shutdownRequest = { status: "scheduled", pid: stopped.pid };
      } catch (error) {
        shutdownFailure = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      outcome: shutdownFailure ? "shutdown-unconfirmed" : "measured",
      client: { id: "gateway-client", mode: "ui" },
      clock: "client-process performance.now; offsets from each chat.send invocation",
      workload:
        "One fresh session; later samples retain prior turns. Identity, not Companion-equivalent capabilities.",
      measurements: {
        acknowledgedMs: "client chat.send response round trip, not server ACK-ready/send",
        firstAssistantDeltaMs:
          "first matching assistant delta received after Gateway buffering/broadcast",
        completedMs: "matching final frame received, not model completion or durable settlement",
      },
      samples,
      mockInitial,
      ...(shutdownRequest ? { shutdownRequest } : {}),
      ...(shutdownFailure ? { shutdownFailure, stopTarget: options.stopTarget } : {}),
      unavailable: [
        "server ACK-to-run-start and provider dispatch without target-local capture",
        "server ACK-ready/send timestamps",
        "raw network first byte",
        "paint/presentation",
        "cold-process classification without a parent-owned restart",
        "confirmed shutdown until parent joins foreground exit and a complete capture-end",
      ],
    };
  } catch (error) {
    if (active && active.completedMs === undefined) {
      const errors = [error];
      try {
        await client.request(
          "chat.abort",
          { sessionKey: active.sessionKey, runId: active.runId },
          { timeoutMs: 5000 },
        );
      } catch (abortError) {
        errors.push(abortError);
      }
      throw new AggregateError(
        errors,
        `Measurement failed; cleanup unconfirmed for sessionKey=${active.sessionKey} runId=${active.runId}. Do not resubmit before parent reconciliation.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    await client.stopAndWait();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      "mock-url": { type: "string" },
      output: { type: "string" },
      samples: { type: "string", default: "6" },
      "timeout-ms": { type: "string", default: "120000" },
      "write-config": { type: "string" },
      "gateway-port": { type: "string" },
      "mock-port": { type: "string" },
      "stop-target": { type: "string" },
    },
  });
  if (values["write-config"]) {
    assert(!values.url && !values.output, "Config generation does not connect to a Gateway");
    const config = createNativeChatStartConfig(
      Number(values["gateway-port"]),
      Number(values["mock-port"]),
    );
    writeFileSync(values["write-config"], `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  } else {
    assert(values.url && values["mock-url"] && values.output);
    let stopTarget: { pid: number; ownerId: string; port: number } | undefined;
    if (values["stop-target"]) {
      const value: unknown = JSON.parse(readFileSync(values["stop-target"], "utf8"));
      assert(isRecord(value));
      assert(
        typeof value.pid === "number" &&
          typeof value.ownerId === "string" &&
          typeof value.port === "number",
      );
      stopTarget = { pid: value.pid, ownerId: value.ownerId, port: value.port };
    }
    const result = await measureNativeChatStart({
      url: values.url,
      mockUrl: values["mock-url"],
      samples: Number(values.samples),
      timeoutMs: Number(values["timeout-ms"]),
      ...(stopTarget ? { stopTarget } : {}),
    });
    writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    if (result.outcome === "shutdown-unconfirmed") {
      console.error(
        "Native chat samples saved, but targeted shutdown is unconfirmed. Reconcile the task target before cleanup or another run.",
      );
      process.exitCode = 1;
    }
  }
}
