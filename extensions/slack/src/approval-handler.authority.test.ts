// Slack approval delivery exercises the real send queue and Web API transport.
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

const BOT_TOKEN = "xoxb-approval-authority";
const REVIEWER = "U111OWNER";
const OTHER = "U222OWNER";
const TEAM = "T11111111";
const EXCERPT = "Private requester message for an approval.";
const proxyEnvKeys = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

function approvalConfig(approver: string, policy: "legacy" | "selected"): OpenClawConfig {
  return {
    ...(policy === "selected"
      ? { approvals: { plugin: { slack: { approvers: [approver] } } } }
      : {}),
    channels: {
      slack: {
        mode: "http",
        signingSecret: "test-signing-secret",
        botToken: BOT_TOKEN,
        allowFrom: [policy === "selected" ? OTHER : approver],
        execApprovals: { enabled: true, target: "dm" },
      },
    },
  };
}

function sendResponse(response: ServerResponse, payload: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage, onEnd: (body: string) => void): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => onEnd(body));
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("Slack approval reviewer delivery authority", () => {
  it.each([
    {
      policy: "legacy",
      installation: "enterprise",
      change: "removed",
      nextApprover: OTHER,
      shouldPost: false,
    },
    {
      policy: "legacy",
      installation: "enterprise",
      change: "retained",
      nextApprover: REVIEWER,
      shouldPost: true,
    },
    {
      policy: "legacy",
      installation: "workspace",
      change: "removed",
      nextApprover: OTHER,
      shouldPost: false,
    },
    {
      policy: "legacy",
      installation: "workspace",
      change: "retained",
      nextApprover: REVIEWER,
      shouldPost: true,
    },
    {
      policy: "selected",
      installation: "workspace",
      change: "removed",
      nextApprover: OTHER,
      shouldPost: false,
    },
    {
      policy: "selected",
      installation: "workspace",
      change: "retained",
      nextApprover: REVIEWER,
      shouldPost: true,
    },
  ] as const)(
    "checks the $change $policy reviewer on $installation delivery",
    async ({ policy, installation, nextApprover, shouldPost }) => {
      const qualified = installation === "enterprise" || policy === "selected";
      for (const key of proxyEnvKeys) {
        vi.stubEnv(key, undefined);
      }
      vi.stubEnv("NO_PROXY", "*");
      const lookupStarted = createDeferred<void>();
      const releaseLookup = createDeferred<void>();
      const posts: Record<string, string>[] = [];
      const updates: Record<string, string>[] = [];
      const registration = registerSlackInstallationState(
        "default",
        installation,
        qualified ? TEAM : undefined,
      );
      try {
        await withServer(
          (request, response) => {
            readBody(request, (body) => {
              if (request.url === "/api/conversations.open") {
                lookupStarted.resolve();
                void releaseLookup.promise.then(() =>
                  sendResponse(response, { ok: true, channel: { id: "D11111111" } }),
                );
                return;
              }
              if (request.url === "/api/chat.postMessage") {
                posts.push(Object.fromEntries(new URLSearchParams(body)));
                sendResponse(response, { ok: true, ts: "1712345678.999999", channel: "D11111111" });
                return;
              }
              if (request.url === "/api/chat.update") {
                updates.push(Object.fromEntries(new URLSearchParams(body)));
                sendResponse(response, { ok: true, ts: "1712345678.999999", channel: "D11111111" });
                return;
              }
              sendResponse(response, { ok: true });
            });
          },
          async (baseUrl) => {
            const cfg = approvalConfig(REVIEWER, policy);
            setRuntimeConfigSnapshot(cfg);
            const client = createSlackWebClient(BOT_TOKEN, { slackApiUrl: `${baseUrl}/api/` });
            const approvalSource = {
              channel: "slack",
              senderId: "U333REQUESTER",
              workspaceId: TEAM,
              conversationKind: "direct" as const,
              userMessageExcerpt: EXCERPT,
            };
            const request = {
              id: "plugin:authority-test",
              request: {
                title: "Render a diff",
                description: "Render an example diff",
                turnSourceChannel: "slack",
                turnSourceTo: qualified ? `team:${TEAM}:channel:D33333333` : "channel:D33333333",
                turnSourceAccountId: "default",
                approvalSource,
              },
              createdAtMs: 0,
              expiresAtMs: 60_000,
            };
            const view = {
              approvalKind: "plugin" as const,
              phase: "pending" as const,
              approvalId: request.id,
              title: "Render a diff",
              description: "Render an example diff",
              severity: "warning" as const,
              pluginId: "diffs",
              toolName: "view",
              metadata: [],
              actions: [],
              expiresAtMs: request.expiresAtMs,
              approvalSource,
            };
            const context = {
              app: { client, webClientOptions: { slackApiUrl: `${baseUrl}/api/` } },
              config: {},
              resolveClient: () => client,
              ...(installation === "enterprise"
                ? { enterprise: { enterpriseId: "E11111111" } }
                : qualified
                  ? { workspaceTeamId: TEAM }
                  : {}),
              readConfig: createRuntimeConfigReader(cfg),
              assertCurrent: () => {},
            };
            const pendingPayload =
              await slackApprovalNativeRuntime.presentation.buildPendingPayload({
                cfg,
                accountId: "default",
                context,
                request,
                approvalKind: "plugin",
                nowMs: 0,
                view,
              });
            const delivery = slackApprovalNativeRuntime.transport.deliverPending({
              cfg,
              accountId: "default",
              context,
              request,
              approvalKind: "plugin",
              plannedTarget: {
                surface: "approver-dm",
                reason: "preferred",
                target: {
                  to: qualified ? `team:${TEAM}:user:${REVIEWER}` : `user:${REVIEWER}`,
                },
              },
              preparedTarget: {
                to: `user:${REVIEWER}`,
                ...(qualified ? { teamId: TEAM } : {}),
              },
              pendingPayload,
              view,
            });
            if (qualified) {
              try {
                await lookupStarted.promise;
                setRuntimeConfigSnapshot(approvalConfig(nextApprover, policy));
              } finally {
                releaseLookup.resolve();
              }
            } else {
              // The workspace path yields at resolveApprovalChannel before dispatch.
              setRuntimeConfigSnapshot(approvalConfig(nextApprover, policy));
            }
            if (shouldPost) {
              const entry = await delivery;
              expect(entry).toMatchObject({ channelId: "D11111111" });
              expect(posts).toMatchObject([
                {
                  channel: qualified ? "D11111111" : REVIEWER,
                  text: expect.stringContaining(EXCERPT),
                },
              ]);
              if (!entry) {
                throw new Error("Expected delivered Slack approval entry");
              }
              const resolved = { id: request.id, decision: "deny" as const, ts: 1 };
              const finalAction = await slackApprovalNativeRuntime.presentation.buildResolvedResult(
                {
                  cfg,
                  accountId: "default",
                  context,
                  request,
                  resolved,
                  view: { ...view, phase: "resolved", decision: "deny", resolvedBy: OTHER },
                  entry,
                },
              );
              if (finalAction.kind !== "update") {
                throw new Error("Expected a Slack approval card update");
              }
              const update = () =>
                slackApprovalNativeRuntime.transport.updateEntry?.({
                  cfg,
                  accountId: "default",
                  context,
                  request,
                  approvalKind: "plugin",
                  entry,
                  payload: finalAction.payload,
                  phase: "resolved",
                });
              await update();
              expect(updates).toMatchObject([
                {
                  channel: "D11111111",
                  ts: "1712345678.999999",
                  text: expect.stringContaining(EXCERPT),
                },
              ]);
              setRuntimeConfigSnapshot(approvalConfig(OTHER, policy));
              await expect(update()).rejects.toThrow(
                "Slack approval delivery is no longer authorized",
              );
              expect(updates).toHaveLength(1);
            } else {
              await expect(delivery).rejects.toThrow(
                "Slack approval delivery is no longer authorized",
              );
              expect(posts).toEqual([]);
            }
          },
        );
      } finally {
        registration.release();
      }
    },
  );
});
