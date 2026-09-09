// Slack-owned adapters for the shared channel ingress lifecycle observer seam.
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import type {
  ChannelIngressBlocker,
  ChannelIngressCorrelation,
  ChannelIngressLifecycleObserver,
  ChannelIngressOperationOutcome,
  ChannelIngressPreparationStage,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { SlackMessageEvent } from "../types.js";
import type { SlackEventScope } from "./event-scope.js";

type SlackIngressApiMethod =
  | "auth.test"
  | "chat.postEphemeral"
  | "chat.postMessage"
  | "chat.startStream"
  | "chat.appendStream"
  | "chat.stopStream"
  | "conversations.history"
  | "conversations.info"
  | "conversations.members"
  | "conversations.replies"
  | "files.completeUploadExternal"
  | "files.download"
  | "files.info"
  | "reactions.add"
  | "usergroups.users.list"
  | "users.info"
  | "other";

export type SlackIngressApiClientProfile =
  | "pooled_listener"
  | "default"
  | "read"
  | "lookup"
  | "media"
  | "startup_auth"
  | "write";

export type SlackIngressObservationOptions = {
  ingressObserver?: ChannelIngressLifecycleObserver;
};

export type SlackIngressApiObservationOptions = SlackIngressObservationOptions & {
  ingressClientProfile?: SlackIngressApiClientProfile;
};

export type SlackIngressPreparationObserver = ChannelIngressLifecycleObserver;
export type SlackIngressCorrelation = ChannelIngressCorrelation;
export type SlackIngressPreparationStage = ChannelIngressPreparationStage;
export type SlackIngressPreparationBlocker = ChannelIngressBlocker;

type SlackIngressObserverTicket = ReturnType<ChannelIngressLifecycleObserver["begin"]>;
const NOOP_TICKET: SlackIngressObserverTicket = { finish: () => undefined };

function safeCall(run: () => void): void {
  try {
    run();
  } catch {
    // Observability must not change Slack ingress behavior.
  }
}

function safeBegin(
  observer: ChannelIngressLifecycleObserver | undefined,
  operation: Parameters<ChannelIngressLifecycleObserver["begin"]>[0],
): SlackIngressObserverTicket {
  if (!observer) {
    return NOOP_TICKET;
  }
  try {
    return observer.begin(operation);
  } catch {
    return NOOP_TICKET;
  }
}

export function observeSlackIngressStage(
  options: SlackIngressObservationOptions | undefined,
  params: {
    stage: SlackIngressPreparationStage;
    blocker?: SlackIngressPreparationBlocker;
    progress?: "meaningful" | "waiting";
  },
): void {
  const observer = options?.ingressObserver;
  if (!observer) {
    return;
  }
  const blocker = params.blocker ?? "none";
  safeCall(() => observer.stage(params.stage, blocker));
  if (params.progress === "meaningful") {
    safeCall(() => observer.progress(params.stage, blocker));
  }
}

export async function observeSlackIngressApiCall<T>(
  options: SlackIngressApiObservationOptions | undefined,
  params: {
    method: string;
    profile?: SlackIngressApiClientProfile;
  },
  run: () => Promise<T>,
): Promise<T> {
  const observer = options?.ingressObserver;
  if (!observer) {
    return await run();
  }
  const method = normalizeSlackIngressApiMethod(params.method);
  const profile = params.profile ?? options.ingressClientProfile ?? "pooled_listener";
  const ticket = safeBegin(observer, { kind: "api", method, profile });
  try {
    const result = await run();
    safeCall(() => ticket.finish("completed"));
    return result;
  } catch (error) {
    safeCall(() => ticket.finish(classifySlackIngressOperationOutcome(error)));
    throw error;
  }
}

export function observeSlackIngressProgress(
  options: SlackIngressObservationOptions | undefined,
  params: {
    stage?: SlackIngressPreparationStage;
    blocker?: SlackIngressPreparationBlocker;
  },
): void {
  const observer = options?.ingressObserver;
  if (!observer) {
    return;
  }
  safeCall(() => observer.progress(params.stage, params.blocker));
}

export function createSlackIngressScopedObserver(
  observer: SlackIngressPreparationObserver | undefined,
  correlation: SlackIngressCorrelation | undefined,
): SlackIngressPreparationObserver | undefined {
  if (!observer || !correlation || Object.keys(correlation).length === 0) {
    return observer;
  }
  const correlate = () => safeCall(() => observer.correlate(correlation));
  return {
    stage: (stage, blocker) => {
      correlate();
      safeCall(() => observer.stage(stage, blocker));
    },
    progress: (stage, blocker) => {
      correlate();
      safeCall(() => observer.progress(stage, blocker));
    },
    correlate: (nextCorrelation) => safeCall(() => observer.correlate(nextCorrelation)),
    begin: (operation) => {
      correlate();
      return safeBegin(observer, operation);
    },
  };
}

export function createSlackIngressCompositeObserver(
  observers: readonly (SlackIngressPreparationObserver | undefined)[],
): SlackIngressPreparationObserver | undefined {
  const uniqueObservers = Array.from(
    new Set(
      observers.filter(
        (observer): observer is SlackIngressPreparationObserver => observer !== undefined,
      ),
    ),
  );
  if (uniqueObservers.length === 0) {
    return undefined;
  }
  if (uniqueObservers.length === 1) {
    return uniqueObservers[0];
  }
  return {
    stage: (stage, blocker) => {
      for (const observer of uniqueObservers) {
        safeCall(() => observer.stage(stage, blocker));
      }
    },
    progress: (stage, blocker) => {
      for (const observer of uniqueObservers) {
        safeCall(() => observer.progress(stage, blocker));
      }
    },
    correlate: (correlation) => {
      for (const observer of uniqueObservers) {
        safeCall(() => observer.correlate(correlation));
      }
    },
    begin: (operation) => {
      const tickets = uniqueObservers.map((observer) => safeBegin(observer, operation));
      return {
        finish: (outcome) => {
          for (const ticket of tickets) {
            safeCall(() => ticket.finish(outcome));
          }
        },
      };
    },
  };
}

export function buildSlackIngressCorrelation(params: {
  eventType: string;
  message: SlackMessageEvent;
  teamId?: string;
  eventScope?: SlackEventScope;
}): SlackIngressCorrelation {
  const teamId = params.eventScope?.teamId ?? params.teamId;
  const threadTs = params.message.thread_ts ?? params.message.ts;
  return {
    providerEventType: params.eventType,
    ...(teamId ? { teamId } : {}),
    ...(params.message.channel ? { channelId: params.message.channel } : {}),
    ...(params.message.ts ? { messageTs: params.message.ts } : {}),
    ...(threadTs ? { threadTs } : {}),
  };
}

function normalizeSlackIngressApiMethod(method: string): SlackIngressApiMethod {
  switch (method) {
    case "auth.test":
    case "chat.postEphemeral":
    case "chat.postMessage":
    case "chat.startStream":
    case "chat.appendStream":
    case "chat.stopStream":
    case "conversations.history":
    case "conversations.info":
    case "conversations.members":
    case "conversations.replies":
    case "files.completeUploadExternal":
    case "files.download":
    case "files.info":
    case "reactions.add":
    case "usergroups.users.list":
    case "users.info":
      return method;
    default:
      return "other";
  }
}

function classifySlackIngressOperationOutcome(error: unknown): ChannelIngressOperationOutcome {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "cancelled";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "cancelled";
  }
  if (error instanceof WebAPIRateLimitedError) {
    return "failed";
  }
  if (error instanceof WebAPIHTTPError) {
    return "failed";
  }
  if (error instanceof WebAPIPlatformError) {
    return "failed";
  }
  if (error instanceof WebAPIRequestError) {
    return "failed";
  }
  return "unknown";
}
