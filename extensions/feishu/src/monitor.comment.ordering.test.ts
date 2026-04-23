import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveFeishuAccount: resolveFeishuAccountMock,
  };
});

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createFeishuClient: createFeishuClientMock,
  };
});

import {
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";

function buildMonitorConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function makeDriveCommentEvent(
  overrides: Partial<FeishuDriveCommentNoticeEvent> = {},
): FeishuDriveCommentNoticeEvent {
  return {
    comment_id: "7623358762119646411",
    event_id: "10d9d60b990db39f96a4c2fd357fb877",
    is_mentioned: true,
    notice_meta: {
      file_token: "doc_token_1",
      file_type: "docx",
      from_user_id: {
        open_id: "ou_sender",
      },
      notice_type: "add_comment",
      to_user_id: {
        open_id: "ou_bot",
      },
    },
    reply_id: "7623358762136374451",
    timestamp: "1774951528000",
    type: "drive.notice.comment_add_v1",
    ...overrides,
  };
}

describe("resolveDriveCommentEventTurn lazy account resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuAccountMock.mockImplementation(() => {
      throw new Error("resolveFeishuAccount should not be called");
    });
    createFeishuClientMock.mockImplementation(() => {
      throw new Error("createFeishuClient should not be called");
    });
  });

  it("returns early for self-authored notices before resolving the account", async () => {
    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: {
            open_id: "ou_bot",
          },
          to_user_id: {
            open_id: "ou_bot",
          },
        },
      }),
      botOpenId: "ou_bot",
    });

    expect(turn).toBeNull();
    expect(resolveFeishuAccountMock).not.toHaveBeenCalled();
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  it("returns early when recipient info is missing before resolving the account", async () => {
    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          to_user_id: undefined,
        },
      }),
      botOpenId: "ou_bot",
    });

    expect(turn).toBeNull();
    expect(resolveFeishuAccountMock).not.toHaveBeenCalled();
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
});
