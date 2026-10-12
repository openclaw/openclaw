#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
/**
 * Standalone shipped-Gateway proof for UTF-16-safe standing-grant previews.
 *
 * Spawns a real `openclaw gateway` child (createOpenClawTestInstance), holds an
 * isolated cron agent turn open so process-local cron run ownership is live,
 * then drives exec.approval.request / resolve / grants.list over real WS.
 *
 * Not Vitest; does not import gateway test-helpers.mocks.
 */
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATEWAY_CLIENT_CAPS } from "../packages/gateway-protocol/src/client-info.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { writeOpenAiResponsesText } from "../test/helpers/openai-responses-sse.ts";
import { createOpenClawTestInstance } from "../test/helpers/openclaw-test-instance.ts";

const LOBSTER = "🦞";
const PROVIDER = "utf16-proof";
const MODEL = "held";
const MODEL_REF = `${PROVIDER}/${MODEL}`;
const TEST_API_KEY = "test-token-placeholder";

type ApprovalRequestedPayload = {
  id?: string;
  request?: {
    scope?: { kind?: string; automation?: string; command?: string } | null;
    command?: string;
  };
};

type GrantsListPayload = {
  grants?: Array<{
    command?: string;
    cwd?: string | null;
    cronJobId?: string;
  }>;
};

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(
  label: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main(): Promise<void> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-utf16-standalone-"));
  const workspace = path.join(fixtureDir, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "UTF-16 standalone proof workspace\n");

  let heldResponse: ServerResponse | undefined;
  let modelRequests = 0;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          for await (const chunk of request) {
            void chunk; // drain
          }
          modelRequests += 1;
          // Hold the first cron agent turn open so registerCronRunExecSource stays live.
          if (!heldResponse) {
            heldResponse = response;
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
            response.flushHeaders();
            return;
          }
          writeOpenAiResponsesText(response, {
            text: "utf16-proof-done",
            messageId: "msg-utf16-proof",
            responseId: "resp-utf16-proof",
          });
        })().catch((error: unknown) => {
          console.error("[utf16-standalone] model server error", error);
          response.destroy();
        });
      }),
  });
  const modelPort = reserved.claim.port;
  const modelBaseUrl = `http://127.0.0.1:${modelPort}`;

  const jobName = `${"n".repeat(127)}${LOBSTER}`;
  const cardCommand = `${"a".repeat(255)}${LOBSTER}`;
  const listCommand = `${"c".repeat(511)}${LOBSTER}`;
  const listCwd = `${"b".repeat(511)}${LOBSTER}`;
  const cardApprovalId = `approval-utf16-card-${randomUUID()}`;
  const listApprovalId = `approval-utf16-list-${randomUUID()}`;

  const instance = await createOpenClawTestInstance({
    name: "utf16-standalone-grants",
    config: {
      update: { checkOnStart: false },
      cron: { enabled: true },
      gateway: { controlUi: { enabled: false } },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace,
          model: { primary: MODEL_REF },
          modelPolicy: { allow: [`${PROVIDER}/*`] },
          skills: [],
        },
        entries: { main: { identity: { name: "UTF-16 proof agent" } } },
      },
      tools: {
        profile: "minimal",
        codeMode: false,
        toolSearch: false,
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          [PROVIDER]: {
            api: "openai-responses",
            apiKey: TEST_API_KEY,
            baseUrl: `${modelBaseUrl}/v1`,
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: MODEL,
                name: MODEL,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
      plugins: { allow: [], slots: { memory: "none" } },
    },
    env: {
      OPENCLAW_SKIP_CRON: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      VITEST: undefined,
    },
  });

  const pendingCards = new Map<string, ApprovalRequestedPayload>();
  const cardWaiters = new Map<string, (payload: ApprovalRequestedPayload) => void>();
  // Isolated cron agent turns mint their own UUID runId (not cron.run's manual:* id).
  // Capture it from agent lifecycle events while the held model request keeps the source live.
  const seenAgentRunIds = new Set<string>();
  let agentRunId: string | undefined;
  let agentRunIdWaiter: ((runId: string) => void) | undefined;

  const onEvent = (evt: { event?: string; payload?: unknown }) => {
    if (evt.event === "agent") {
      const payload = evt.payload as { runId?: unknown; stream?: unknown };
      if (typeof payload.runId === "string" && payload.runId.trim()) {
        const runId = payload.runId.trim();
        seenAgentRunIds.add(runId);
        if (!agentRunId) {
          agentRunId = runId;
          agentRunIdWaiter?.(runId);
          agentRunIdWaiter = undefined;
        }
      }
      return;
    }
    if (evt.event !== "exec.approval.requested") {
      return;
    }
    const payload = evt.payload as ApprovalRequestedPayload;
    const id = payload.id;
    if (!id) {
      return;
    }
    pendingCards.set(id, payload);
    const waiter = cardWaiters.get(id);
    if (waiter) {
      cardWaiters.delete(id);
      waiter(payload);
    }
  };

  const waitForAgentRunId = (timeoutMs = 60_000): Promise<string> => {
    if (agentRunId) {
      return Promise.resolve(agentRunId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agentRunIdWaiter = undefined;
        reject(
          new Error(
            `timeout waiting for agent runId; seen=${JSON.stringify([...seenAgentRunIds])}`,
          ),
        );
      }, timeoutMs);
      agentRunIdWaiter = (runId) => {
        clearTimeout(timer);
        resolve(runId);
      };
    });
  };

  const waitForCard = (id: string, timeoutMs = 30_000): Promise<ApprovalRequestedPayload> => {
    const existing = pendingCards.get(id);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cardWaiters.delete(id);
        reject(new Error(`timeout waiting for exec.approval.requested ${id}`));
      }, timeoutMs);
      cardWaiters.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  };

  let observer: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let admin: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

  try {
    await instance.startGateway();
    assert(instance.child?.pid, "expected real gateway child process");
    console.log(
      `[utf16-standalone] gateway child pid=${instance.child.pid} port=${instance.port} entry=openclaw-gateway-cli`,
    );

    observer = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientDisplayName: "utf16-approval-observer",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      onEvent,
      timeoutMs: 60_000,
    });
    admin = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientDisplayName: "utf16-admin",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent,
      timeoutMs: 60_000,
    });

    const job = await admin.request<{ id: string; name: string }>("cron.add", {
      name: jobName,
      agentId: "main",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      delivery: { mode: "none" },
      payload: {
        kind: "agentTurn",
        message: "Hold for UTF-16 standing-grant proof.",
        model: MODEL_REF,
      },
    });
    assert(job.id, "cron.add returned no id");
    // Receive agent lifecycle frames for the isolated cron session.
    await admin.request("sessions.subscribe", { agentId: "main" });

    const run = await admin.request<{ runId?: string; ok?: boolean }>("cron.run", {
      id: job.id,
      mode: "force",
    });
    assert(run.runId, `cron.run returned no runId: ${JSON.stringify(run)}`);
    console.log(`[utf16-standalone] cron.run jobId=${job.id} manualRunId=${run.runId}`);

    await waitFor("held cron model request", () => modelRequests >= 1 && Boolean(heldResponse));
    const runId = await waitForAgentRunId();
    console.log(`[utf16-standalone] agent runId=${runId} (cron exec-source key)`);

    const cardAccepted = await admin.request<{
      id: string;
      status: string;
      deliveryRoute?: string;
    }>("exec.approval.request", {
      id: cardApprovalId,
      command: cardCommand,
      host: "gateway",
      agentId: "main",
      runId,
      twoPhase: true,
      timeoutMs: 120_000,
    });
    assert(
      cardAccepted.status === "accepted",
      `card request not accepted: ${JSON.stringify(cardAccepted)}`,
    );
    assert(
      cardAccepted.deliveryRoute === "approval-client",
      `expected approval-client delivery, got ${cardAccepted.deliveryRoute}`,
    );

    const cardEvent = await waitForCard(cardApprovalId);
    const scope = cardEvent.request?.scope;
    assert(
      scope?.kind === "standing-grant",
      `expected standing-grant scope, got ${JSON.stringify(scope)}`,
    );
    const automation = scope.automation ?? "";
    const scopedCommand = scope.command ?? "";
    assert(!hasUnpairedSurrogate(automation), "automation has unpaired surrogate");
    assert(!hasUnpairedSurrogate(scopedCommand), "scoped command has unpaired surrogate");
    assert(
      automation === "n".repeat(127),
      `automation len/content mismatch: len=${automation.length}`,
    );
    assert(
      scopedCommand === "a".repeat(255),
      `command len/content mismatch: len=${scopedCommand.length}`,
    );
    assert(!automation.includes(LOBSTER), "automation still contains boundary emoji");
    assert(!scopedCommand.includes(LOBSTER), "command still contains boundary emoji");
    console.log(
      `[standalone-gateway exec.approval.requested standing-grant card utf16 proof] pid=${instance.child.pid} deliveryRoute=approval-client automation_len=${automation.length} command_len=${scopedCommand.length} unpaired=false boundaries=128,256`,
    );

    await observer.request("exec.approval.resolve", {
      id: cardApprovalId,
      decision: "deny",
    });

    const listAccepted = await admin.request<{
      id: string;
      status: string;
      deliveryRoute?: string;
    }>("exec.approval.request", {
      id: listApprovalId,
      command: listCommand,
      cwd: listCwd,
      host: "gateway",
      agentId: "main",
      runId,
      twoPhase: true,
      timeoutMs: 120_000,
    });
    assert(
      listAccepted.status === "accepted",
      `list request not accepted: ${JSON.stringify(listAccepted)}`,
    );
    await waitForCard(listApprovalId);

    const resolved = await observer.request<{ ok?: boolean }>("exec.approval.resolve", {
      id: listApprovalId,
      decision: "allow-always",
    });
    assert(resolved.ok === true, `allow-always failed: ${JSON.stringify(resolved)}`);

    const listed = await observer.request<GrantsListPayload>("exec.approval.grants.list", {});
    const grant = listed.grants?.find((entry) => entry.cronJobId === job.id);
    assert(grant, `minted grant not found for cronJobId=${job.id}: ${JSON.stringify(listed)}`);
    const listedCommand = grant.command ?? "";
    const listedCwd = grant.cwd ?? "";
    assert(!hasUnpairedSurrogate(listedCommand), "listed command has unpaired surrogate");
    assert(!hasUnpairedSurrogate(listedCwd), "listed cwd has unpaired surrogate");
    assert(
      listedCommand === "c".repeat(511),
      `listed command mismatch len=${listedCommand.length}`,
    );
    assert(listedCwd === "b".repeat(511), `listed cwd mismatch len=${listedCwd.length}`);
    assert(!listedCommand.includes(LOBSTER), "listed command still contains boundary emoji");
    assert(!listedCwd.includes(LOBSTER), "listed cwd still contains boundary emoji");
    console.log(
      `[standalone-gateway exec.approval.grants.list utf16 proof] pid=${instance.child.pid} listen=loopback transport=ws store=real-sqlite command_len=${listedCommand.length} cwd_len=${listedCwd.length} unpaired=false boundary=512`,
    );
    console.log("[utf16-standalone] PASS");
  } finally {
    try {
      if (heldResponse && !heldResponse.writableEnded) {
        writeOpenAiResponsesText(heldResponse, {
          text: "utf16-proof-release",
          messageId: "msg-utf16-release",
          responseId: "resp-utf16-release",
        });
      }
    } catch {
      // ignore release races during teardown
    }
    if (observer) {
      await disconnectGatewayClient(observer).catch(() => undefined);
    }
    if (admin) {
      await disconnectGatewayClient(admin).catch(() => undefined);
    }
    await instance.cleanup().catch((error: unknown) => {
      console.error("[utf16-standalone] gateway cleanup error", error);
    });
    await reserved.releaseListener().catch(() => undefined);
    await reserved.claim.release().catch(() => undefined);
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("[utf16-standalone] FAIL", error);
  process.exitCode = 1;
});
