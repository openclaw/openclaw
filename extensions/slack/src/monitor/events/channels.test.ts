import type { AllMiddlewareArgs } from "@slack/bolt";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSlackRuntimeContextReader } from "../runtime-policy.js";
import { registerSlackChannelEvents, registerSlackChannelIdChangedEvent } from "./channels.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

const { enqueueSystemEventMock, mutateConfigFileMock, readConfigSnapshotMock } = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  mutateConfigFileMock: vi.fn(),
  readConfigSnapshotMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
}));
vi.mock("openclaw/plugin-sdk/channel-config-writes", () => ({
  resolveChannelConfigWrites: () => true,
}));
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: (...args: unknown[]) => mutateConfigFileMock(...args),
  readConfigFileSnapshotForWrite: (...args: unknown[]) => readConfigSnapshotMock(...args),
}));
const gridIdentity = { kind: "enterprise", apiAppId: "A_GRID", enterpriseId: "E_GRID" } as const;
function gridScope(teamId?: string) {
  return { isEnterpriseInstall: true, enterpriseId: "E_GRID", ...(teamId ? { teamId } : {}) };
}
const createdEvent = { channel: { id: "C1", name: "general" } };

function createChannelContext(params?: {
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness();
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackChannelEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  registerSlackChannelIdChangedEvent({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    ctx: harness.ctx,
    getHandler: (name = "channel_created") => {
      const handler = harness.getHandler(name);
      if (!handler) {
        throw new Error(`expected Slack ${name} handler`);
      }
      return handler;
    },
  };
}

function expectMigration(channels: unknown, migrated: boolean) {
  const assertion = expect(channels);
  (migrated ? assertion.not : assertion).toHaveProperty("COLD12345");
  (migrated ? assertion : assertion.not).toHaveProperty("CNEW12345");
}

describe("registerSlackChannelEvents", () => {
  afterEach(() => clearRuntimeConfigSnapshot());
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    mutateConfigFileMock.mockReset();
    readConfigSnapshotMock.mockReset();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    await getHandler()({ event: createdEvent, body: { api_app_id: "A_OTHER" } });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("tracks accepted events", async () => {
    const trackEvent = vi.fn();
    const { getHandler } = createChannelContext({ trackEvent });
    await getHandler()({ event: createdEvent, body: { event_id: "Ev-channel-1" } });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Slack channel created: #general.", {
      sessionKey: "agent:main:main",
      contextKey: "slack:channel:created:C1:Ev-channel-1",
    });
  });

  it("keeps enterprise channel notifications isolated by listener workspace", async () => {
    const { ctx, getHandler } = createChannelContext();
    ctx.installationIdentity = gridIdentity;
    ctx.resolveSlackSystemEventRoute = vi.fn(
      async (input: Parameters<typeof ctx.resolveSlackSystemEventRoute>[0]) => ({
        agentId: "main",
        sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
      }),
    );

    const cases = [
      {
        name: "channel_created",
        event: createdEvent,
        message: "Slack channel created: #general.",
        kind: "created",
      },
      {
        name: "channel_rename",
        event: { channel: { id: "C1", name: "old-name", name_normalized: "new-name" } },
        message: "Slack channel renamed: #new-name.",
        kind: "renamed",
      },
    ] as const;

    for (const teamId of ["T111", "T222"]) {
      for (const eventCase of cases) {
        await getHandler(eventCase.name)({
          event: eventCase.event,
          body: { api_app_id: "A_GRID", event_id: `Ev-${eventCase.name}-${teamId}` },
          context: gridScope(teamId),
          client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
        });
      }
    }

    expect(enqueueSystemEventMock.mock.calls).toEqual(
      ["T111", "T222"].flatMap((teamId) =>
        cases.map((eventCase) => [
          eventCase.message,
          {
            sessionKey: `session:${teamId}`,
            contextKey: `slack:channel:${teamId}:${eventCase.kind}:C1:Ev-${eventCase.name}-${teamId}`,
          },
        ]),
      ),
    );
  });

  it.each(["channel_created", "channel_rename"])(
    "rejects enterprise %s events without validated listener scope",
    async (eventName) => {
      const trackEvent = vi.fn();
      const { ctx, getHandler } = createChannelContext({ trackEvent });
      ctx.installationIdentity = gridIdentity;
      await getHandler(eventName)({
        event: createdEvent,
        body: { api_app_id: "A_GRID", event_id: `Ev-${eventName}` },
        context: gridScope(),
        client: { token: "listener" } as AllMiddlewareArgs["client"],
      });

      expect(trackEvent).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    },
  );

  it("publishes channel-ID migration without rewriting an admitted policy, including after retry", async () => {
    const oldChannelId = "COLD12345";
    const newChannelId = "CNEW12345";
    const initialConfig = {
      channels: { slack: { channels: { [oldChannelId]: { enabled: true } } } },
    };
    let persistedConfig = structuredClone(initialConfig);
    const persistenceError = new Error("disk full");
    readConfigSnapshotMock.mockImplementation(async () => ({
      snapshot: { hash: "base-hash", sourceConfig: structuredClone(persistedConfig) },
    }));
    mutateConfigFileMock
      .mockRejectedValueOnce(persistenceError)
      .mockImplementationOnce(
        async (params: { mutate: (draft: typeof initialConfig) => unknown }) => {
          const draft = structuredClone(persistedConfig);
          const result = params.mutate(draft);
          persistedConfig = draft;
          setRuntimeConfigSnapshot(draft, draft);
          return { result, nextConfig: draft };
        },
      );
    const { ctx, getHandler } = createChannelContext();
    ctx.cfg = structuredClone(initialConfig) as never;
    ctx.accountId = "default";
    ctx.runtime.error = vi.fn();
    setRuntimeConfigSnapshot(ctx.cfg, ctx.cfg);
    ctx.readRuntimeContext = createSlackRuntimeContextReader(ctx, "synthetic-lookup");
    const admitted = await ctx.readRuntimeContext();
    const handler = getHandler("channel_id_changed");
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const args = {
      event: {
        type: "channel_id_changed",
        old_channel_id: oldChannelId,
        new_channel_id: newChannelId,
      },
      body: {},
      context: { openclawIngressLifecycle: turnAdoptionLifecycle },
    };

    await expect(handler(args)).rejects.toBe(persistenceError);
    expectMigration(ctx.cfg.channels?.slack?.channels, false);
    expect(persistedConfig.channels.slack.channels).toHaveProperty(oldChannelId);

    await expect(handler(args)).resolves.toBeUndefined();
    expectMigration(admitted.cfg.channels?.slack?.channels, false);
    const current = await ctx.readRuntimeContext();
    expectMigration(current.channelsConfig, true);
    expectMigration(persistedConfig.channels.slack.channels, true);
    expect(mutateConfigFileMock).toHaveBeenCalledTimes(2);
  });
});
