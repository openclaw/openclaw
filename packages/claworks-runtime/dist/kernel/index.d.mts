import { $ as createDedupGuard, At as createIntentRegistry, B as EventKernel, F as IngressDecision, Ft as ActionRegistry, G as createEventOutbox, H as createEventKernel, I as IngressPolicy, It as createActionRegistry, J as createEventBus, K as EventBus, L as IngressRouter, M as PlaybookScheduler, N as createPlaybookScheduler, Nt as ActionHandler, Ot as IntentMapping, P as DEFAULT_INGRESS_POLICIES, Pt as ActionRegistration, Q as DedupGuard, R as IngressSource, U as EventOutbox, V as EventKernelOptions, W as OutboxDelivery, X as evaluateCondition, Y as createPlaybookMatcher, Z as semanticFallbackScore, cn as CwEventMatch, dn as KbIngestOptions, fn as KbResult, hn as RobotInfo, kt as IntentRegistry, ln as EventQueryOptions, mn as KnowledgeBase, pn as KbStatus, q as EventBusOptions, sn as CwEvent, un as EventTrigger, z as createIngressRouter } from "../config-types-B21NhTMT.mjs";

//#region src/kernel/event-priority.d.ts
type EventPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
declare function resolveEventPriority(eventType: string, payload: Record<string, unknown>): EventPriority;
declare function compareEventPriority(a: EventPriority, b: EventPriority): number;
//#endregion
//#region src/kernel/glob.d.ts
/** Minimal glob matcher for event type patterns (`alarm.*`, `workorder.#`). */
declare function matchGlob(pattern: string, value: string): boolean;
//#endregion
export { type ActionHandler, type ActionRegistration, type ActionRegistry, CwEvent, CwEventMatch, DEFAULT_INGRESS_POLICIES, type DedupGuard, type EventBus, type EventBusOptions, type EventKernel, type EventKernelOptions, type EventOutbox, type EventPriority, EventQueryOptions, EventTrigger, type IngressDecision, type IngressPolicy, type IngressRouter, type IngressSource, type IntentMapping, type IntentRegistry, KbIngestOptions, KbResult, KbStatus, KnowledgeBase, type OutboxDelivery, type PlaybookScheduler, RobotInfo, compareEventPriority, createActionRegistry, createDedupGuard, createEventBus, createEventKernel, createEventOutbox, createIngressRouter, createIntentRegistry, createPlaybookMatcher, createPlaybookScheduler, evaluateCondition, matchGlob, resolveEventPriority, semanticFallbackScore };