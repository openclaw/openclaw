import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id?: string;
    user_id?: string;
    chat_id: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
const processedCardActionTokens = new Map<
  string,
  { status: "inflight" | "completed"; expiresAt: number }
>();

export function resetProcessedFeishuCardActionTokensForTests(): void {
  processedCardActionTokens.clear();
}

function pruneProcessedCardActionTokens(now: number): void {
  for (const [key, entry] of processedCardActionTokens.entries()) {
    if (entry.expiresAt <= now) {
      processedCardActionTokens.delete(key);
    }
  }
}

function beginFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneProcessedCardActionTokens(now);
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return true;
  }
  const key = `${params.accountId}:${normalizedToken}`;
  const existing = processedCardActionTokens.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  processedCardActionTokens.set(key, {
    status: "inflight",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
  return true;
}

function completeFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.set(`${params.accountId}:${normalizedToken}`, {
    status: "completed",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
}

function releaseFeishuCardActionToken(params: { token: string; accountId: string }): void {
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.delete(`${params.accountId}:${normalizedToken}`);
}

function buildSyntheticMessageEvent(
  event: FeishuCardActionEvent,
  content: string,
  chatType?: "p2p" | "group",
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: chatType ?? (event.context.chat_id ? "group" : "p2p"),
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

function readTrimmedClarificationString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function parseVincentClarificationActionValue(text: string): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed.kind === "vincent-clarification" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveVincentClarificationWritebackPaths(batchPathRaw: unknown): {
  repoRoot: string;
  writerScriptPath: string;
  applyScriptPath: string;
  batchPath: string;
} | null {
  const batchPath = readTrimmedClarificationString(batchPathRaw);
  if (!batchPath) {
    return null;
  }

  let probeDir = path.dirname(path.resolve(batchPath));
  while (true) {
    const writerScriptPath = path.join(
      probeDir,
      "AI-Org-OS",
      "scripts",
      "write_vincent_clarification_return.py",
    );
    const applyScriptPath = path.join(
      probeDir,
      "AI-Org-OS",
      "scripts",
      "apply_vincent_decision_writeback.py",
    );
    if (fs.existsSync(writerScriptPath) && fs.existsSync(applyScriptPath)) {
      return {
        repoRoot: probeDir,
        writerScriptPath,
        applyScriptPath,
        batchPath,
      };
    }
    const parent = path.dirname(probeDir);
    if (parent === probeDir) {
      return null;
    }
    probeDir = parent;
  }
}

function applyVincentClarificationAction(actionValue: Record<string, unknown>): {
  selectedOption: string;
  reviewRef: string;
  detail: string;
  paths: {
    repoRoot: string;
    writerScriptPath: string;
    applyScriptPath: string;
    batchPath: string;
  };
} {
  const selectedOption = readTrimmedClarificationString(actionValue.selected_option).toUpperCase();
  const reviewRef = readTrimmedClarificationString(actionValue.review_ref);
  const itemIndex = readTrimmedClarificationString(actionValue.item_index);
  if (!selectedOption || !reviewRef) {
    throw new Error("missing clarification callback payload");
  }

  const paths = resolveVincentClarificationWritebackPaths(actionValue.batch_path);
  if (!paths) {
    throw new Error("unable to resolve Vincent clarification writeback paths");
  }

  const args = [
    paths.writerScriptPath,
    "--repo-root",
    paths.repoRoot,
    "--batch-path",
    paths.batchPath,
    ...(itemIndex ? ["--item-index", itemIndex] : []),
    "--review-ref",
    reviewRef,
    "--selected-option",
    selectedOption,
    "--resolved-at",
    new Date().toISOString(),
    "--response-channel",
    "feishu:mira",
    "--write",
    "--apply",
  ];
  const result = spawnSync("python3", args, {
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`failed to execute clarification writer: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      detail || `clarification writeback failed with status ${String(result.status)}`,
    );
  }

  return {
    selectedOption,
    reviewRef,
    detail: result.stdout.trim(),
    paths,
  };
}

async function dispatchSyntheticCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  chatType?: "p2p" | "group";
}): Promise<void> {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: buildSyntheticMessageEvent(params.event, params.command, params.chatType),
    botOpenId: params.botOpenId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
}

async function sendInvalidInteractionNotice(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation";
  accountId?: string;
}): Promise<void> {
  const reasonText =
    params.reason === "stale"
      ? "This card action has expired. Open a fresh launcher card and try again."
      : params.reason === "wrong_user"
        ? "This card action belongs to a different user."
        : params.reason === "wrong_conversation"
          ? "This card action belongs to a different conversation."
          : "This card action payload is invalid.";

  await sendMessageFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    text: `⚠️ ${reasonText}`,
    accountId: params.accountId,
  });
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const decoded = decodeFeishuCardAction({ event });
  const claimedToken = beginFeishuCardActionToken({
    token: event.token,
    accountId: account.accountId,
  });
  if (!claimedToken) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
    return;
  }

  try {
    if (decoded.kind === "invalid") {
      log(
        `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
      );
      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: decoded.reason,
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    if (decoded.kind === "structured") {
      const { envelope } = decoded;
      log(
        `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
      );

      if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
        const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        const prompt =
          typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
            ? envelope.m.prompt
            : `Run \`${command}\` in this Feishu conversation?`;
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt: Date.now() + FEISHU_APPROVAL_CARD_TTL_MS,
            chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
            confirmLabel: command === "/reset" ? "Reset" : "Confirm",
          }),
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Cancelled.",
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
        const command = envelope.q?.trim();
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        await dispatchSyntheticCommand({
          cfg,
          event,
          command,
          botOpenId: params.botOpenId,
          runtime,
          accountId,
          chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: "malformed",
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    const content = buildFeishuCardActionTextFallback(event);

    log(
      `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
    );

    const vincentClarificationAction = parseVincentClarificationActionValue(content);
    if (vincentClarificationAction) {
      try {
        const writeback = applyVincentClarificationAction(vincentClarificationAction);
        log(
          `feishu[${account.accountId}]: applied vincent clarification option ${writeback.selectedOption} for ${writeback.reviewRef}`,
        );
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      } catch (err) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Confirmation received, but writeback failed. Please contact the maintainer.",
          accountId,
        });
        throw err;
      }
    }

    await dispatchSyntheticCommand({
      cfg,
      event,
      command: content,
      botOpenId: params.botOpenId,
      runtime,
      accountId,
    });
    completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
  } catch (err) {
    releaseFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    throw err;
  }
}
