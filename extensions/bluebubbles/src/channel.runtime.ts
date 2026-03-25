import { sendBlueBubblesMedia as sendBlueBubblesMediaImpl } from "./media-send.js";
import {
  monitorBlueBubblesProvider as monitorBlueBubblesProviderImpl,
  resolveBlueBubblesMessageId as resolveBlueBubblesMessageIdImpl,
  resolveWebhookPathFromConfig as resolveWebhookPathFromConfigImpl,
} from "./monitor.js";
import { probeBlueBubbles as probeBlueBubblesImpl } from "./probe.js";
import { sendMessageBlueBubbles as sendMessageBlueBubblesImpl } from "./send.js";

export type { BlueBubblesProbe } from "./probe.js";

export const blueBubblesChannelRuntime = {
  sendBlueBubblesMedia: sendBlueBubblesMediaImpl,
  resolveBlueBubblesMessageId: resolveBlueBubblesMessageIdImpl,
  monitorBlueBubblesProvider: monitorBlueBubblesProviderImpl,
  resolveWebhookPathFromConfig: resolveWebhookPathFromConfigImpl,
  probeBlueBubbles: probeBlueBubblesImpl,
  sendMessageBlueBubbles: sendMessageBlueBubblesImpl,
};
