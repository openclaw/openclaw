import { vi } from "vitest";
import type { MSTeamsApp } from "./sdk.js";

type MockAppOptions = {
  createFn?: (activity: unknown) => Promise<unknown>;
  onClientCreated?: (serviceUrl: string, conversationId: string) => void;
  onReference?: (ref: unknown) => void;
};

export function createMockApp(opts?: MockAppOptions): MSTeamsApp {
  const createFn =
    opts?.createFn ??
    (async (activity: unknown) => {
      const text = (activity as Record<string, unknown>)?.text;
      return { id: typeof text === "string" ? `id:${text}` : "created" };
    });
  const apiServiceUrl = "https://smba.trafficmanager.net/amer";
  return {
    client: { request: vi.fn() },
    tokenProvider: {
      getAppToken: async (scope: string) => ({
        toString: () =>
          scope === "https://graph.microsoft.com/.default" ? "graph-token" : "bot-token",
      }),
    },
    send: async (conversationId: string, activity: unknown) => {
      opts?.onClientCreated?.("", conversationId);
      return await createFn(activity);
    },
    activitySender: {
      send: async (
        activity: unknown,
        ref: { serviceUrl?: string; conversation?: { id?: string } },
      ) => {
        opts?.onReference?.(ref);
        opts?.onClientCreated?.(ref.serviceUrl ?? "", ref.conversation?.id ?? "");
        return await createFn(activity);
      },
    },
    // Mirror the SDK's `app.reply` which internally calls
    // `app.send(toThreadedConversationId(channelId, msgId), activity)`. The
    // test capture sees the threaded conversationId so existing assertions
    // continue to work after we switched messenger.ts from manual URL
    // construction to `app.reply`.
    reply: async (conversationId: string, messageId: string, activity: unknown) => {
      const threaded = `${conversationId};messageid=${messageId}`;
      opts?.onClientCreated?.("", threaded);
      return await createFn(activity);
    },
    api: {
      serviceUrl: apiServiceUrl,
      conversations: {
        activities: (conversationId: string) => {
          opts?.onClientCreated?.(apiServiceUrl, conversationId);
          return {
            create: async (activity: unknown) => {
              opts?.onReference?.({ serviceUrl: apiServiceUrl, ...(activity as object) });
              return createFn(activity);
            },
            update: async (_id: string, activity: unknown) => ({
              id: (activity as Record<string, unknown>)?.id ?? "updated",
            }),
            delete: async () => {},
          };
        },
      },
    },
  } as unknown as MSTeamsApp;
}
