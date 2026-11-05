import fs from "node:fs/promises";
import path from "node:path";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { whatsappPlugin } from "../../channel.js";
import { WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY } from "../../connection-controller-runtime-context.js";
import type { ActiveWebListener } from "../../inbound/types.js";
import { getWhatsAppChannelRuntime } from "../../runtime.js";
import { processMessage } from "./process-message.js";

type Channel = NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>;
export type ReplyResolver = Parameters<typeof processMessage>[0]["replyResolver"];
export const boundarySelf = "+12025550100";
export const boundaryPeer = "+12025550101";
export const boundaryAccount = "work";

export async function createReplyBoundary(
  root: string,
  peer: string,
  options: {
    channel?: Partial<Channel>;
    account?: NonNullable<Channel["accounts"]>[string];
    agents?: OpenClawConfig["agents"];
    kind?: "direct" | "group";
  } = {},
) {
  const kind = options.kind ?? "direct";
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") }, ...options.agents },
    session: { dmScope: "per-channel-peer" },
    channels: {
      whatsapp: {
        ...options.channel,
        accounts: {
          work: { authDir: path.join(root, "auth"), allowFrom: [peer], ...options.account },
        },
      },
    },
  };
  await fs.writeFile(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
  const route = resolveAgentRoute({
    cfg,
    channel: "whatsapp",
    accountId: boundaryAccount,
    peer: { kind, id: peer },
  });
  const backgroundTasks = new Set<Promise<unknown>>();
  return {
    cfg,
    route,
    backgroundTasks,
    process: (msg: Parameters<typeof processMessage>[0]["msg"], replyResolver: ReplyResolver) =>
      processMessage({
        cfg,
        msg,
        route,
        replyResolver,
        backgroundTasks,
        groupHistoryKey: `whatsapp:${boundaryAccount}:${kind}:${peer}`,
        groupHistories: new Map(),
        groupMemberNames: new Map(),
        connectionId: "reply-boundary-proof",
        verbose: false,
        maxMediaBytes: 1_000_000,
        replyLogger: getChildLogger({ module: "whatsapp-reply-boundary" }),
        ackAlreadySent: true,
      }),
  };
}

export function registerReplyBoundary(listener: ActiveWebListener) {
  const priorRegistry = getActivePluginRegistry();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }]),
  );
  const registration = registerChannelRuntimeContext({
    channelRuntime: getWhatsAppChannelRuntime(),
    channelId: "whatsapp",
    accountId: boundaryAccount,
    capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
    context: {
      getActiveListener: () => listener,
      getCurrentSock: () => null,
      getSelfIdentity: () => ({
        e164: boundarySelf,
        jid: `${boundarySelf.slice(1)}@s.whatsapp.net`,
      }),
    },
  });
  return {
    registration,
    dispose: () => {
      registration?.dispose();
      if (priorRegistry) {
        setActivePluginRegistry(priorRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    },
  };
}
