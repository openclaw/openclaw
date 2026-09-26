import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";

const renderPresentation = vi.hoisted(() => vi.fn());
const sendPayload = vi.hoisted(() => vi.fn());
const sendText = vi.hoisted(() => vi.fn());
const sendFormattedText = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    feishuOutbound: { renderPresentation, sendPayload, sendText, sendFormattedText },
  },
}));

afterAll(() => {
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("Feishu public outbound presentation hooks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const presentation = { title: "Status", blocks: [{ type: "text" as const, text: "Ready" }] };
  const payload = { presentation };
  const ctx = {
    cfg: {},
    to: "chat:oc_group",
    accountId: "work",
    threadId: "om_parent",
    text: "",
    payload,
  };

  it("renders and sends native payloads through the advertised plugin capability", async () => {
    const rendered = { channelData: { feishu: { card: { schema: "2.0" } } } };
    const receipt = { channel: "feishu", messageId: "om_card" };
    renderPresentation.mockResolvedValueOnce(rendered);
    sendPayload.mockResolvedValueOnce(receipt);

    expect(feishuPlugin.outbound?.presentationCapabilities?.supported).toBe(true);
    const renderContext = { ctx, payload, presentation };
    const result = await feishuPlugin.outbound?.renderPresentation?.(renderContext);
    expect(renderPresentation).toHaveBeenCalledExactlyOnceWith(renderContext);
    expect(result).toBe(rendered);

    const sendContext = { ...ctx, payload: rendered };
    await expect(feishuPlugin.outbound?.sendPayload?.(sendContext)).resolves.toBe(receipt);
    expect(sendPayload).toHaveBeenCalledExactlyOnceWith(sendContext);
  });

  it("preserves native renderer and sender failures", async () => {
    const renderError = new Error("card rendering failed");
    renderPresentation.mockRejectedValueOnce(renderError);
    await expect(
      feishuPlugin.outbound?.renderPresentation?.({ ctx, payload, presentation }),
    ).rejects.toBe(renderError);

    const sendError = new Error("card delivery failed");
    sendPayload.mockRejectedValueOnce(sendError);
    await expect(feishuPlugin.outbound?.sendPayload?.(ctx)).rejects.toBe(sendError);
  });

  it("advertises the formatted sender alongside the per-message one", async () => {
    const receipts = [{ channel: "feishu", messageId: "om_first" }];
    sendFormattedText.mockResolvedValueOnce(receipts);

    // Core reads this entry from the registered surface and keeps cutting the reply
    // itself while it is absent, so the adapter implementing it is not enough. Both
    // entries stay advertised, because the per-message one still answers a caller
    // that hands over one unit at a time.
    expect(typeof feishuPlugin.outbound?.sendFormattedText).toBe("function");
    expect(typeof feishuPlugin.outbound?.sendText).toBe("function");

    const formattedContext = {
      cfg: {},
      to: "chat:oc_group",
      accountId: "work",
      threadId: "om_parent",
      text: "| a | b |\n| - | - |\n| 1 | 2 |",
    };
    await expect(feishuPlugin.outbound?.sendFormattedText?.(formattedContext)).resolves.toBe(
      receipts,
    );
    expect(sendFormattedText).toHaveBeenCalledExactlyOnceWith(formattedContext);
  });
});
