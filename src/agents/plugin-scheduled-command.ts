import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withPluginCommandScheduleCreation } from "../cron/plugin-command-creation.js";
import {
  currentPluginCommandHostProcessId,
  decodePluginCommandSchedule,
  MAX_PLUGIN_COMMAND_SCHEDULE_DURATION_MS,
  MAX_PLUGIN_COMMAND_SCHEDULE_TOOLS,
  MAX_PLUGIN_COMMAND_SCHEDULES_PER_INVOCATION,
  PLUGIN_COMMAND_SCHEDULE_TOOL_NAME,
} from "../cron/plugin-command-schedule.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../cron/plugin-command-schedule.types.js";
import type { CronJobCreate } from "../cron/types.js";
import { captureQueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.js";
import { getPluginInstanceCodeIdentity } from "../plugins/plugin-code-identity.js";
import { pluginCommandSupportsChannel } from "../plugins/plugin-command-metadata.js";
import { getPluginInstanceIncarnation } from "../plugins/plugin-instance-scope.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginCommandScheduledTurns } from "../plugins/runtime/types-scheduled-turns.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { NativeSubagentRequestSource } from "./plugin-native-subagent.types.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

/** Command-only adapter over the existing final native tool surface and cron.add producer. */
export function preparePluginCommandScheduledTurns(params: {
  source: NativeSubagentRequestSource;
  pluginId: string;
  channel: string;
  assertCurrent: () => void;
  tools: () => Promise<AnyAgentTool[]>;
  withCaller: <T>(run: () => Promise<T>) => Promise<T>;
}): PluginCommandScheduledTurns | undefined {
  params.assertCurrent();
  const registry = getPluginRegistryForContext();
  const plugin = registry?.plugins.find((candidate) => candidate.id === params.pluginId);
  const pluginIncarnation = plugin && getPluginInstanceIncarnation(plugin);
  // Restart continuity re-arms only onto an instance that loaded exactly this code.
  const sourceDigest = plugin && getPluginInstanceCodeIdentity(plugin);
  const operatorSource = captureQueuedOperatorRecoverySource(params.source.operatorAuthority);
  if (
    !registry ||
    !plugin ||
    !pluginIncarnation ||
    plugin.status !== "loaded" ||
    !plugin.contracts?.sessionScheduledTurns?.includes("requester-command") ||
    !operatorSource ||
    operatorSource.kind === "unavailable" ||
    !params.channel
  ) {
    return undefined;
  }
  const assertCurrent = () => {
    params.assertCurrent();
    if (
      isPluginRegistryRetired(registry) ||
      !registry.plugins.includes(plugin) ||
      getPluginInstanceIncarnation(plugin) !== pluginIncarnation ||
      plugin.status !== "loaded"
    ) {
      throw new Error("Scheduled command plugin is no longer loaded.");
    }
  };
  const createdAtMs = Date.now();
  const joins = new Map<
    string,
    { definition: unknown; result: ReturnType<PluginCommandScheduledTurns["schedule"]> }
  >();
  return {
    async schedule(input) {
      // Capture caller-owned values before validation and the first asynchronous boundary.
      // Neither later mutation nor a reused schedule object may change admitted semantics.
      const request = {
        requestId: input.requestId,
        command: input.command,
        args: input.args,
        schedule: { ...input.schedule },
        deadlineAtMs: input.deadlineAtMs,
        maxRuns: input.maxRuns,
      };
      assertCurrent();
      if (
        typeof request.requestId !== "string" ||
        !request.requestId.trim() ||
        request.requestId.length > 256 ||
        typeof request.command !== "string" ||
        !/^[a-z][a-z0-9_-]*$/.test(request.command) ||
        !Number.isSafeInteger(request.deadlineAtMs) ||
        request.deadlineAtMs <= Date.now() ||
        request.deadlineAtMs > createdAtMs + MAX_PLUGIN_COMMAND_SCHEDULE_DURATION_MS ||
        !Number.isSafeInteger(request.maxRuns) ||
        request.maxRuns < 1 ||
        request.maxRuns > 100
      ) {
        throw new Error(
          "Scheduled command requires a bounded requestId, command, deadline and maxRuns.",
        );
      }
      const command = registry.commands.find(
        (entry) => entry.pluginId === params.pluginId && entry.command.name === request.command,
      );
      if (
        !command ||
        command.command.requireAuth !== true ||
        !command.command.runtimeCapabilities?.includes("subagents") ||
        !pluginCommandSupportsChannel(command.command, params.channel) ||
        (request.args !== undefined &&
          (!command.command.acceptsArgs ||
            typeof request.args !== "string" ||
            !request.args.trim() ||
            request.args.length > 32_768))
      ) {
        throw new Error(
          "Scheduled command must be an authenticated native-subagent command of this plugin.",
        );
      }
      let schedule: CronJobCreate["schedule"];
      if (request.schedule?.kind === "at") {
        const at = Date.parse(request.schedule.at);
        if (!Number.isFinite(at) || at <= Date.now() || at >= request.deadlineAtMs) {
          throw new Error("Scheduled command time must precede its deadline.");
        }
        schedule = { kind: "at", at: new Date(at).toISOString() };
      } else if (
        request.schedule?.kind === "every" &&
        Number.isSafeInteger(request.schedule.everyMs) &&
        request.schedule.everyMs >= 1_000 &&
        createdAtMs + request.schedule.everyMs < request.deadlineAtMs
      ) {
        schedule = { kind: "every", everyMs: request.schedule.everyMs, anchorMs: createdAtMs };
      } else {
        throw new Error("Scheduled command requires a bounded at/every schedule.");
      }
      const definition = {
        command: request.command,
        args: request.args,
        schedule,
        deadlineAtMs: request.deadlineAtMs,
        maxRuns: request.maxRuns,
      };
      const previous = joins.get(request.requestId);
      if (previous) {
        if (!isDeepStrictEqual(previous.definition, definition)) {
          throw new Error("Scheduled command requestId was reused with different input.");
        }
        return await previous.result;
      }
      if (joins.size >= MAX_PLUGIN_COMMAND_SCHEDULES_PER_INVOCATION) {
        throw new Error(
          `A command invocation can schedule at most ${MAX_PLUGIN_COMMAND_SCHEDULES_PER_INVOCATION} continuations.`,
        );
      }
      const result = (async () => {
        const surface = await params.tools();
        assertCurrent();
        const automations = surface.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
        if (
          !automations ||
          !surface.some((tool) => tool.name === "sessions_spawn") ||
          !surface.some((tool) => tool.name === "agents_wait")
        ) {
          throw new Error(
            "Native scheduling and subagent tools are not available to this requester.",
          );
        }
        const toolsAllow = surface.map((tool) => tool.name);
        // The whole requester surface is the stored ceiling; refuse it explicitly when it
        // cannot be persisted rather than silently scheduling under a narrower guess.
        if (
          toolsAllow.length > MAX_PLUGIN_COMMAND_SCHEDULE_TOOLS ||
          toolsAllow.some(
            (name) => name.length > 256 || !PLUGIN_COMMAND_SCHEDULE_TOOL_NAME.test(name),
          )
        ) {
          throw new Error(
            `Scheduled command requires a requester tool surface of at most ${MAX_PLUGIN_COMMAND_SCHEDULE_TOOLS} plain tool names.`,
          );
        }
        const envelope = decodePluginCommandSchedule({
          version: 1,
          pluginId: plugin.id,
          pluginIncarnation,
          hostProcessId: currentPluginCommandHostProcessId(),
          pluginSource: plugin.source,
          pluginRoot: plugin.rootDir,
          pluginVersion: plugin.version,
          command: request.command,
          args: request.args,
          channel: params.channel,
          parent: {
            agentId: params.source.options.agentId,
            sessionKey: params.source.options.sessionKey,
            sessionId: params.source.options.sessionId,
            lifecycleRevision: params.source.lifecycleRevision,
          },
          sourceRunId: params.source.options.runId,
          operatorSource,
          toolsAllow,
          deadlineAtMs: request.deadlineAtMs,
          maxRuns: request.maxRuns,
        });
        const declarationKey =
          "plugin-command:" +
          createHash("sha256")
            .update(
              JSON.stringify([
                plugin.id,
                pluginIncarnation,
                envelope.parent.sessionId,
                envelope.parent.lifecycleRevision,
                envelope.sourceRunId,
                request.requestId,
              ]),
            )
            .digest("hex");
        const job: CronJobCreate = {
          name: "/" + request.command,
          agentId: envelope.parent.agentId,
          sessionKey: envelope.parent.sessionKey,
          sessionTarget: `session:${envelope.parent.sessionKey}`,
          declarationKey,
          schedule,
          deleteAfterRun: false,
          enabled: true,
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: PLUGIN_COMMAND_SCHEDULE_MESSAGE, toolsAllow },
          delivery: { mode: "none" },
        };
        const args = { action: "add", job };
        const callId = randomUUID();
        return await params.withCaller(() =>
          runWithToolExecutionValidation(
            callId,
            (adjusted) => {
              assertCurrent();
              if (!isDeepStrictEqual(adjusted, args)) {
                throw new Error(
                  "Scheduled command tool arguments changed after requester admission.",
                );
              }
            },
            () =>
              withPluginCommandScheduleCreation(
                envelope,
                job,
                assertCurrent,
                () => automations.execute(callId, args, params.source.options.abortSignal),
                sourceDigest,
              ),
          ),
        );
      })();
      const entry = { definition, result };
      joins.set(request.requestId, entry);
      try {
        return await result;
      } catch (error) {
        // Concurrent identical calls share this outcome; a later retry may try again. The
        // requestId-derived declaration key makes a retry after an uncertain commit return
        // the same native job instead of creating a second one.
        if (joins.get(request.requestId) === entry) {
          joins.delete(request.requestId);
        }
        throw error;
      }
    },
  };
}
