import { afterEach, expect, it, vi } from "vitest";
import { markIMessageChatRead, sendIMessageTyping } from "./chat.js";
import { IMessageRpcClient } from "./client.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["chat_id:7", { chat_id: 7 }, "sms"],
  ["chat_guid:any;+;fixture", { chat_guid: "any;+;fixture" }, "sms"],
  ["chat_identifier:fixture", { chat_identifier: "fixture" }, "sms"],
  ["+15550001000", { to: "+15550001000" }, "auto"],
  ["imessage:+15550001000", { to: "+15550001000" }, "imessage"],
] as const)(
  "routes chat actions for %s without closing the borrowed client",
  async (to, selector, service) => {
    const client = new IMessageRpcClient();
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
    const stop = vi.spyOn(client, "stop");
    const opts = { cfg: { channels: { imessage: { service: "sms" as const } } }, client };

    await sendIMessageTyping(to, true, opts);
    await markIMessageChatRead(to, opts);

    expect(request.mock.calls).toEqual([
      ["typing", { ...selector, typing: true, service }],
      ["read", selector],
    ]);
    expect(stop).not.toHaveBeenCalled();
  },
);
