import { $ as EventBus, B as IngressSource, Cn as RobotInfo, F as createPlaybookScheduler, Ht as ActionRegistration, I as DEFAULT_INGRESS_POLICIES, It as IntentMapping, J as EventKernelOptions, L as IngressDecision, Lt as IntentRegistry, P as PlaybookScheduler, Q as createEventOutbox, R as IngressPolicy, Rt as createIntentRegistry, Sn as KnowledgeBase, Ut as ActionRegistry, V as createIngressRouter, Vt as ActionHandler, Wt as createActionRegistry, X as EventOutbox, Y as createEventKernel, Z as OutboxDelivery, _n as EventQueryOptions, at as DedupGuard, bn as KbResult, et as EventBusOptions, gn as CwEventMatch, hn as CwEvent, it as semanticFallbackScore, nt as createPlaybookMatcher, ot as createDedupGuard, q as EventKernel, rt as evaluateCondition, tt as createEventBus, vn as EventTrigger, xn as KbStatus, yn as KbIngestOptions, z as IngressRouter } from "../config-types-CnpeTEne.mjs";
import { n as CwEventType, t as CW_EVENTS } from "../event-names-CHNhXOM0.mjs";

//#region src/kernel/event-priority.d.ts
type EventPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
declare function resolveEventPriority(eventType: string, payload: Record<string, unknown>): EventPriority;
declare function compareEventPriority(a: EventPriority, b: EventPriority): number;
//#endregion
//#region src/kernel/glob.d.ts
/** Minimal glob matcher for event type patterns (`alarm.*`, `workorder.#`). */
declare function matchGlob(pattern: string, value: string): boolean;
//#endregion
export { type ActionHandler, type ActionRegistration, type ActionRegistry, CW_EVENTS, CwEvent, CwEventMatch, type CwEventType, DEFAULT_INGRESS_POLICIES, type DedupGuard, type EventBus, type EventBusOptions, type EventKernel, type EventKernelOptions, type EventOutbox, type EventPriority, EventQueryOptions, EventTrigger, type IngressDecision, type IngressPolicy, type IngressRouter, type IngressSource, type IntentMapping, type IntentRegistry, KbIngestOptions, KbResult, KbStatus, KnowledgeBase, type OutboxDelivery, type PlaybookScheduler, RobotInfo, compareEventPriority, createActionRegistry, createDedupGuard, createEventBus, createEventKernel, createEventOutbox, createIngressRouter, createIntentRegistry, createPlaybookMatcher, createPlaybookScheduler, evaluateCondition, matchGlob, resolveEventPriority, semanticFallbackScore };