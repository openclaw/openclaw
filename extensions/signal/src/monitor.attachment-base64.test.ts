import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { expect, it, vi } from "vitest";
import {
  configureSignalToolResultTest,
  installSignalToolResultTestHooks,
  receiveSignalPayloads,
  signalToolResultMocks,
} from "./monitor.tool-result.test-harness.js";

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, saveMediaBuffer: vi.fn(actual.saveMediaBuffer) };
});

installSignalToolResultTestHooks();

it("reports malformed base64 attachments unavailable without writing media", async () => {
  const { replyMock, signalRpcRequestMock, sendMock } = signalToolResultMocks;
  configureSignalToolResultTest({ autoStart: false }, { visibleReplies: "automatic" });
  replyMock.mockResolvedValue({ text: "ok" });
  sendMock.mockResolvedValue({ messageId: "1700000000002" });
  signalRpcRequestMock.mockResolvedValue({
    data: "iVBORw0KGgoAAAANSUhE%%%UgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+M6Q10QAAAABJRU5ErkJggg==",
  });

  vi.mocked(saveMediaBuffer).mockClear();

  await receiveSignalPayloads({
    payloads: [
      {
        envelope: {
          sourceNumber: "+15550001111",
          timestamp: 1,
          dataMessage: {
            message: "read attachment",
            attachments: [{ id: "attachment-123", contentType: "image/png" }],
          },
        },
      },
    ],
  });

  expect(signalRpcRequestMock).toHaveBeenCalledWith(
    "getAttachment",
    { id: "attachment-123", recipient: "+15550001111" },
    expect.anything(),
  );
  expect(replyMock).toHaveBeenCalledOnce();
  expect(replyMock.mock.calls[0]?.[0]?.BodyForAgent).toContain("[signal attachment unavailable]");
  expect(replyMock.mock.calls[0]?.[0]?.media?.[0]?.path).toBeUndefined();
  expect(saveMediaBuffer).not.toHaveBeenCalled();
});
