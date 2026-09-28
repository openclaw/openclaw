// A queued approval card must recheck its reviewer when the policy commits.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { createSlackWebClient } from "./client.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const TEAM = "T11111111";
const REVIEWER = "U111OWNER";
const OTHER = "U222OWNER";
const BOT_TOKEN = "xoxb-approval-authority";

function approvalConfig(reviewer: string): OpenClawConfig {
  return {
    approvals: { plugin: { slack: { approvers: [`team:${TEAM}:user:${reviewer}`] } } },
    channels: {
      slack: {
        mode: "http",
        signingSecret: "test-signing-secret",
        botToken: BOT_TOKEN,
      },
    },
  };
}

function respond(response: ServerResponse, payload: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage, onEnd: () => void): void {
  request.resume();
  request.on("end", onEnd);
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("Slack plugin approval delivery authority", () => {
  it("stops revoked pending sends and retires already delivered cards", async () => {
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("NO_PROXY", "*");
    const firstPostStarted = createDeferred<void>();
    let posts = 0;
    let updates = 0;
    const registration = registerSlackInstallationState("default", "enterprise");
    try {
      await withServer(
        (request, response) => {
          readBody(request, () => {
            if (request.url === "/api/conversations.open") {
              respond(response, { ok: true, channel: { id: "D11111111" } });
              return;
            }
            if (request.url === "/api/chat.postMessage") {
              posts += 1;
              if (posts === 1) {
                response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
                response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
                firstPostStarted.resolve();
                return;
              }
              respond(response, { ok: true, ts: "1712345678.999999", channel: "D11111111" });
              return;
            }
            if (request.url === "/api/chat.update") {
              updates += 1;
            }
            respond(response, { ok: true });
          });
        },
        async (baseUrl) => {
          const cfg = approvalConfig(REVIEWER);
          setRuntimeConfigSnapshot(cfg);
          const client = createSlackWebClient(BOT_TOKEN, { slackApiUrl: `${baseUrl}/api/` });
          const request = {
            approvalKind: "plugin" as const,
            id: "plugin:authority-test",
            request: {
              title: "Sensitive action",
              description: "Needs approval",
              turnSourceChannel: "slack",
              turnSourceTo: `team:${TEAM}:channel:D33333333`,
              turnSourceAccountId: "default",
            },
            createdAtMs: 0,
            expiresAtMs: 60_000,
          };
          const context = {
            app: { client, webClientOptions: { slackApiUrl: `${baseUrl}/api/` } },
            config: {},
            enterprise: { enterpriseId: "E11111111" },
            resolveClient: () => client,
            readConfig: createRuntimeConfigReader(cfg),
            assertCurrent: () => {},
          };
          const delivery = Promise.resolve(
            slackApprovalNativeRuntime.transport.deliverPending({
              cfg,
              accountId: "default",
              context,
              request,
              approvalKind: "plugin",
              plannedTarget: {
                surface: "approver-dm",
                reason: "preferred",
                target: { to: `team:${TEAM}:user:${REVIEWER}` },
              },
              preparedTarget: { to: `user:${REVIEWER}`, teamId: TEAM },
              pendingPayload: {
                text: "approve",
                blocks: [{ type: "section", text: { type: "mrkdwn", text: "approve" } }],
              },
            } as never),
          );
          const first = await Promise.race([
            firstPostStarted.promise.then(() => "first-post" as const),
            delivery.then(() => "delivered" as const),
          ]);
          expect(first).toBe("first-post");
          setRuntimeConfigSnapshot(approvalConfig(OTHER));
          await expect(delivery).rejects.toThrow("Slack approval delivery is no longer authorized");
          expect(posts).toBe(1);

          setRuntimeConfigSnapshot(cfg);
          const settledRequest = { ...request, id: "plugin:authority-terminal" };
          const entry = await Promise.resolve(
            slackApprovalNativeRuntime.transport.deliverPending({
              cfg,
              accountId: "default",
              context,
              request: settledRequest,
              approvalKind: "plugin",
              plannedTarget: {
                surface: "approver-dm",
                reason: "preferred",
                target: { to: `team:${TEAM}:user:${REVIEWER}` },
              },
              preparedTarget: { to: `user:${REVIEWER}`, teamId: TEAM },
              pendingPayload: {
                text: "approve",
                blocks: [{ type: "section", text: { type: "mrkdwn", text: "approve" } }],
              },
            } as never),
          );
          if (!entry) {
            throw new Error("Expected a delivered reviewer card");
          }
          expect(posts).toBe(2);
          setRuntimeConfigSnapshot(approvalConfig(OTHER));
          await slackApprovalNativeRuntime.transport.updateEntry?.({
            cfg,
            accountId: "default",
            context,
            request: settledRequest,
            approvalKind: "plugin",
            entry,
            payload: {
              text: "Approval denied",
              blocks: [{ type: "section", text: { type: "mrkdwn", text: "Approval denied" } }],
            },
            phase: "resolved",
          } as never);
          expect(updates).toBe(1);
        },
      );
    } finally {
      registration.release();
    }
  });
});
