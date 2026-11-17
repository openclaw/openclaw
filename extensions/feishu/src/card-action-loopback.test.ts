// Synthetic Open API transport proof; no live tenant or model execution.
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "openclaw/plugin-sdk/command-detection";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { FEISHU_APPROVAL_REQUEST_ACTION } from "./card-ux-approval.js";
import { feishuDedupeState } from "./dedup-state.js";
import { setFeishuRuntime } from "./runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("feishu-card-loopback-"));
  processedCardActions.clear();
  resolvedCardActionChatTypes.clear();
  feishuDedupeState.reset();
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
});

it.each(["http-error", "nonzero", "missing-data", "missing-type", "visibility-only"])(
  "refuses unknown chat classification over SDK HTTP (%s)",
  async (failure) => {
    const requests: Array<{ path: string; to: unknown; type: string | null; content: unknown }> =
      [];
    let healthy = false;
    await withServer(
      (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const raw = (await buffer(req)).toString();
          const body = raw ? JSON.parse(raw) : {};
          requests.push({
            path: url.pathname,
            to: body.receive_id,
            type: url.searchParams.get("receive_id_type"),
            content: body.content,
          });
          res.setHeader("content-type", "application/json");
          if (url.pathname.includes("tenant_access_token")) {
            expect(body.app_id).toBe("cli_card_selected");
            return res.end(
              JSON.stringify({
                code: 0,
                tenant_access_token: "synthetic-card-token",
                expire: 7200,
              }),
            );
          }
          expect(req.headers.authorization).toBe("Bearer synthetic-card-token");
          if (url.pathname === "/open-apis/im/v1/chats/oc_card_dm") {
            return res.end(JSON.stringify({ code: 0, data: { chat_mode: "p2p" } }));
          }
          if (url.pathname === "/open-apis/im/v1/chats/oc_card_fixture") {
            if (!healthy && failure === "http-error") {
              res.statusCode = 503;
            }
            return res.end(
              JSON.stringify(
                healthy
                  ? { code: 0, data: { chat_mode: "group", name: "Synthetic group" } }
                  : failure === "nonzero" || failure === "http-error"
                    ? { code: 99, msg: "private-provider-detail" }
                    : failure === "missing-data"
                      ? { code: 0 }
                      : {
                          code: 0,
                          data: failure === "visibility-only" ? { chat_type: "private" } : {},
                        },
              ),
            );
          }
          expect(url.pathname).toBe("/open-apis/im/v1/messages");
          return res.end(JSON.stringify({ code: 0, data: { message_id: "om_synthetic_notice" } }));
        })().catch((error: unknown) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        });
      },
      async (origin) => {
        const cfg: ClawdbotConfig = {
          session: { store: path.join(process.env.OPENCLAW_STATE_DIR!, "sessions.json") },
          channels: {
            feishu: {
              defaultAccount: "selected",
              dmPolicy: "allowlist",
              allowFrom: ["ou_card_operator"],
              groupPolicy: "allowlist",
              groupAllowFrom: ["oc_card_fixture"],
              requireMention: true,
              resolveSenderNames: false,
              typingIndicator: false,
              accounts: {
                selected: {
                  appId: "cli_card_selected",
                  appSecret: "synthetic-card-secret",
                  domain: origin,
                },
                sibling: {
                  appId: "cli_card_sibling",
                  appSecret: "synthetic-sibling-secret",
                  domain: origin,
                },
              },
            },
          },
        };
        const runtime = createPluginRuntimeMock({ config: { current: () => cfg } });
        vi.mocked(runtime.channel.routing.resolveAgentRoute).mockReturnValue({
          agentId: "main",
          accountId: "selected",
          channel: "feishu",
          sessionKey: "agent:main:feishu:group:oc_card_fixture",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
          matchedBy: "binding.account",
        });
        runtime.channel.inbound.buildContext = buildChannelInboundEventContext;
        runtime.channel.commands.shouldComputeCommandAuthorized = shouldComputeCommandAuthorized;
        runtime.channel.commands.isControlCommandMessage = isControlCommandMessage;
        // Stop at the host turn boundary after real Feishu policy checks and context assembly.
        const run = vi
          .spyOn(runtime.channel.inbound, "run")
          .mockResolvedValue({ admission: { kind: "dispatch" }, dispatched: false });
        setFeishuRuntime(runtime);
        const env = { ...createRuntimeEnv(), log: vi.fn(), error: vi.fn() };
        const commandAction = createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.payload.button",
          q: "/help",
        });
        const event: FeishuCardActionEvent = {
          operator: { open_id: "ou_card_operator" },
          token: "unknown-click",
          context: { chat_id: "oc_card_fixture" },
          action: { tag: "button", value: { ...commandAction, chat_type: "p2p" } },
        };
        const click = () =>
          handleFeishuCardAction({
            cfg,
            event,
            accountId: "selected",
            botOpenId: "ou_card_bot",
            runtime: env,
          });
        await click();
        expect(env.error).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        const notices = () => requests.filter((r) => r.path === "/open-apis/im/v1/messages");
        expect(notices()).toEqual([
          expect.objectContaining({
            to: "oc_card_fixture",
            type: "chat_id",
            content: expect.stringContaining("action was not run"),
          }),
        ]);
        expect(JSON.stringify(notices())).not.toContain("private-provider-detail");
        expect(env.log.mock.calls.flat().join("\n")).not.toContain("private-provider-detail");
        event.token = "unknown-approval";
        event.action.value = createFeishuCardInteractionEnvelope({
          k: "meta",
          a: FEISHU_APPROVAL_REQUEST_ACTION,
          m: { command: "/new" },
          c: { u: "ou_card_operator", h: "oc_card_fixture", e: Date.now() + 60_000 },
        });
        await click();
        expect(notices()).toHaveLength(2);
        expect(notices()[1]?.content).toContain("action was not run");
        expect(run).not.toHaveBeenCalled();
        if (failure !== "nonzero") {
          return;
        }
        healthy = true;
        await click();
        expect(notices()).toHaveLength(2);
        expect(run).not.toHaveBeenCalled();
        event.token = "recovered-click";
        event.action.value = commandAction;
        await click();
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0].raw).toMatchObject({
          chatId: "oc_card_fixture",
          chatType: "group",
        });
        expect(notices()).toHaveLength(2);
        expect(env.error).not.toHaveBeenCalled();
        cfg.channels!.feishu!.groupAllowFrom = ["oc_another_group"];
        event.token = "disallowed-group-click";
        await click();
        expect(run).toHaveBeenCalledTimes(1);
        expect(env.log.mock.calls.flat().join("\n")).toContain("not in groupAllowFrom");
        cfg.channels!.feishu!.groupAllowFrom = ["oc_card_fixture"];
        cfg.channels!.feishu!.groupSenderAllowFrom = ["ou_other_operator"];
        event.token = "disallowed-sender-click";
        await click();
        expect(run).toHaveBeenCalledTimes(1);
        expect(env.log.mock.calls.flat().join("\n")).toContain("sender allowlist");
        cfg.channels!.feishu!.groupSenderAllowFrom = [];
        event.token = "unmentioned-click";
        await handleFeishuCardAction({ cfg, event, accountId: "selected", runtime: env });
        expect(run).toHaveBeenCalledTimes(1);
        expect(env.log.mock.calls.flat().join("\n")).toContain("did not mention bot");
        event.context.chat_id = "oc_card_dm";
        event.token = "lookup-dm-click";
        await click();
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]?.[0].raw).toMatchObject({ chatId: "oc_card_dm", chatType: "p2p" });
        event.context = {};
        event.token = "no-chat-id-click";
        await click();
        expect(run).toHaveBeenCalledTimes(3);
        event.operator.open_id = "ou_other_operator";
        event.token = "no-chat-id-denied-click";
        await click();
        expect(run).toHaveBeenCalledTimes(3);
        expect(env.log.mock.calls.flat().join("\n")).toContain("blocked unauthorized sender");
        expect(env.error).not.toHaveBeenCalled();
      },
    );
  },
);
