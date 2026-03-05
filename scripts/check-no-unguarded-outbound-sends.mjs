#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFilesFromRoots,
  getPropertyNameText,
  isTestLikeTypeScriptFile,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];

// Intentionally explicit/narrow: allowed files are the guarded helper definitions,
// approved outbound boundaries, and audited bypass sites.
const allowedOutboundGuardFiles = [
  "extensions/bluebubbles/src/chat.ts",
  "extensions/bluebubbles/src/reactions.ts",
  "extensions/bluebubbles/src/send.ts",
  "extensions/feishu/src/reactions.ts",
  "extensions/feishu/src/send.ts",
  "extensions/feishu/src/typing.ts",
  "extensions/googlechat/src/api.ts",
  "extensions/irc/src/inbound.ts",
  "extensions/matrix/src/matrix/send.ts",
  "extensions/mattermost/src/mattermost/send.ts",
  "extensions/mattermost/src/mattermost/slash-http.ts",
  "extensions/msteams/src/reply-dispatcher.ts",
  "extensions/nextcloud-talk/src/send.ts",
  "extensions/synology-chat/src/client.ts",
  "extensions/zalo/src/api.ts",
  "extensions/zalouser/src/monitor.ts",
  "extensions/zalouser/src/send.ts",
  "src/agents/acp-spawn.ts",
  "src/agents/subagent-announce.ts",
  "src/agents/tools/sessions-send-tool.a2a.ts",
  "src/auto-reply/reply/reply-dispatcher.ts",
  "src/auto-reply/reply/route-reply.ts",
  "src/channels/plugins/pairing.ts",
  "src/cli/pairing-cli.ts",
  "src/commands/agent-via-gateway.ts",
  "src/commands/agent/delivery.ts",
  "src/cron/delivery.ts",
  "src/cron/isolated-agent/delivery-dispatch.ts",
  "src/discord/monitor/agent-components.ts",
  "src/discord/monitor/exec-approvals.ts",
  "src/discord/monitor/native-command.ts",
  "src/discord/monitor/typing.ts",
  "src/discord/send.outbound.ts",
  "src/discord/send.reactions.ts",
  "src/gateway/server-cron.ts",
  "src/gateway/server-methods/send.ts",
  "src/gateway/server-node-events.ts",
  "src/gateway/server-restart-sentinel.ts",
  "src/gateway/server.impl.ts",
  "src/imessage/send.ts",
  "src/infra/exec-approval-forwarder.ts",
  "src/infra/heartbeat-runner.ts",
  "src/infra/outbound/deliver-runtime.ts",
  "src/infra/outbound/deliver.ts",
  "src/infra/outbound/message-action-runner.ts",
  "src/infra/outbound/message.ts",
  "src/infra/outbound/write-policy.ts",
  "src/infra/session-maintenance-warning.ts",
  "src/line/monitor.ts",
  "src/line/send.ts",
  "src/media-understanding/echo-transcript.ts",
  "src/plugin-sdk/index.ts",
  "src/signal/send.ts",
  "src/slack/actions.ts",
  "src/slack/monitor/events/interactions.ts",
  "src/slack/monitor/message-handler/dispatch.ts",
  "src/slack/monitor/replies.ts",
  "src/slack/monitor/slash.ts",
  "src/slack/send.ts",
  "src/telegram/bot-message-context.ts",
  "src/telegram/bot-native-commands.ts",
  "src/telegram/dm-access.ts",
  "src/telegram/send.ts",
  "src/web/inbound/access-control.ts",
  "src/web/inbound/monitor.ts",
  "src/web/inbound/send-api.ts",
  "src/web/outbound.ts",
];

const allowedOutboundGuardFileSet = new Set(allowedOutboundGuardFiles);

const gatewaySendCalleeNames = new Set([
  "callGateway",
  "callGatewayFromCli",
  "callGatewayTool",
  "callMessageGateway",
]);

const sockSideEffectMethods = new Set(["readMessages", "sendPresenceUpdate", "sendMessage"]);

const violations = [];

function normalizeRelativePath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function getStringLiteralValue(node) {
  const value = unwrapExpression(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  return null;
}

function isFalseLiteral(node) {
  const value = unwrapExpression(node);
  return value.kind === ts.SyntaxKind.FalseKeyword;
}

function getObjectLiteralPropertyValue(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getPropertyNameText(property.name);
    if (name === propertyName) {
      return property.initializer;
    }
  }
  return null;
}

function getCalleeName(expression) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return null;
}

function getPropertyChain(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return [unwrapped.text];
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const left = getPropertyChain(unwrapped.expression);
    if (!left) {
      return null;
    }
    return [...left, unwrapped.name.text];
  }
  return null;
}

function hasChainTail(chain, tail) {
  if (chain.length < tail.length) {
    return false;
  }
  const offset = chain.length - tail.length;
  for (let index = 0; index < tail.length; index += 1) {
    if (chain[offset + index] !== tail[index]) {
      return false;
    }
  }
  return true;
}

function addViolation(rule, relPath, sourceFile, node) {
  violations.push({
    callsite: `${relPath}:${toLine(sourceFile, node)}`,
    rule,
  });
}

function isGatewaySendLikeCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const calleeName = getCalleeName(node.expression);
  if (!calleeName || !gatewaySendCalleeNames.has(calleeName)) {
    return false;
  }
  const requestObject = node.arguments[0];
  if (!requestObject || !ts.isObjectLiteralExpression(requestObject)) {
    return false;
  }
  const methodExpression = getObjectLiteralPropertyValue(requestObject, "method");
  const method = methodExpression ? getStringLiteralValue(methodExpression) : null;
  if (!method) {
    return false;
  }
  if (method === "send") {
    return true;
  }
  if (method !== "agent") {
    return false;
  }
  const paramsExpression = getObjectLiteralPropertyValue(requestObject, "params");
  if (!paramsExpression || !ts.isObjectLiteralExpression(unwrapExpression(paramsExpression))) {
    return false;
  }
  const paramsObject = unwrapExpression(paramsExpression);
  const deliverExpression = getObjectLiteralPropertyValue(paramsObject, "deliver");
  if (!deliverExpression) {
    return false;
  }
  return !isFalseLiteral(deliverExpression);
}

function isDeliverOutboundPayloadsImport(node) {
  if (!ts.isImportDeclaration(node)) {
    return false;
  }
  const importClause = node.importClause;
  if (!importClause || !importClause.namedBindings) {
    return false;
  }
  if (!ts.isNamedImports(importClause.namedBindings)) {
    return false;
  }
  return importClause.namedBindings.elements.some((specifier) => {
    const importedName = specifier.propertyName?.text ?? specifier.name.text;
    return importedName === "deliverOutboundPayloads";
  });
}

function isDeliverOutboundPayloadsCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = unwrapExpression(node.expression);
  return ts.isIdentifier(callee) && callee.text === "deliverOutboundPayloads";
}

function isSockSideEffectCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  if (!chain) {
    return false;
  }
  const method = chain.at(-1);
  if (!method || !sockSideEffectMethods.has(method)) {
    return false;
  }
  return (
    (chain.length === 2 && chain[0] === "sock") ||
    (chain.length === 3 && chain[0] === "params" && chain[1] === "sock")
  );
}

function isSlackChatUpdateCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("src/slack/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  return Boolean(chain && hasChainTail(chain, ["chat", "update"]));
}

function isTelegramReactionApiCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("src/telegram/")) {
    return false;
  }
  const callee = unwrapExpression(node.expression);
  return ts.isIdentifier(callee) && callee.text === "reactionApi";
}

function isTelegramSetMessageReactionCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("src/telegram/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  return Boolean(chain && chain.at(-1) === "setMessageReaction");
}

function isDiscordMonitorInteractionReplyCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("src/discord/monitor/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  return Boolean(chain && hasChainTail(chain, ["interaction", "reply"]));
}

function isSlackMonitorRespondCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("src/slack/monitor/")) {
    return false;
  }
  const callee = unwrapExpression(node.expression);
  return ts.isIdentifier(callee) && callee.text === "respond";
}

function isMsTeamsTypingSendActivityCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("extensions/msteams/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  if (!chain || chain.at(-1) !== "sendActivity") {
    return false;
  }
  const firstArgument = node.arguments[0];
  if (!firstArgument || !ts.isObjectLiteralExpression(unwrapExpression(firstArgument))) {
    return false;
  }
  const payload = unwrapExpression(firstArgument);
  const typeExpression = getObjectLiteralPropertyValue(payload, "type");
  const typeValue = typeExpression ? getStringLiteralValue(typeExpression) : null;
  return typeValue === "typing";
}

function isFeishuReactionMutationCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("extensions/feishu/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  return Boolean(
    chain &&
    (hasChainTail(chain, ["messageReaction", "create"]) ||
      hasChainTail(chain, ["messageReaction", "delete"])),
  );
}

function isMatrixTypingOrReadReceiptCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("extensions/matrix/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  const method = chain?.at(-1);
  return method === "setTyping" || method === "sendReadReceipt";
}

function isLineLoadingAnimationCall(node, relPath) {
  if (!ts.isCallExpression(node) || !relPath.startsWith("src/line/")) {
    return false;
  }
  const chain = getPropertyChain(node.expression);
  return Boolean(chain && chain.at(-1) === "showLoadingAnimation");
}

function checkNodeForViolations(node, relPath, sourceFile) {
  if (isGatewaySendLikeCall(node)) {
    addViolation("gateway-send-agent", relPath, sourceFile, node);
  }
  if (isDeliverOutboundPayloadsCall(node)) {
    addViolation("deliver-outbound-call", relPath, sourceFile, node);
  }
  if (isSockSideEffectCall(node)) {
    addViolation("whatsapp-sock-side-effect", relPath, sourceFile, node);
  }
  if (isSlackChatUpdateCall(node, relPath)) {
    addViolation("slack-chat-update", relPath, sourceFile, node);
  }
  if (isTelegramReactionApiCall(node, relPath)) {
    addViolation("telegram-reaction-api", relPath, sourceFile, node);
  }
  if (isTelegramSetMessageReactionCall(node, relPath)) {
    addViolation("telegram-set-message-reaction", relPath, sourceFile, node);
  }
  if (isDiscordMonitorInteractionReplyCall(node, relPath)) {
    addViolation("discord-interaction-reply", relPath, sourceFile, node);
  }
  if (isSlackMonitorRespondCall(node, relPath)) {
    addViolation("slack-respond", relPath, sourceFile, node);
  }
  if (isMsTeamsTypingSendActivityCall(node, relPath)) {
    addViolation("msteams-sendactivity-typing", relPath, sourceFile, node);
  }
  if (isFeishuReactionMutationCall(node, relPath)) {
    addViolation("feishu-message-reaction", relPath, sourceFile, node);
  }
  if (isMatrixTypingOrReadReceiptCall(node, relPath)) {
    addViolation("matrix-typing-read-receipt", relPath, sourceFile, node);
  }
  if (isLineLoadingAnimationCall(node, relPath)) {
    addViolation("line-loading-animation", relPath, sourceFile, node);
  }
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const roots = resolveSourceRoots(repoRoot, sourceRoots);
  const files = await collectTypeScriptFilesFromRoots(roots);

  for (const filePath of files) {
    if (isTestLikeTypeScriptFile(filePath)) {
      continue;
    }
    const relPath = normalizeRelativePath(repoRoot, filePath);
    const content = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const visit = (node) => {
      if (!allowedOutboundGuardFileSet.has(relPath)) {
        if (isDeliverOutboundPayloadsImport(node)) {
          addViolation("deliver-outbound-import", relPath, sourceFile, node);
        }
        if (ts.isCallExpression(node)) {
          checkNodeForViolations(node, relPath, sourceFile);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (violations.length === 0) {
    return;
  }

  const sorted = violations.toSorted((a, b) =>
    a.callsite === b.callsite ? a.rule.localeCompare(b.rule) : a.callsite.localeCompare(b.callsite),
  );

  console.error("Found unguarded outbound send callsites outside allowlist:");
  for (const violation of sorted) {
    console.error(`- ${violation.callsite} [${violation.rule}]`);
  }
  console.error(
    "Route calls through approved outbound boundaries/guarded helpers, or add the file to allowedOutboundGuardFiles with an explicit guardWrite-backed rationale.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
