import { describe, expect, it, vi, afterEach } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  startFeishuEventRuntime,
  stopFeishuEventRuntime,
  buildFeishuEventRuntimeSubscription,
  getActiveFeishuEventRuntimeEventTypes,
} from "./event.runtime.js";
import type { FeishuSkillSubscriberLoadResult } from "./event.skill-loader.js";

const loadFeishuSkillSubscriberSpecsMock = vi.hoisted(() => vi.fn());
const subscribeFeishuEventSubscriptionsMock = vi.hoisted(() => vi.fn());
const createFeishuEventSubscriptionExecutionHandlerMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const executeFeishuSkillSubscriberHandlerMock = vi.hoisted(() => vi.fn());

vi.mock("./event.skill-loader.js", async () => {
  const actual =
    await vi.importActual<typeof import("./event.skill-loader.js")>("./event.skill-loader.js");
  return {
    ...actual,
    loadFeishuSkillSubscriberSpecs: loadFeishuSkillSubscriberSpecsMock,
  };
});

vi.mock("./event.subscription.js", async () => {
  const actual =
    await vi.importActual<typeof import("./event.subscription.js")>("./event.subscription.js");
  return {
    ...actual,
    subscribeFeishuEventSubscriptions: subscribeFeishuEventSubscriptionsMock,
  };
});

vi.mock("./event.executor.js", async () => {
  const actual = await vi.importActual<typeof import("./event.executor.js")>("./event.executor.js");
  return {
    ...actual,
    createFeishuEventSubscriptionExecutionHandler:
      createFeishuEventSubscriptionExecutionHandlerMock,
  };
});

vi.mock("./event.skill-handler.js", async () => {
  const actual = await vi.importActual<typeof import("./event.skill-handler.js")>(
    "./event.skill-handler.js",
  );
  return {
    ...actual,
    executeFeishuSkillSubscriberHandler: executeFeishuSkillSubscriberHandlerMock,
  };
});

function buildConfig(): ClawdbotConfig {
  return {
    agents: {
      defaults: {
        workspace: "/tmp/openclaw-workspace",
      },
    },
  } as ClawdbotConfig;
}

function buildLoadResult(): FeishuSkillSubscriberLoadResult {
  return {
    skillSources: [],
    manifests: [],
    diagnostics: [],
    subscribers: [
      {
        source: {
          skillName: "approval-skill",
          skillFilePath: "/tmp/openclaw-workspace/skills/approval-skill/SKILL.md",
          skillBaseDir: "/tmp/openclaw-workspace/skills/approval-skill",
        },
        filePath: "/tmp/openclaw-workspace/skills/approval-skill/feishu-event.subscribers.json",
        definition: {
          id: "approval-updated",
          enabled: true,
          targetAgentId: "ops",
          match: {
            eventTypes: ["approval.approval.updated_v4"],
            categories: ["approval.instance"],
            route: "publish",
            accountIds: ["acct-1"],
            sourceIdPrefix: "approval_",
          },
          trigger: {
            mode: "isolated",
            prompt: "handle approval update",
            command: "/feishu-event",
          },
          delivery: {
            concurrencyLimit: 1,
          },
        },
      },
    ],
  };
}

afterEach(() => {
  stopFeishuEventRuntime();
  vi.clearAllMocks();
});

describe("event.runtime", () => {
  it("builds subscription definitions from declarative subscriber specs", () => {
    const subscription = buildFeishuEventRuntimeSubscription({
      id: "approval-updated",
      enabled: true,
      targetAgentId: "ops",
      match: {
        eventTypes: ["approval.approval.updated_v4"],
        categories: ["approval.instance"],
        subtypes: ["updated_v4"],
        accountIds: ["acct-1"],
        route: "publish",
        sourceIdPrefix: "approval_",
      },
      trigger: {
        mode: "isolated",
        prompt: "handle approval update",
        command: "/feishu-event",
      },
      delivery: {
        concurrencyLimit: 2,
      },
    });

    expect(subscription).toMatchObject({
      id: "approval-updated",
      eventTypes: ["approval.approval.updated_v4"],
      categories: ["approval.instance"],
      subtypes: ["updated_v4"],
      concurrencyLimit: 2,
      trigger: {
        mode: "isolated",
        agentId: "ops",
        instructions: "handle approval update",
        command: "/feishu-event",
      },
    });
    expect(
      subscription.predicate?.({
        topic: "feishu.approval.approval.updated_v4",
        publishedAt: Date.now(),
        event: {
          accountId: "acct-1",
          route: "publish",
          sourceId: "approval_123",
        },
      } as never),
    ).toBe(true);
  });

  it("loads declarative subscribers and subscribes them once", async () => {
    const unsubscribe = vi.fn();
    subscribeFeishuEventSubscriptionsMock.mockReturnValue(unsubscribe);
    loadFeishuSkillSubscriberSpecsMock.mockResolvedValue(buildLoadResult());

    const handle = await startFeishuEventRuntime({
      cfg: buildConfig(),
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(loadFeishuSkillSubscriberSpecsMock).toHaveBeenCalled();
    expect(createFeishuEventSubscriptionExecutionHandlerMock).toHaveBeenCalled();
    expect(subscribeFeishuEventSubscriptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptions: [
          expect.objectContaining({
            id: "approval-updated",
            eventTypes: ["approval.approval.updated_v4"],
          }),
        ],
      }),
    );
    expect(handle.subscriptions).toHaveLength(1);
    expect(getActiveFeishuEventRuntimeEventTypes()).toEqual(["approval.approval.updated_v4"]);

    handle.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(getActiveFeishuEventRuntimeEventTypes()).toEqual([]);
  });

  it("executes skill subscriber handlers for handler-based subscriptions", async () => {
    let registeredOnMatch:
      | ((match: {
          subscriptionId: string;
          delivery: {
            topic: string;
            event: { accountId: string; route: string; sourceId: string };
          };
          triggerPlan?: unknown;
        }) => Promise<void>)
      | undefined;
    subscribeFeishuEventSubscriptionsMock.mockImplementation((params) => {
      registeredOnMatch = params.onMatch;
      return vi.fn();
    });
    loadFeishuSkillSubscriberSpecsMock.mockResolvedValue({
      skillSources: [],
      manifests: [],
      diagnostics: [],
      subscribers: [
        {
          source: {
            skillName: "bitable-log",
            skillFilePath: "/tmp/openclaw-workspace/skills/bitable-log/SKILL.md",
            skillBaseDir: "/tmp/openclaw-workspace/skills/bitable-log",
          },
          filePath: "/tmp/openclaw-workspace/skills/bitable-log/feishu-event.subscribers.json",
          definition: {
            id: "bitable-record-log",
            enabled: true,
            match: {
              eventTypes: ["drive.file.bitable_record_changed_v1"],
              categories: ["bitable.record"],
              route: "publish",
            },
            handler: {
              file: "./bitable-record-log.handler.mjs",
            },
            delivery: {
              concurrencyLimit: 1,
            },
          },
        },
      ],
    });

    await startFeishuEventRuntime({
      cfg: buildConfig(),
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(registeredOnMatch).toBeTypeOf("function");
    await registeredOnMatch?.({
      subscriptionId: "bitable-record-log",
      delivery: {
        topic: "feishu.drive.file.bitable_record_changed_v1",
        event: {
          accountId: "acct-1",
          route: "publish",
          sourceId: "rec_123",
        },
      },
    });

    expect(executeFeishuSkillSubscriberHandlerMock).toHaveBeenCalledTimes(1);
  });
});
