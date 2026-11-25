import type { StoredConversationReference } from "./conversation-store.js";
import type { MSTeamsApp } from "./sdk.js";

export function createStoredReference(
  overrides: Partial<StoredConversationReference> = {},
): StoredConversationReference {
  return {
    activityId: "activity123",
    user: { id: "user123", name: "User" },
    agent: { id: "bot123", name: "Bot" },
    conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    ...overrides,
  };
}

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
  const createApi = (apiServiceUrl: string): unknown => ({
    serviceUrl: apiServiceUrl,
    fromServiceUrl: ({ serviceUrl }: { serviceUrl: string }) => createApi(serviceUrl),
    conversations: {
      activities: (conversationId: string) => {
        opts?.onClientCreated?.(apiServiceUrl, conversationId);
        return {
          create: async (activity: unknown) => {
            opts?.onReference?.({ serviceUrl: apiServiceUrl, ...(activity as object) });
            return createFn(activity);
          },
        };
      },
    },
  });
  return { api: createApi("https://smba.trafficmanager.net/amer") } as unknown as MSTeamsApp;
}
