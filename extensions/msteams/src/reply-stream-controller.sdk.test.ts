import { createServer, request as requestHttp, type IncomingMessage } from "node:http";
import { HttpStream } from "@microsoft/teams.apps/dist/http/http-stream.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type TeamsLoopbackRequest = {
  scenario: string;
  type: string;
  text: string;
  status: number;
  entities?: unknown[];
};

const acknowledgedPrefix = "a".repeat(4_000);
const completeReply = `${acknowledgedPrefix}${"b".repeat(200)}`;
const replacementReply = "provider-final replacement";
const requests: TeamsLoopbackRequest[] = [];
type ConnectorReply = { id?: string; error?: { message?: string } };

async function readJson<T>(message: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

const provider = createServer((request, response) => {
  void readJson<Partial<Pick<TeamsLoopbackRequest, "type" | "text" | "entities">>>(request)
    .then((activity) => {
      const scenario = request.url?.slice(1) ?? "";
      const priorScenarioRequests = requests.filter((entry) => entry.scenario === scenario).length;
      const rejected =
        ((scenario === "cancel-replacement" || scenario === "presentation-cancel") &&
          priorScenarioRequests > 0) ||
        (scenario === "presentation-close-failure" && activity.type === "message") ||
        (scenario === "cancel-close" && activity.type === "message") ||
        (scenario.startsWith("cancel-card-") && activity.type === "message") ||
        (scenario === "presentation-timeout" && priorScenarioRequests === 2) ||
        (activity.text?.length ?? 0) > 4_000;
      const status = rejected ? 403 : 201;
      requests.push({
        scenario,
        type: activity.type ?? "",
        text: activity.text ?? "",
        status,
        ...(scenario.startsWith("presentation-") ? { entities: activity.entities } : {}),
      });
      response.writeHead(status, { "content-type": "application/json" });
      const message =
        scenario === "presentation-timeout"
          ? "exceeded streaming time"
          : scenario.startsWith("cancel") || scenario === "presentation-cancel"
            ? "Content stream was canceled by user"
            : "Message size too large";
      response.end(
        JSON.stringify(rejected ? { error: { message } } : { id: `stream-${scenario}` }),
      );
    })
    .catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
});

let providerUrl = "";

beforeAll(async () => {
  providerUrl = `http://127.0.0.1:${await listenOnLoopback(provider)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    provider.close((error) => (error ? reject(error) : resolve()));
  });
});

function createLoopbackController(
  scenario: string,
  msteamsConfig?: Parameters<typeof createTeamsReplyStreamController>[0]["msteamsConfig"],
) {
  const send = async (activity: Record<string, unknown>) => {
    const result = await new Promise<{
      status: number;
      body: ConnectorReply;
    }>((resolve, reject) => {
      const outgoing = requestHttp(
        `${providerUrl}/${scenario}`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          void readJson<ConnectorReply>(response).then(
            (body) => resolve({ status: response.statusCode ?? 500, body }),
            reject,
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(activity));
    });
    if (result.status < 200 || result.status >= 300) {
      throw Object.assign(new Error(result.body.error?.message ?? "Teams streaming failed"), {
        response: { status: result.status, data: result.body },
      });
    }
    return result.body;
  };
  const firstAcknowledgement = createDeferred<void>();
  const firstFlushFailure = createDeferred<void>();
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(() => firstFlushFailure.resolve()),
    info: vi.fn(),
    warn: vi.fn(() => {
      if (scenario.startsWith("cancel")) {
        firstFlushFailure.resolve();
      }
    }),
  };
  logger.child.mockReturnValue(logger);
  const stream = new HttpStream(
    {
      conversations: {
        createActivity: (_conversationId: string, activity: Record<string, unknown>) =>
          send(activity),
        updateActivity: (
          _conversationId: string,
          _activityId: string,
          activity: Record<string, unknown>,
        ) => send(activity),
      },
    } as never,
    {
      bot: { id: "28:loopback-bot", name: "OpenClaw" },
      conversation: { id: "loopback-conversation", conversationType: "personal" },
      activityId: "loopback-inbound",
    } as never,
    logger as never,
  );
  const acknowledgements: Array<{ id: string; text: string }> = [];
  stream.events.on("chunk", (activity) => {
    acknowledgements.push({ id: activity.id, text: activity.text ?? "" });
    firstAcknowledgement.resolve();
  });
  const controller = createTeamsReplyStreamController({
    allowProviderPreview: true,
    conversationType: "personal",
    context: { activity: { type: "message" }, stream } as never,
    feedbackLoopEnabled: false,
    msteamsConfig,
  });
  return {
    acknowledgements,
    controller,
    firstAcknowledgement: firstAcknowledgement.promise,
    firstFlushFailure: firstFlushFailure.promise,
    logger,
    stream,
  };
}

function scenarioRequests(scenario: string) {
  return requests.filter((request) => request.scenario === scenario);
}

async function acknowledgedController(scenario: string, text = acknowledgedPrefix) {
  const harness = createLoopbackController(scenario);
  harness.controller.onPartialReply({ text });
  await harness.firstAcknowledgement;
  expect(harness.logger.error).not.toHaveBeenCalled();
  expect(harness.acknowledgements).toEqual([{ id: `stream-${scenario}`, text }]);
  return harness;
}

describe("Microsoft Teams SDK acknowledged stream fallback", () => {
  it.each([
    { mode: "partial", canceled: false, media: false },
    { mode: "progress", canceled: false, media: false },
    { mode: "partial", canceled: true, media: false },
    { mode: "progress", canceled: true, media: false },
    { mode: "partial", canceled: false, media: true },
    { mode: "partial", canceled: true, media: true },
  ] as const)(
    "settles $mode cards before releasing them (canceled=$canceled, media=$media)",
    async ({ mode, canceled, media }) => {
      const scenario = `${canceled ? "cancel-" : ""}card-${mode}${media ? "-media" : ""}`;
      const { controller, firstAcknowledgement, stream } = createLoopbackController(scenario, {
        streaming: { mode },
      });
      const text = "Choose an environment";
      const presentation = {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Deploy", value: "deploy" }] }],
      };
      const mediaUrl = "https://example.test/report.png";
      if (mode === "partial") {
        controller.onPartialReply({ text });
        await firstAcknowledgement;
      }
      expect(
        controller.preparePayload({ text, presentation, ...(media ? { mediaUrl } : {}) }),
      ).toEqual(media ? { text: undefined, mediaUrl } : undefined);
      if (mode === "progress") {
        await firstAcknowledgement;
      }

      await expect(controller.finalize()).resolves.toEqual({
        visibleReplySent: true,
        content: text,
        messageId: `stream-${scenario}`,
        ...(canceled ? {} : { postNativePayloads: [{ text: undefined, presentation }] }),
      });
      expect(stream.canceled).toBe(canceled);
      expect(scenarioRequests(scenario).map((request) => [request.type, request.status])).toEqual([
        ["typing", 201],
        ["typing", 201],
        ["message", canceled ? 403 : 201],
      ]);
    },
  );

  it("redelivers only text not acknowledged by the real Teams SDK and HTTP provider", async () => {
    const { acknowledgements, controller, firstFlushFailure } =
      await acknowledgedController("size-limit");

    controller.onPartialReply({ text: completeReply });
    await firstFlushFailure;
    expect(
      scenarioRequests("size-limit").filter(
        (request) => request.type === "typing" && request.status === 403,
      ),
    ).toHaveLength(1);
    expect(acknowledgements).toEqual([{ id: "stream-size-limit", text: acknowledgedPrefix }]);
    expect(controller.preparePayload({ text: completeReply })).toBeUndefined();

    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: acknowledgedPrefix,
      messageId: "stream-size-limit",
      fallbackPayload: { text: "b".repeat(200) },
    });
    // Finalization queues its own metadata activity; this is a second
    // provider operation, not a retry of the rejected streaming chunk.
    expect(
      scenarioRequests("size-limit").filter(
        (request) => request.type === "typing" && request.status === 403,
      ),
    ).toHaveLength(2);
  });

  it.each(["cancel", "cancel-close"] as const)("honors HTTP Stop during %s", async (scenario) => {
    const { controller, firstFlushFailure, stream } = await acknowledgedController(scenario);
    if (scenario === "cancel") {
      controller.onPartialReply({ text: completeReply });
      await firstFlushFailure;
      await stream.close();
      expect(stream.canceled).toBe(true);
    }
    expect(
      controller.preparePayload({
        text: scenario === "cancel" ? completeReply : acknowledgedPrefix,
      }),
    ).toBeUndefined();
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: acknowledgedPrefix,
      messageId: `stream-${scenario}`,
    });
    expect(stream.canceled).toBe(true);
    if (scenario === "cancel-close") {
      expect(controller.wasCanceled()).toBe(true);
      expect(controller.preparePayload({ text: "must not send" })).toBeUndefined();
      expect(scenarioRequests(scenario).map((request) => [request.type, request.status])).toEqual([
        ["typing", 201],
        ["typing", 201],
        ["message", 403],
      ]);
    } else {
      expect(scenarioRequests(scenario)).toHaveLength(2);
    }
  });

  it.each(["replacement", "cancel-replacement"] as const)(
    "settles a divergent preview: %s",
    async (scenario) => {
      const { acknowledgements, controller, stream } = await acknowledgedController(scenario);
      const canceled = scenario === "cancel-replacement";
      const mediaUrl = `https://example.test/${canceled ? "must-not-send" : "replacement"}.png`;
      const presentation = {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Deploy", value: "deploy" }] }],
      };
      controller.onPartialReply({ text: replacementReply });
      expect(
        controller.preparePayload({ text: replacementReply, mediaUrl, presentation }),
      ).toBeUndefined();
      await expect(controller.finalize()).resolves.toEqual(
        canceled
          ? {
              visibleReplySent: true,
              content: acknowledgedPrefix,
              messageId: `stream-${scenario}`,
            }
          : {
              visibleReplySent: true,
              content: replacementReply,
              logicalContent: replacementReply,
              messageId: `stream-${scenario}`,
              postNativePayloads: [{ text: undefined, mediaUrl, presentation }],
            },
      );
      if (canceled) {
        expect(stream.canceled).toBe(true);
      }
      expect(acknowledgements).toEqual([
        { id: `stream-${scenario}`, text: acknowledgedPrefix },
        ...(canceled ? [] : [{ id: `stream-${scenario}`, text: replacementReply }]),
      ]);
      expect(scenarioRequests(scenario)).toHaveLength(canceled ? 2 : 3);
    },
  );
});

describe("Teams native final text preparation", () => {
  it("preserves required AI metadata when the SDK completes a timed-out stream by update", async () => {
    const { controller, firstAcknowledgement } = createLoopbackController("presentation-timeout");
    const text = "# Status";
    controller.onPartialReply({ text });
    await firstAcknowledgement;
    controller.preparePayload({ text });
    await expect(controller.finalize()).resolves.toMatchObject({ visibleReplySent: true });
    const final = requests.findLast((request) => request.scenario === "presentation-timeout");
    expect(final?.text).toBe("**Status**");
    expect(final?.entities).toEqual(
      expect.arrayContaining([
        {
          type: "https://schema.org/Message",
          "@type": "Message",
          "@context": "https://schema.org",
          "@id": "",
          additionalType: ["AIGeneratedContent"],
        },
      ]),
    );
    expect(scenarioRequests("presentation-timeout").map((request) => request.status)).toEqual([
      201, 201, 403, 201,
    ]);
  });

  it.each(["presentation-close-failure", "presentation-cancel"] as const)(
    "preserves acknowledged text across %s",
    async (scenario) => {
      const canceled = scenario === "presentation-cancel";
      const text = canceled
        ? "# Deployment status"
        : "# Deployment status\n\n@[Alex](11111111-2222-3333-4444-555555555555)";
      const presentation = {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Deploy", value: "deploy" }] }],
      };
      const { controller } = await acknowledgedController(scenario, text);
      controller.preparePayload({ text, presentation });
      await expect(controller.finalize()).resolves.toEqual({
        visibleReplySent: true,
        messageId: `stream-${scenario}`,
        content: canceled ? text : "**Deployment status**\n\n<at>Alex</at>",
        ...(canceled
          ? {}
          : { logicalContent: text, fallbackPayload: { text: undefined, presentation } }),
      });
      expect(scenarioRequests(scenario).map((request) => request.status)).toEqual(
        canceled ? [201, 403] : [201, 201, 403],
      );
    },
  );
});

it("separates informative plan rows at the SDK HTTP boundary", async () => {
  const scenario = "informative-plan-rows";
  const { controller, firstAcknowledgement } = createLoopbackController(scenario, {
    streaming: { mode: "progress", progress: { label: "Working", toolProgress: true } },
  });
  await controller.pushPlanProgress([
    { step: "Check account", status: "completed" },
    { step: "Search records", status: "in_progress" },
  ]);
  await firstAcknowledgement;
  const update = requests.find((request) => request.scenario === scenario);
  controller.preparePayload({ text: "Final answer\n\nSecond paragraph" });
  await controller.finalize();
  expect(update?.text).toContain("Check account");
  expect(update?.text).toContain("Search records");
  expect(update?.text).not.toMatch(/[\r\n]/u);
  expect(update?.text).toContain(" · ");
  expect(
    requests.findLast((request) => request.scenario === scenario && request.type === "message")
      ?.text,
  ).toBe("Final answer\n\nSecond paragraph");
});
