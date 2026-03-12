import type { ReplyPayload } from "openclaw/plugin-sdk/zalo";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../src/test-utils/send-payload-contract.js";
import { zaloPlugin } from "./channel.js";

vi.mock("./send.js", () => ({
  sendMessageZalo: vi.fn().mockResolvedValue({ ok: true, messageId: "zl-1" }),
}));

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "123456789",
    text: "",
    payload,
  };
}

describe("zaloPlugin outbound sendPayload", () => {
  let mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalo"]>>;

  beforeEach(async () => {
    const mod = await import("./send.js");
    mockedSend = vi.mocked(mod.sendMessageZalo);
    mockedSend.mockClear();
    mockedSend.mockResolvedValue({ ok: true, messageId: "zl-1" });
  });

  installSendPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: ({ payload, sendResults }) => {
      primeSendMock(mockedSend, { ok: true, messageId: "zl-1" }, sendResults);
      return {
        run: async () => await zaloPlugin.outbound!.sendPayload!(baseCtx(payload)),
        sendMock: mockedSend,
        to: "123456789",
      };
    },
  });
});
