import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import {
  createFeishuEventSubscriptionExecutionHandler,
  type FeishuEventExecutor,
} from "./event.executor.js";
import { executeFeishuSkillSubscriberHandler } from "./event.skill-handler.js";
import {
  loadFeishuSkillSubscriberSpecs,
  type FeishuSkillSubscriberLoadResult,
} from "./event.skill-loader.js";
import type { FeishuSkillSubscriberDefinition } from "./event.skill-spec.js";
import type { FeishuEventSubscriptionDefinition } from "./event.subscription.js";
import { subscribeFeishuEventSubscriptions } from "./event.subscription.js";
import type { FeishuEventTriggerSpec } from "./event.trigger.js";

const FEISHU_EVENT_RUNTIME_TAG = "[managed-by=feishu.event-runtime]";

type RuntimeLogger = Pick<RuntimeEnv, "log" | "error">;

export type FeishuEventRuntimeHandle = {
  stop: () => void;
  subscriptions: readonly FeishuEventSubscriptionDefinition[];
  loadResult: FeishuSkillSubscriberLoadResult;
};

let activeFeishuEventRuntimeStop: (() => void) | undefined;
let activeFeishuEventRuntimeSubscriptions: readonly FeishuEventSubscriptionDefinition[] = [];

function expandUserHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeRoot(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.resolve(expandUserHome(trimmed));
}

function resolveConfiguredWorkspaceDirs(cfg: ClawdbotConfig): string[] {
  const workspaces = new Set<string>();
  const defaultWorkspace = normalizeRoot(cfg.agents?.defaults?.workspace);
  if (defaultWorkspace) {
    workspaces.add(defaultWorkspace);
  }
  for (const agent of cfg.agents?.list ?? []) {
    const workspace = normalizeRoot(agent.workspace);
    if (workspace) {
      workspaces.add(workspace);
    }
  }
  return Array.from(workspaces.values());
}

export function resolveFeishuEventSkillRoots(cfg: ClawdbotConfig): readonly string[] {
  const roots = new Set<string>();
  for (const workspaceDir of resolveConfiguredWorkspaceDirs(cfg)) {
    roots.add(path.join(workspaceDir, "skills"));
    roots.add(path.join(workspaceDir, ".agents", "skills"));
  }
  roots.add(path.join(os.homedir(), ".agents", "skills"));
  roots.add(path.join(os.homedir(), ".openclaw", "skills"));
  for (const extraDir of cfg.skills?.load?.extraDirs ?? []) {
    const normalized = normalizeRoot(extraDir);
    if (normalized) {
      roots.add(normalized);
    }
  }
  roots.add(path.resolve(new URL("../skills", import.meta.url).pathname));
  return Array.from(roots.values());
}

function buildFeishuEventRuntimePredicate(
  definition: FeishuSkillSubscriberDefinition,
): FeishuEventSubscriptionDefinition["predicate"] {
  const accountIds = definition.match?.accountIds;
  const route = definition.match?.route;
  const sourceIdPrefix = definition.match?.sourceIdPrefix;
  if ((!accountIds || accountIds.length === 0) && !route && !sourceIdPrefix) {
    return undefined;
  }
  return (delivery) => {
    if (accountIds && accountIds.length > 0 && !accountIds.includes(delivery.event.accountId)) {
      return false;
    }
    if (route && delivery.event.route !== route) {
      return false;
    }
    if (sourceIdPrefix && !delivery.event.sourceId.startsWith(sourceIdPrefix)) {
      return false;
    }
    return true;
  };
}

function buildFeishuEventRuntimeTrigger(
  definition: FeishuSkillSubscriberDefinition,
): FeishuEventTriggerSpec | undefined {
  if (!definition.trigger || !definition.targetAgentId) {
    return undefined;
  }
  return {
    mode: definition.trigger.mode,
    agentId: definition.targetAgentId,
    command: definition.trigger.command,
    instructions: definition.trigger.prompt,
    customSessionId:
      definition.trigger.mode === "custom" ? definition.trigger.sessionKey : undefined,
    includeRawPayload: definition.trigger.includeRawPayload,
  };
}

export function buildFeishuEventRuntimeSubscription(
  definition: FeishuSkillSubscriberDefinition,
): FeishuEventSubscriptionDefinition {
  return {
    id: definition.id,
    topics: definition.match?.topics,
    eventTypes: definition.match?.eventTypes,
    categories: definition.match?.categories,
    subtypes: definition.match?.subtypes,
    concurrencyLimit: definition.delivery?.concurrencyLimit,
    predicate: buildFeishuEventRuntimePredicate(definition),
    trigger: buildFeishuEventRuntimeTrigger(definition),
  };
}

export async function startFeishuEventRuntime(params: {
  cfg: ClawdbotConfig;
  runtime?: RuntimeLogger;
  execute?: FeishuEventExecutor;
  skillRoots?: readonly string[];
}): Promise<FeishuEventRuntimeHandle> {
  stopFeishuEventRuntime();
  const log = params.runtime?.log ?? console.log;
  const loadResult = await loadFeishuSkillSubscriberSpecs({
    skillRoots: params.skillRoots ?? resolveFeishuEventSkillRoots(params.cfg),
    runtime: params.runtime,
  });
  const loadedSubscribersById = new Map(
    loadResult.subscribers.map((entry) => [entry.definition.id, entry] as const),
  );
  const subscriptions = loadResult.subscribers.map((entry) =>
    buildFeishuEventRuntimeSubscription(entry.definition),
  );
  const executeTrigger = createFeishuEventSubscriptionExecutionHandler({
    runtime: params.runtime,
    execute: params.execute,
  });
  const unsubscribe =
    subscriptions.length > 0
      ? subscribeFeishuEventSubscriptions({
          subscriptions,
          runtime: params.runtime,
          onMatch: async (match) => {
            const loadedSubscriber = loadedSubscribersById.get(match.subscriptionId);
            if (loadedSubscriber?.definition.handler) {
              await executeFeishuSkillSubscriberHandler({
                entry: loadedSubscriber,
                match,
                runtime: params.runtime,
              });
            }
            if (match.triggerPlan) {
              await executeTrigger(match);
            }
          },
        })
      : () => {};

  activeFeishuEventRuntimeStop = () => {
    unsubscribe();
    activeFeishuEventRuntimeSubscriptions = [];
    activeFeishuEventRuntimeStop = undefined;
  };
  activeFeishuEventRuntimeSubscriptions = subscriptions;

  log(
    `${FEISHU_EVENT_RUNTIME_TAG} activeSubscriptions=${subscriptions.length} diagnostics=${loadResult.diagnostics.length}`,
  );

  return {
    stop: () => {
      activeFeishuEventRuntimeStop?.();
    },
    subscriptions,
    loadResult,
  };
}

export function stopFeishuEventRuntime(): void {
  activeFeishuEventRuntimeStop?.();
}

export function getActiveFeishuEventRuntimeEventTypes(): readonly string[] {
  return Array.from(
    new Set(
      activeFeishuEventRuntimeSubscriptions.flatMap(
        (subscription) => subscription.eventTypes ?? [],
      ),
    ).values(),
  ).sort((left, right) => left.localeCompare(right));
}
