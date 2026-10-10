import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { captureSessionEntryCurrentCheck } from "openclaw/plugin-sdk/session-binding-runtime";
import { resolveSendPolicy } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveIMessageDirectChatService } from "../chat-context.js";
import { imessageRpcSupportsMethod, probeIMessagePrivateApi } from "../probe.js";
import type { IMessageService } from "../targets.js";

const warnIfImsgUpgradeNeeded = (() => {
  let fired = false;
  return {
    fireOnce: (
      rpcMethods: readonly string[],
      runtime: { log?: (msg: string) => void; error?: (msg: string) => void },
    ) => {
      if (fired) {
        return;
      }
      fired = true;
      const detail =
        rpcMethods.length === 0
          ? "imsg build pre-dates the rpc_methods capability list"
          : `imsg rpc_methods=[${rpcMethods.join(", ")}] does not include typing/read`;
      runtime.log?.(
        warn(
          `imessage: typing indicators / read receipts gated off (${detail}). ` +
            `Upgrade imsg (current bridge needs typing+read in rpc_methods).`,
        ),
      );
    },
  };
})();

export async function prepareIMessageEarlyTyping(params: {
  cfg: OpenClawConfig;
  storePath: string;
  cliPath: string;
  probeTimeoutMs: number;
  service?: IMessageService;
  decision: {
    route: { agentId: string; sessionKey: string };
    isGroup: boolean;
    sender: string;
    chatGuid?: string;
  };
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  sendTyping: (target: string, isTyping: boolean) => Promise<void>;
  logTypingError: (action: "start" | "stop", target: string, error: unknown) => void;
}) {
  const typingSession = await captureSessionEntryCurrentCheck({
    agentId: params.decision.route.agentId,
    storePath: params.storePath,
    sessionKey: params.decision.route.sessionKey,
    fields: ["sendPolicy"],
  });
  // A stall invalidates capabilities; re-probing here restores typing/read after recovery.
  const privateApiStatus = await probeIMessagePrivateApi(params.cliPath, params.probeTimeoutMs);
  const supportsTyping = imessageRpcSupportsMethod(privateApiStatus, "typing");
  const supportsRead = imessageRpcSupportsMethod(privateApiStatus, "read");
  if (privateApiStatus.available) {
    if (!supportsTyping || !supportsRead) {
      warnIfImsgUpgradeNeeded.fireOnce(privateApiStatus.rpcMethods, params.runtime);
    }
  }
  const configuredTypingMode =
    resolveAgentConfig(params.cfg, params.decision.route.agentId)?.typingMode ??
    params.cfg.agents?.defaults?.typingMode;
  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: typingSession.entry,
    sessionKey: params.decision.route.sessionKey,
    channel: "imessage",
    chatType: params.decision.isGroup ? "group" : "direct",
  });
  const shouldUseDirectToolTypingOptions =
    !params.decision.isGroup &&
    sendPolicy !== "deny" &&
    (configuredTypingMode === undefined || configuredTypingMode === "instant");
  const shouldStartDirectTyping = supportsTyping && shouldUseDirectToolTypingOptions;
  const earlyDirectTypingService =
    resolveIMessageDirectChatService(params.service, params.decision.chatGuid) ?? "auto";
  const earlyDirectTypingTarget = shouldStartDirectTyping
    ? `${earlyDirectTypingService}:${params.decision.sender}`
    : undefined;
  let stopEarlyDirectTyping: (() => void) | undefined;
  if (earlyDirectTypingTarget) {
    typingSession.assertCurrent();
    // Start channel-native feedback before the expensive history/context/model
    // path. Use a short-lived client so a slow typing RPC cannot block the
    // monitor client's watch stream. Stop is sequenced after start so fast
    // command replies cannot leave a late true after typing:false.
    const earlyDirectTypingStarted = params.sendTyping(earlyDirectTypingTarget, true).then(
      () => true,
      (err: unknown) => {
        params.logTypingError("start", earlyDirectTypingTarget, err);
        return false;
      },
    );
    let earlyTypingStopQueued = false;
    stopEarlyDirectTyping = () => {
      if (earlyTypingStopQueued) {
        return;
      }
      earlyTypingStopQueued = true;
      void earlyDirectTypingStarted
        .then(async (started) => {
          if (!started) {
            return;
          }
          await params.sendTyping(earlyDirectTypingTarget, false);
        })
        .catch((err: unknown) => {
          params.logTypingError("stop", earlyDirectTypingTarget, err);
        });
    };
  }
  return { supportsTyping, supportsRead, shouldUseDirectToolTypingOptions, stopEarlyDirectTyping };
}
