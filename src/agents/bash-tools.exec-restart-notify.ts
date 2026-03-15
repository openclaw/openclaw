import path from "node:path";
import { extractDeliveryInfo } from "../config/sessions.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveAnnounceTargetFromKey } from "./tools/sessions-send-helpers.js";

const RESTART_NOTIFY_MESSAGE =
  "OpenClaw restarted after an in-chat restart command. I'm back online.";

function isTopLevelOpenClawOption(arg: string): boolean {
  return arg === "--profile" || arg === "-p" || arg === "--config" || arg === "-c";
}

export function isOpenClawGatewayRestartCommand(command: string): boolean {
  const argv = splitShellArgs(command);
  if (!argv || argv.length < 3) {
    return false;
  }
  const binary = path.basename(argv[0]);
  if (binary !== "openclaw") {
    return false;
  }
  let index = 1;
  while (index < argv.length && argv[index]?.startsWith("-")) {
    const arg = argv[index];
    index += isTopLevelOpenClawOption(arg) ? 2 : 1;
  }
  return argv[index] === "gateway" && argv[index + 1] === "restart";
}

export function applyExecRestartNotifyEnv(params: {
  command: string;
  env: Record<string, string>;
  sessionKey?: string;
}) {
  if (!params.sessionKey || !isOpenClawGatewayRestartCommand(params.command)) {
    return false;
  }
  const { deliveryContext, threadId } = extractDeliveryInfo(params.sessionKey);
  const fallbackTarget = resolveAnnounceTargetFromKey(params.sessionKey);
  const notifyChannel = deliveryContext?.channel ?? fallbackTarget?.channel;
  const notifyTo = deliveryContext?.to ?? fallbackTarget?.to;
  const notifyAccountId = deliveryContext?.accountId ?? fallbackTarget?.accountId;
  const notifyThreadId = threadId ?? fallbackTarget?.threadId;

  params.env.OPENCLAW_RESTART_NOTIFY_SESSION_KEY = params.sessionKey;
  if (notifyChannel) {
    params.env.OPENCLAW_RESTART_NOTIFY_CHANNEL = notifyChannel;
  }
  if (notifyTo) {
    params.env.OPENCLAW_RESTART_NOTIFY_TO = notifyTo;
  }
  if (notifyAccountId) {
    params.env.OPENCLAW_RESTART_NOTIFY_ACCOUNT_ID = notifyAccountId;
  }
  if (notifyThreadId) {
    params.env.OPENCLAW_RESTART_NOTIFY_THREAD_ID = notifyThreadId;
  }
  params.env.OPENCLAW_RESTART_NOTIFY_MESSAGE = RESTART_NOTIFY_MESSAGE;
  return true;
}

export { RESTART_NOTIFY_MESSAGE };
