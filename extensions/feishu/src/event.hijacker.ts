import type { RuntimeEnv } from "../runtime-api.js";
import {
  normalizeFeishuEvent,
  type FeishuEventRoute,
  type NormalizedFeishuEvent,
} from "./event.model.js";
import { publishFeishuEventToTopicBus } from "./event.topic-bus.js";

type FeishuEventHandler = (data: unknown) => Promise<unknown> | unknown;

type FeishuEventHandlerMap = Record<string, FeishuEventHandler>;

type FeishuEventDispatcherLike = {
  register: (handlers: FeishuEventHandlerMap) => unknown;
};

type ObserveFeishuHijackedEvent = (params: {
  eventType: string;
  route: FeishuEventRoute;
  normalizedEvent: NormalizedFeishuEvent;
  droppedAsDuplicate: boolean;
}) => Promise<void> | void;

type WrapFeishuEventDispatcherParams<TDispatcher extends FeishuEventDispatcherLike> = {
  eventDispatcher: TDispatcher;
  accountId: string;
  runtime?: Pick<RuntimeEnv, "log" | "error">;
  hasProcessedEvent?: (
    sourceId: string | undefined | null,
    namespace?: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  recordProcessedEvent?: (
    sourceId: string | undefined | null,
    namespace?: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  observeEvent?: ObserveFeishuHijackedEvent;
  publishPassthrough?: boolean;
  dedupeNamespace?: string;
};

const FEISHU_EVENT_HIJACKER_TAG = "[managed-by=feishu.event-hijacker]";

async function observeHijackedEvent(
  observer: ObserveFeishuHijackedEvent | undefined,
  params: Parameters<ObserveFeishuHijackedEvent>[0],
  error: (message: string) => void,
  accountId: string,
): Promise<void> {
  if (!observer) {
    return;
  }
  try {
    await observer(params);
  } catch (err) {
    error(
      `${FEISHU_EVENT_HIJACKER_TAG} feishu[${accountId}]: event observer failed for ${params.eventType}: ${String(err)}`,
    );
  }
}

async function shouldDropFeishuEventDuplicate(params: {
  route: FeishuEventRoute;
  normalizedEvent: NormalizedFeishuEvent;
  namespace: string;
  log: (...args: unknown[]) => void;
  hasProcessedEvent?: WrapFeishuEventDispatcherParams<FeishuEventDispatcherLike>["hasProcessedEvent"];
  error: (message: string) => void;
}): Promise<boolean> {
  if (params.route !== "publish" || !params.hasProcessedEvent) {
    return false;
  }
  try {
    return await params.hasProcessedEvent(
      params.normalizedEvent.sourceId,
      params.namespace,
      params.log,
    );
  } catch (err) {
    params.error(
      `${FEISHU_EVENT_HIJACKER_TAG} feishu[${params.normalizedEvent.accountId}]: duplicate check failed for ${params.normalizedEvent.eventType}: ${String(err)}`,
    );
    return false;
  }
}

async function recordFeishuEventDuplicate(params: {
  route: FeishuEventRoute;
  normalizedEvent: NormalizedFeishuEvent;
  namespace: string;
  log: (...args: unknown[]) => void;
  recordProcessedEvent?: WrapFeishuEventDispatcherParams<FeishuEventDispatcherLike>["recordProcessedEvent"];
  error: (message: string) => void;
}): Promise<void> {
  if (params.route !== "publish" || !params.recordProcessedEvent) {
    return;
  }
  try {
    await params.recordProcessedEvent(
      params.normalizedEvent.sourceId,
      params.namespace,
      params.log,
    );
  } catch (err) {
    params.error(
      `${FEISHU_EVENT_HIJACKER_TAG} feishu[${params.normalizedEvent.accountId}]: duplicate record failed for ${params.normalizedEvent.eventType}: ${String(err)}`,
    );
  }
}

export function wrapFeishuEventDispatcher<TDispatcher extends FeishuEventDispatcherLike>(
  params: WrapFeishuEventDispatcherParams<TDispatcher>,
): TDispatcher {
  const {
    eventDispatcher,
    accountId,
    runtime,
    observeEvent,
    hasProcessedEvent,
    recordProcessedEvent,
    publishPassthrough = true,
    dedupeNamespace = `${accountId}:event-hijacker:publish`,
  } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const register = eventDispatcher.register.bind(eventDispatcher);

  return new Proxy(eventDispatcher, {
    get(target, prop, receiver) {
      if (prop !== "register") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (handlers: FeishuEventHandlerMap) => {
        const wrappedHandlers = Object.fromEntries(
          Object.entries(handlers).map(([eventType, handler]) => {
            const wrappedHandler: FeishuEventHandler = async (data) => {
              const normalizedEvent = normalizeFeishuEvent({
                accountId,
                eventType,
                payload: data,
              });
              const { route } = normalizedEvent;
              const duplicate = await shouldDropFeishuEventDuplicate({
                route,
                normalizedEvent,
                namespace: dedupeNamespace,
                log,
                hasProcessedEvent,
                error,
              });
              if (duplicate) {
                log(
                  `${FEISHU_EVENT_HIJACKER_TAG} feishu[${accountId}]: dropping duplicate ${eventType} source=${normalizedEvent.sourceId}`,
                );
                await observeHijackedEvent(
                  observeEvent,
                  { eventType, route, normalizedEvent, droppedAsDuplicate: true },
                  error,
                  accountId,
                );
                return;
              }

              log(
                `${FEISHU_EVENT_HIJACKER_TAG} feishu[${accountId}]: route=${route} ${normalizedEvent.summary}`,
              );
              await observeHijackedEvent(
                observeEvent,
                { eventType, route, normalizedEvent, droppedAsDuplicate: false },
                error,
                accountId,
              );
              if (route === "publish") {
                publishFeishuEventToTopicBus({
                  event: normalizedEvent,
                  runtime,
                });
              }

              if (route === "direct" || publishPassthrough) {
                await handler(data);
              }
              await recordFeishuEventDuplicate({
                route,
                normalizedEvent,
                namespace: dedupeNamespace,
                log,
                recordProcessedEvent,
                error,
              });
            };
            return [eventType, wrappedHandler];
          }),
        );
        return register(wrappedHandlers);
      };
    },
  });
}

export { FEISHU_EVENT_HIJACKER_TAG };
