import { vi } from "vitest";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  sendWebDirectInboundMessage
} from "./auto-reply.test-harness.js";
async function monitorWebChannelWithCapture(resolver) {
  const spies = createWebInboundDeliverySpies();
  const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();
  await monitorWebChannel(false, listenerFactory, false, resolver);
  const onMessage = getOnMessage();
  if (!onMessage) {
    throw new Error("Missing onMessage handler");
  }
  return { spies, onMessage };
}
async function sendWebDirectInboundAndCollectSessionKeys() {
  const seen = [];
  const resolver = vi.fn(async (ctx) => {
    seen.push(String(ctx.SessionKey));
    return { text: "ok" };
  });
  const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
  await sendWebDirectInboundMessage({
    onMessage,
    spies,
    id: "m1",
    from: "+1000",
    to: "+2000",
    body: "hello"
  });
  return { seen, resolver };
}
export {
  monitorWebChannelWithCapture,
  sendWebDirectInboundAndCollectSessionKeys
};
