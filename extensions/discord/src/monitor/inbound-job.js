function resolveDiscordInboundJobQueueKey(ctx) {
  const sessionKey = ctx.route.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const baseSessionKey = ctx.baseSessionKey?.trim();
  if (baseSessionKey) {
    return baseSessionKey;
  }
  return ctx.messageChannelId;
}
function buildDiscordInboundJob(ctx) {
  const {
    runtime,
    abortSignal,
    guildHistories,
    client,
    threadBindings,
    discordRestFetch,
    message,
    data,
    threadChannel,
    ...payload
  } = ctx;
  const sanitizedMessage = sanitizeDiscordInboundMessage(message);
  return {
    queueKey: resolveDiscordInboundJobQueueKey(ctx),
    payload: {
      ...payload,
      message: sanitizedMessage,
      data: {
        ...data,
        message: sanitizedMessage
      },
      threadChannel: normalizeDiscordThreadChannel(threadChannel)
    },
    runtime: {
      runtime,
      abortSignal,
      guildHistories,
      client,
      threadBindings,
      discordRestFetch
    }
  };
}
function materializeDiscordInboundJob(job, abortSignal) {
  return {
    ...job.payload,
    ...job.runtime,
    abortSignal: abortSignal ?? job.runtime.abortSignal
  };
}
function sanitizeDiscordInboundMessage(message) {
  const descriptors = Object.getOwnPropertyDescriptors(message);
  delete descriptors.channel;
  return Object.create(Object.getPrototypeOf(message), descriptors);
}
function normalizeDiscordThreadChannel(threadChannel) {
  if (!threadChannel) {
    return null;
  }
  return {
    id: threadChannel.id,
    name: threadChannel.name,
    parentId: threadChannel.parentId,
    parent: threadChannel.parent ? {
      id: threadChannel.parent.id,
      name: threadChannel.parent.name
    } : void 0,
    ownerId: threadChannel.ownerId
  };
}
export {
  buildDiscordInboundJob,
  materializeDiscordInboundJob,
  resolveDiscordInboundJobQueueKey
};
