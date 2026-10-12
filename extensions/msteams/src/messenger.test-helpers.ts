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
          };
        },
      },
    },
  } as unknown as MSTeamsApp;
}
