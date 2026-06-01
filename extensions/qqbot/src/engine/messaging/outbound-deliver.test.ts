import { describe, expect, it, vi } from "vitest";
import { parseAndSendMediaTags, type DeliverDeps } from "./outbound-deliver.js";

function makeDeps(): {
  deps: DeliverDeps;
  sendDocument: ReturnType<typeof vi.fn>;
} {
  const sendDocument = vi.fn(async () => ({ channel: "qqbot" }));
  return {
    deps: {
      chunkText: (text) => [text],
      mediaSender: {
        sendPhoto: vi.fn(async () => ({ channel: "qqbot" })),
        sendVoice: vi.fn(async () => ({ channel: "qqbot" })),
        sendVideoMsg: vi.fn(async () => ({ channel: "qqbot" })),
        sendDocument,
        sendMedia: vi.fn(async () => ({ channel: "qqbot" })),
      },
    },
    sendDocument,
  };
}

describe("parseAndSendMediaTags", () => {
  it("blocks file URI media tags before they reach document sending", async () => {
    const { deps, sendDocument } = makeDeps();
    const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const result = await parseAndSendMediaTags(
      "<qqfile>file:///etc/passwd</qqfile>",
      {
        type: "c2c",
        senderId: "user-1",
        messageId: "msg-1",
      },
      {
        account: {
          accountId: "acct",
          appId: "app",
          clientSecret: "secret",
          markdownSupport: false,
          config: {},
        },
        qualifiedTarget: "qqbot:c2c:user-1",
        log,
      },
      async (send) => await send("token"),
      () => undefined,
      deps,
    );

    expect(result.handled).toBe(true);
    expect(sendDocument).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("Blocked file URI in <qqfile> media tag");
  });
});
