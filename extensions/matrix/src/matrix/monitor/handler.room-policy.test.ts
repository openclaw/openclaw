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

beforeEach(() => installMatrixMonitorTestRuntime());
afterEach(() => vi.restoreAllMocks());

async function receiveRoomMessage(
  body: string,
  options: Parameters<typeof createMatrixHandlerTestHarness>[0] = {},
) {
  const { handler, runPrepared } = createMatrixHandlerTestHarness({
    isDirectMessage: false,
    roomsConfig: { "!room:example.org": { requireMention: false } },
    ...options,
  });
  await handler(
    "!room:example.org",
    createMatrixTextMessageEvent({
      eventId: "$message",
      body,
      originServerTs: 123_456,
    }),
  );
  return runPrepared.mock.calls[0]?.[0].ctxPayload;
}

describe("Matrix inbound room identity", () => {
  it.each([
    ["FYI: no reply needed", undefined, { kind: "normal", source: "message" }],
    ["/status", "text", { kind: "text-slash", source: "text", authorized: true }],
  ] as const)("preserves command metadata for %s", async (body, source, turn) => {
    const ctx = await receiveRoomMessage(body, {
      groupAllowFrom: ["@user:example.org"],
      cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
      shouldHandleTextCommands: () => true,
      hasControlCommand: (text) => text === "/status",
    });
    expect(ctx).toMatchObject({ CommandAuthorized: true, CommandTurn: turn });
    expect(ctx?.CommandSource).toBe(source);
  });

  it("uses the resolved room identity for policy, not its display name", async () => {
    const groups = {
      "#trusted:example.org": { requireMention: false, tools: { allow: ["exec"] } },
      "*": { requireMention: true, tools: { deny: ["exec"] } },
    };
    const cfg = { channels: { matrix: { groups } } };
    vi.spyOn(matrixTargets, "resolveMatrixTargets").mockImplementation(async ({ inputs }) =>
      inputs.map((input) => ({ input, resolved: true, id: "!room:example.org" })),
    );
    const { roomsConfig } = await resolveMatrixMonitorConfig({
      cfg,
      roomsConfig: groups,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const ctx = await receiveRoomMessage("hello", {
      cfg,
      roomsConfig,
      getRoomInfo: async () => ({ name: "#spoofed:example.org", altAliases: [] }),
    });
    expect(ctx).toMatchObject({
      GroupChannel: "!room:example.org",
      GroupId: "!room:example.org",
      GroupSubject: "#spoofed:example.org",
      GroupRequireMention: false,
      ConversationToolPolicy: { allow: ["exec"] },
    });
  });
});
