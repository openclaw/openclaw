import { isAllowedParsedChatSender } from "../../../src/plugin-sdk/allow-from.js";
function stripPrefix(value, prefix) {
  return value.slice(prefix.length).trim();
}
function startsWithAnyPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}
function resolveServicePrefixedTarget(params) {
  for (const { prefix, service } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      throw new Error(`${prefix} target is required`);
    }
    const remainderLower = remainder.toLowerCase();
    if (params.isChatTarget(remainderLower)) {
      return params.parseTarget(remainder);
    }
    return { kind: "handle", to: remainder, service };
  }
  return null;
}
function resolveServicePrefixedChatTarget(params) {
  const chatPrefixes = [
    ...params.chatIdPrefixes,
    ...params.chatGuidPrefixes,
    ...params.chatIdentifierPrefixes,
    ...params.extraChatPrefixes ?? []
  ];
  return resolveServicePrefixedTarget({
    trimmed: params.trimmed,
    lower: params.lower,
    servicePrefixes: params.servicePrefixes,
    isChatTarget: (remainderLower) => startsWithAnyPrefix(remainderLower, chatPrefixes),
    parseTarget: params.parseTarget
  });
}
function parseChatTargetPrefixesOrThrow(params) {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (!Number.isFinite(chatId)) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { kind: "chat_id", chatId };
    }
  }
  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_guid is required");
      }
      return { kind: "chat_guid", chatGuid: value };
    }
  }
  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_identifier is required");
      }
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }
  return null;
}
function resolveServicePrefixedAllowTarget(params) {
  for (const { prefix } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      return { kind: "handle", handle: "" };
    }
    return params.parseAllowTarget(remainder);
  }
  return null;
}
function resolveServicePrefixedOrChatAllowTarget(params) {
  const servicePrefixed = resolveServicePrefixedAllowTarget({
    trimmed: params.trimmed,
    lower: params.lower,
    servicePrefixes: params.servicePrefixes,
    parseAllowTarget: params.parseAllowTarget
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }
  const chatTarget = parseChatAllowTargetPrefixes({
    trimmed: params.trimmed,
    lower: params.lower,
    chatIdPrefixes: params.chatIdPrefixes,
    chatGuidPrefixes: params.chatGuidPrefixes,
    chatIdentifierPrefixes: params.chatIdentifierPrefixes
  });
  if (chatTarget) {
    return chatTarget;
  }
  return null;
}
function createAllowedChatSenderMatcher(params) {
  return (input) => isAllowedParsedChatSender({
    allowFrom: input.allowFrom,
    sender: input.sender,
    chatId: input.chatId,
    chatGuid: input.chatGuid,
    chatIdentifier: input.chatIdentifier,
    normalizeSender: params.normalizeSender,
    parseAllowTarget: params.parseAllowTarget
  });
}
function parseChatAllowTargetPrefixes(params) {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (Number.isFinite(chatId)) {
        return { kind: "chat_id", chatId };
      }
    }
  }
  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { kind: "chat_guid", chatGuid: value };
      }
    }
  }
  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { kind: "chat_identifier", chatIdentifier: value };
      }
    }
  }
  return null;
}
export {
  createAllowedChatSenderMatcher,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
  resolveServicePrefixedTarget
};
