import { sendBlueBubblesMedia as sendBlueBubblesMediaImpl } from "./media-send.js";
import {
  monitorBlueBubblesProvider as monitorBlueBubblesProviderImpl,
  resolveBlueBubblesMessageId as resolveBlueBubblesMessageIdImpl,
  resolveWebhookPathFromConfig as resolveWebhookPathFromConfigImpl,
} from "./monitor.js";
import { probeBlueBubbles as probeBlueBubblesImpl } from "./probe.js";
import { sendMessageBlueBubbles as sendMessageBlueBubblesImpl } from "./send.js";
import { blueBubblesSetupWizard as blueBubblesSetupWizardImpl } from "./setup-surface.js";

export type { BlueBubblesProbe } from "./probe.js";

type SendBlueBubblesMedia = typeof import("./media-send.js").sendBlueBubblesMedia;
type ResolveBlueBubblesMessageId = typeof import("./monitor.js").resolveBlueBubblesMessageId;
type MonitorBlueBubblesProvider = typeof import("./monitor.js").monitorBlueBubblesProvider;
type ResolveWebhookPathFromConfig = typeof import("./monitor.js").resolveWebhookPathFromConfig;
type ProbeBlueBubbles = typeof import("./probe.js").probeBlueBubbles;
type SendMessageBlueBubbles = typeof import("./send.js").sendMessageBlueBubbles;
type BlueBubblesSetupWizard = typeof import("./setup-surface.js").blueBubblesSetupWizard;

export function sendBlueBubblesMedia(
  ...args: Parameters<SendBlueBubblesMedia>
): ReturnType<SendBlueBubblesMedia> {
  return sendBlueBubblesMediaImpl(...args);
}

export function resolveBlueBubblesMessageId(
  ...args: Parameters<ResolveBlueBubblesMessageId>
): ReturnType<ResolveBlueBubblesMessageId> {
  return resolveBlueBubblesMessageIdImpl(...args);
}

export function monitorBlueBubblesProvider(
  ...args: Parameters<MonitorBlueBubblesProvider>
): ReturnType<MonitorBlueBubblesProvider> {
  return monitorBlueBubblesProviderImpl(...args);
}

export function resolveWebhookPathFromConfig(
  ...args: Parameters<ResolveWebhookPathFromConfig>
): ReturnType<ResolveWebhookPathFromConfig> {
  return resolveWebhookPathFromConfigImpl(...args);
}

export function probeBlueBubbles(
  ...args: Parameters<ProbeBlueBubbles>
): ReturnType<ProbeBlueBubbles> {
  return probeBlueBubblesImpl(...args);
}

export function sendMessageBlueBubbles(
  ...args: Parameters<SendMessageBlueBubbles>
): ReturnType<SendMessageBlueBubbles> {
  return sendMessageBlueBubblesImpl(...args);
}

export const blueBubblesSetupWizard: BlueBubblesSetupWizard = { ...blueBubblesSetupWizardImpl };
