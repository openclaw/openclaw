import type { PluginLogger, PluginRuntime } from "../../../api.js";
import type { ApiKeyResolver } from "../../client/key-resolver.js";
import type { BackendConfig } from "../../client/types.js";
import type { Notification, NotifyAddressing } from "../../notify/notification.js";
import type { PendingTaskRegistry } from "../../notify/pending-store.js";
import type { ActionRunner } from "../types.js";

/** Result of validating + normalizing an action's params at create time. */
export type ActionValidation =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

/** Runtime dependencies handed to an action when its runner is built (service start). */
export interface ActionRunnerDeps {
  config: BackendConfig;
  resolver: ApiKeyResolver;
  /** Pending-task registry for backend-task actions (crawl_refresh) to enqueue notifications. */
  registry: PendingTaskRegistry;
  /** Subagent surface for agent-prompt actions; undefined outside a gateway runtime. */
  subagent?: PluginRuntime["subagent"];
  /** Fans a Notification out to all configured transports (Mercure / history / email). */
  deliver: (n: Notification, to: NotifyAddressing) => Promise<boolean>;
  logger: PluginLogger;
}

/**
 * A schedulable action type. The metadata + validate() are pure and available at
 * tool-registration time (so schedule_create can enumerate actions and validate
 * params); makeRunner() is called once at service start with runtime deps.
 *
 * Adding a new recurring capability = add one ScheduleActionType to the registry.
 * The Scheduler core, store, and schedule_* tools stay untouched.
 */
export interface ScheduleActionType {
  /** Agent-facing action name used as the `action` enum value in schedule_create. */
  name: string;
  /** Dispatch key: stored as task.action.tool and used as the runners-map key. */
  tool: string;
  /** Short human label. */
  label: string;
  /** One line for the tool description: when to pick this action and what params it needs. */
  summary: string;
  /** Validate + normalize the action params supplied at create time. */
  validate(params: Record<string, unknown>): ActionValidation;
  /** Build the runner that executes this action when a scheduled task fires. */
  makeRunner(deps: ActionRunnerDeps): ActionRunner;
}
