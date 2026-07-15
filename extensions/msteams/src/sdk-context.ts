import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

export function buildMSTeamsActivityHandler(): MSTeamsActivityHandler {
  type Handler = (context: unknown, next: () => Promise<void>) => Promise<void>;
  const messageHandlers: Handler[] = [];
  const membersAddedHandlers: Handler[] = [];
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
        for (const registeredHandler of messageHandlers) {
          await registeredHandler(context, noop);
        }
      } else if (activityType === "conversationUpdate") {
        for (const registeredHandler of membersAddedHandlers) {
          await registeredHandler(context, noop);
        }
      } else if (activityType === "messageReaction") {
        const activity = (
          ctx as { activity?: { reactionsAdded?: unknown[]; reactionsRemoved?: unknown[] } }
        ).activity;
        if (activity?.reactionsAdded?.length) {
          for (const registeredHandler of reactionsAddedHandlers) {
            await registeredHandler(context, noop);
          }
        }
        if (activity?.reactionsRemoved?.length) {
          for (const registeredHandler of reactionsRemovedHandlers) {
            await registeredHandler(context, noop);
          }
        }
      }
    },
  };

  return handler;
}

export function adaptMSTeamsSdkContext(ctx: unknown, app: MSTeamsApp): MSTeamsTurnContext {
  const sdkCtx = (ctx ?? {}) as {
    activity?: { id?: string; conversation?: { id?: string; conversationType?: string } };
    reply?: (activity: unknown) => Promise<unknown>;
    send?: (activity: unknown) => Promise<unknown>;
    api?: MSTeamsApp["api"];
    stream?: {
      emit(a: unknown): void;
      update(t: string): void;
      close(): unknown;
      readonly canceled: boolean;
    };
  };
  if (typeof sdkCtx.reply !== "function" && typeof sdkCtx.send !== "function") {
    return ctx as MSTeamsTurnContext;
  }
  const conversationId = sdkCtx.activity?.conversation?.id ?? "";
  const inboundApi = sdkCtx.api;
  const activityApi = inboundApi ?? app.api;
  const getTeamDetails = inboundApi
    ? (teamId: string) => inboundApi.teams.getById(teamId)
    : undefined;
  const conversationType = (sdkCtx.activity?.conversation?.conversationType ?? "").toLowerCase();
  const isThreadable = conversationType === "channel" || conversationType === "groupchat";
  const sendActivity = (activity: unknown) =>
    isThreadable ? sdkCtx.reply!(activity) : sdkCtx.send!(activity);
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    sendActivity,
    sendActivities: async (activities: unknown[]) => {
      const results: unknown[] = [];
      for (const activity of activities) {
        results.push(await sendActivity(activity));
      }
      return results;
    },
    updateActivity: async (activity: { id?: string; [key: string]: unknown }) => {
      const activityId = activity.id ?? "";
      return activityApi.conversations.activities(conversationId).update(activityId, activity);
    },
    deleteActivity: async (activityId: string) =>
      activityApi.conversations.activities(conversationId).delete(activityId),
    getTeamDetails,
    stream: sdkCtx.stream,
  });
}
