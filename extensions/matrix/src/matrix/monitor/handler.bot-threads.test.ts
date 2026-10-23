import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixConfigSchema } from "../../config-schema.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixTextMessageEvent as textMessage,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

const roomId = "!room:example.org";
const botUserId = "@bot:example.org";
const rootBody = "Discussion started by the bot";
const strict = { requireMentionInBotThreads: true } satisfies MatrixConfig;
const relaxed = { requireMentionInBotThreads: false } satisfies MatrixConfig;

describe("Matrix bot-owned thread mention policy", () => {
  beforeEach(() => installMatrixMonitorTestRuntime());

  function setup(matrix: MatrixConfig = {}) {
    expect(MatrixConfigSchema.parse(matrix)).toEqual(matrix);
    const cfg: CoreConfig = { channels: { matrix } };
    const accountConfig = resolveMatrixAccountConfig({ cfg, accountId: "work" });
    const root = textMessage({ eventId: "$root", sender: botUserId, body: rootBody });
    const getEvent = vi.fn(async () => root);
    const dispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));
    const harness = createHarness({
      cfg,
      accountId: "work",
      accountConfig,
      roomsConfig: accountConfig.groups ?? accountConfig.rooms,
      groupPolicy: accountConfig.groupPolicy ?? "open",
      isDirectMessage: false,
      client: { getEvent },
      dispatchInboundMessage: dispatch,
    });
    return {
      ...harness,
      root,
      getEvent,
      dispatch,
      receive: (overrides: Partial<Parameters<typeof textMessage>[0]> = {}) =>
        harness.handler(
          roomId,
          textMessage({
            eventId: "$followup",
            body: "Continue the discussion",
            relatesTo: { rel_type: "m.thread", event_id: "$root" },
            ...overrides,
          }),
        ),
    };
  }

  it.each<[string, MatrixConfig]>([
    ["account", { ...strict, accounts: { work: relaxed } }],
    ["exact group", { groups: { "*": strict, [roomId]: relaxed } }],
  ])("accepts unmentioned bot-thread replies with %s configuration", async (_scope, config) => {
    const f = setup(config);
    await f.receive();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(vi.mocked(f.recordInboundSession).mock.calls[0]?.[0]).toMatchObject({
      ctx: {
        BodyForAgent: "Continue the discussion",
        ThreadStarterBody: expect.stringContaining(rootBody),
      },
    });
    expect(f.getEvent).toHaveBeenCalledTimes(1);
  });

  it("retains mention gating when bot-thread policy explicitly requires it", async () => {
    const f = setup({ ...strict, rooms: { [roomId]: { autoReply: true } } });
    await f.receive();
    expect(f.dispatch).not.toHaveBeenCalled();

    await f.receive({
      eventId: "$mentioned",
      body: `${botUserId} Continue the discussion`,
      mentions: { user_ids: [botUserId] },
    });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each<[string, Partial<MatrixRawEvent> | null, number]>([
    ["another author's root", { sender: "@other:example.org" }, 0],
    ["another event id", { event_id: "$other" }, 0],
    ["another room", { room_id: "!other:example.org" }, 0],
    ["an unreadable root", null, 0],
    ["a redacted bot-authored root", { content: {}, unsigned: { redacted_because: {} } }, 1],
  ])("applies bot-thread ownership gating to %s", async (_kind, patch, dispatches) => {
    const f = setup(relaxed);
    if (patch) {
      f.getEvent.mockResolvedValue({ ...f.root, ...patch });
    } else {
      f.getEvent.mockRejectedValue(new Error("M_FORBIDDEN"));
    }
    await f.receive();
    expect(f.dispatch).toHaveBeenCalledTimes(dispatches);
  });

  it.each<[string, MatrixConfig]>([
    ["disabled rooms", { groupPolicy: "disabled" }],
    ["room sender allowlists", { rooms: { [roomId]: { users: ["@trusted:example.org"] } } }],
  ])("preserves %s inside bot threads", async (_restriction, config) => {
    const f = setup({ ...config, ...relaxed });
    await f.receive();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.getEvent).not.toHaveBeenCalled();
  });
});
