import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as matrixTargets from "../../resolve-targets.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { resolveMatrixMonitorConfig } from "./config.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  sendReadReceiptMatrix: vi.fn(async () => {}),
}));

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

afterEach(() => vi.restoreAllMocks());

describe("Matrix inbound room identity", () => {
  it("keeps the display name for presentation and the room id for policy", async () => {
    const { handler, runPrepared } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      roomsConfig: { "!room:example.org": { requireMention: false } },
      getRoomInfo: async () => ({ name: "#trusted:example.org", altAliases: [] }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$room-policy",
        sender: "@user:example.org",
        body: "hello",
        originServerTs: 123_456,
      }),
    );

    expect(runPrepared.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      GroupSubject: "#trusted:example.org",
      GroupChannel: "!room:example.org",
      GroupId: "!room:example.org",
    });
  });

  it("carries the homeserver-resolved alias policy through inbound dispatch", async () => {
    const tools = { allow: ["exec"] };
    const cfg = {
      channels: {
        matrix: {
          groups: {
            "#trusted:example.org": { requireMention: false, tools },
            "*": { requireMention: true, tools: { deny: ["exec"] } },
          },
        },
      },
    };
    vi.spyOn(matrixTargets, "resolveMatrixTargets").mockImplementation(async ({ inputs }) =>
      inputs.map((input) => ({ input, resolved: true, id: "!room:example.org" })),
    );
    const { roomsConfig } = await resolveMatrixMonitorConfig({
      cfg,
      roomsConfig: cfg.channels.matrix.groups,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const { handler, runPrepared } = createMatrixHandlerTestHarness({
      cfg,
      isDirectMessage: false,
      roomsConfig,
      getRoomInfo: async () => ({ name: "Operations", altAliases: [] }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$alias-policy",
        sender: "@user:example.org",
        body: "hello",
        originServerTs: 123_456,
      }),
    );

    expect(runPrepared.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      GroupChannel: "!room:example.org",
      GroupRequireMention: false,
      ConversationToolPolicy: { allow: ["exec"] },
    });
  });
});
