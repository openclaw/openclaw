import type { MSTeamsActivityHandler } from "./monitor-handler.js";

/** Build the minimal ActivityHandler-compatible object used by the Teams SDK adapter. */
export function buildMSTeamsActivityHandler(): MSTeamsActivityHandler {
  type Handler = (context: unknown, next: () => Promise<void>) => Promise<void>;
  const messageHandlers: Handler[] = [];
  const membersAddedHandlers: Handler[] = [];
  const membersRemovedHandlers: Handler[] = [];
  const installationUpdateHandlers: Handler[] = [];
  const reactionsAddedHandlers: Handler[] = [];
  const reactionsRemovedHandlers: Handler[] = [];

  const handler: MSTeamsActivityHandler = {
    onMessage(cb) {
      messageHandlers.push(cb);
      return handler;
    },
    onMembersAdded(cb) {
      membersAddedHandlers.push(cb);
      return handler;
    },
    onMembersRemoved(cb) {
      membersRemovedHandlers.push(cb);
      return handler;
    },
    onInstallationUpdate(cb) {
      installationUpdateHandlers.push(cb);
      return handler;
    },
    onReactionsAdded(cb) {
      reactionsAddedHandlers.push(cb);
      return handler;
    },
    onReactionsRemoved(cb) {
      reactionsRemovedHandlers.push(cb);
      return handler;
    },
    async run(context: unknown) {
      const ctx = context as { activity?: { type?: string } };
      const activityType = ctx.activity?.type;
      const noop = async () => {};

      if (activityType === "message") {
        for (const callback of messageHandlers) {
          await callback(context, noop);
        }
      } else if (activityType === "conversationUpdate") {
        const activity = ctx.activity as
          | { membersAdded?: unknown[]; membersRemoved?: unknown[] }
          | undefined;
        if (activity?.membersAdded?.length) {
          for (const callback of membersAddedHandlers) {
            await callback(context, noop);
          }
        }
        if (activity?.membersRemoved?.length) {
          for (const callback of membersRemovedHandlers) {
            await callback(context, noop);
          }
        }
      } else if (activityType === "installationUpdate") {
        for (const callback of installationUpdateHandlers) {
          await callback(context, noop);
        }
      } else if (activityType === "messageReaction") {
        const activity = ctx.activity as
          | { reactionsAdded?: unknown[]; reactionsRemoved?: unknown[] }
          | undefined;
        if (activity?.reactionsAdded?.length) {
          for (const callback of reactionsAddedHandlers) {
            await callback(context, noop);
          }
        }
        if (activity?.reactionsRemoved?.length) {
          for (const callback of reactionsRemovedHandlers) {
            await callback(context, noop);
          }
        }
      }
    },
  };

  return handler;
}
