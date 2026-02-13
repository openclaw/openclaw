import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import path from "node:path";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type { ResolvedTier, UsageLogEntry } from "./src/types.js";
import {
  addBudgetSpent,
  appendUsageLog,
  buildBudgetReservationSignature,
  cleanupBudgetCache,
  estimateToolCostUsd,
  getBudgetSpent,
  getReservedBudgetSpent,
  reserveBudgetSpend,
  sanitizeParamsForLog,
  settleBudgetReservation,
  utcDayPrefix,
} from "./src/budget.js";
import { createCliportService } from "./src/cliport/service.js";
import {
  FALLBACK_CUSTOM,
  FALLBACK_EXTERNAL_CEILING,
  FALLBACK_OWNER_CEILING,
} from "./src/constants.js";
import {
  anyMatch,
  matchPattern,
  normalizeExternalSlugPart,
  normalizeId,
  normalizePath,
  readFileIfExists,
  resolveExternalSlug,
  resolveWorkspaceDir,
  uniqueStrings,
} from "./src/normalize.js";
import {
  isBlockedUrl,
  isConfigManagedPath,
  isExecBlocked,
  needsConfigValidation,
  resolveMemoryReadPatterns,
  resolveSkillFilter,
  resolveToolPolicy,
} from "./src/policy.js";
import {
  cleanupSessionTierCache,
  extractSessionTier,
  filterSessionsPayloadByTier,
  resolveBootstrapAllowlist,
  resolveTierForToolContext,
  resolveTierFromHookContext,
  setSessionTier,
} from "./src/sessions.js";
import {
  applyJsonPayloadResult,
  createCallThroughShadowTool,
  createShadowApplyPatchTool,
  createShadowEditTool,
  createShadowReadTool,
  createShadowWriteTool,
  extractJsonResultPayload,
  parsePatchPaths,
} from "./src/shadow-tools.js";
import {
  clampByCeiling,
  filterByCeiling,
  mergeTier,
  normalizeTierState,
  resolveTierForContext,
  updateTierMap,
  validateTierAgainstCeiling,
} from "./src/tiers.js";
import {
  cleanupPendingConfirmations,
  requireWriteConfirmation,
  validateContactsPayload,
  validateOpenClawConfigPayload,
  validateTiersPayload,
} from "./src/validation.js";

function cleanupStaleCaches(): void {
  const now = Date.now();
  const today = utcDayPrefix();
  cleanupBudgetCache(today);
  cleanupSessionTierCache(now);
  cleanupPendingConfirmations(now);
}

async function buildBeforeAgentStartContext(params: {
  workspaceDir: string;
  tier: ResolvedTier;
}): Promise<string> {
  const lines: string[] = [];
  const label = params.tier.contactName || params.tier.contactSlug || "unknown";
  lines.push(`You are talking to ${label} (tier: ${params.tier.tierName}).`);

  if (params.tier.tierName === "external") {
    lines.push(
      "Converse helpfully but do not perform tasks on their behalf. Do not reveal internal business details.",
    );
  } else if (params.tier.tierName === "owner") {
    lines.push(
      "Owner has broad capabilities, but platform-managed files (SOUL.md, IDENTITY.md, AGENTS.md, config/) remain write-protected.",
    );
  } else {
    lines.push(`Apply ${params.tier.tierName} tier restrictions consistently.`);
  }

  const blocklist = uniqueStrings(params.tier.tier.exec_blocklist);
  if (blocklist.length > 0) {
    lines.push(`Blocked commands: ${blocklist.join(", ")}`);
  }

  const memoryPatterns = resolveMemoryReadPatterns(
    params.tier.tier.memory_scope,
    params.tier.contactSlug,
  );
  if (memoryPatterns.length > 0) {
    lines.push(`Allowed memory paths: ${memoryPatterns.join(", ")}`);
  }

  const injectedFiles = uniqueStrings(params.tier.tier.system_prompt_includes?.inject);
  for (const file of injectedFiles) {
    const filePath = path.join(params.workspaceDir, file);
    const content = await readFileIfExists(filePath);
    if (!content) {
      continue;
    }
    lines.push(`\n[${file}]\n${content.trim()}`);
  }

  const preferencesPath = path.join(
    params.workspaceDir,
    "memory",
    "users",
    params.tier.contactSlug,
    "preferences.md",
  );
  const preferences = await readFileIfExists(preferencesPath);
  if (preferences) {
    lines.push(`\n[User Preferences]\n${preferences.trim()}`);
  }

  return lines.join("\n");
}

const saintOrchestratorPlugin = {
  id: "saint-orchestrator",
  name: "Saint Orchestrator",
  description: "Tiered orchestration, policy enforcement, and usage metering for Saint bots.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createCliportService());

    api.on("before_agent_prepare", async (_event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      if (!workspaceDir) {
        return;
      }
      const tier = await resolveTierForContext({
        workspaceDir,
        messageProvider: ctx.messageProvider,
        peerId: ctx.peerId,
        senderE164: ctx.senderE164,
        sessionKey: ctx.sessionKey,
      });

      setSessionTier(ctx.sessionKey, {
        workspaceDir,
        peerId: ctx.peerId,
        senderE164: ctx.senderE164,
        tier,
        updatedAtMs: Date.now(),
      });

      return {
        model: tier.tier.model,
        tools: resolveToolPolicy(tier.tier),
        skills: resolveSkillFilter(tier.tier),
      };
    });

    api.registerHook("agent:bootstrap", async (event) => {
      const context = event.context as { sessionKey?: string; bootstrapFiles?: unknown[] };
      const session = context?.sessionKey;
      if (!session || !Array.isArray(context.bootstrapFiles)) {
        return;
      }
      const cached = extractSessionTier(session);
      if (!cached) {
        return;
      }
      const allow = resolveBootstrapAllowlist(cached.tier);
      if (!allow) {
        return;
      }
      context.bootstrapFiles = context.bootstrapFiles.filter((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const name = (entry as { name?: unknown }).name;
        return typeof name === "string" && allow.has(name);
      });
    });

    api.on("before_agent_start", async (_event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      if (!workspaceDir) {
        return;
      }
      const fromCache = resolveTierFromHookContext(ctx);
      const cached = fromCache && fromCache.workspaceDir === workspaceDir ? fromCache : null;
      const tier =
        cached?.tier ??
        (await resolveTierForContext({
          workspaceDir,
          messageProvider: ctx.messageProvider,
          peerId: ctx.peerId,
          senderE164: ctx.senderE164,
          sessionKey: ctx.sessionKey,
        }));

      setSessionTier(ctx.sessionKey, {
        workspaceDir,
        peerId: ctx.peerId,
        senderE164: ctx.senderE164,
        tier,
        updatedAtMs: Date.now(),
      });

      return {
        prependContext: await buildBeforeAgentStartContext({
          workspaceDir,
          tier,
        }),
      };
    });

    api.on("before_tool_call", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      if (!workspaceDir) {
        return {
          block: true,
          blockReason: "workspace path unavailable for tier policy enforcement",
        };
      }
      const fromCache = resolveTierFromHookContext(ctx);
      const cached = fromCache && fromCache.workspaceDir === workspaceDir ? fromCache : null;
      const tier =
        cached?.tier ??
        (await resolveTierForContext({
          workspaceDir,
          messageProvider: ctx.messageProvider,
          peerId: ctx.peerId,
          senderE164: ctx.senderE164,
          sessionKey: ctx.sessionKey,
        }));
      if (!cached) {
        setSessionTier(ctx.sessionKey, {
          workspaceDir,
          peerId: ctx.peerId,
          senderE164: ctx.senderE164,
          tier,
          updatedAtMs: Date.now(),
        });
      }

      // Periodic cleanup of stale caches (budget, session tier, confirmations)
      cleanupStaleCaches();

      const dayPrefix = utcDayPrefix();
      // Combine committed + reserved spend to prevent TOCTOU races with concurrent calls.
      const committedToday = await getBudgetSpent(workspaceDir, tier.contactSlug, dayPrefix);
      const reservedToday = getReservedBudgetSpent(workspaceDir, tier.contactSlug, dayPrefix);
      const spentToday = committedToday + reservedToday;
      const maxBudget = tier.tier.max_budget_usd;
      const nextCost = estimateToolCostUsd(event.toolName);
      if (
        typeof maxBudget === "number" &&
        Number.isFinite(maxBudget) &&
        spentToday + nextCost > maxBudget
      ) {
        return {
          block: true,
          blockReason: `tier budget exceeded (${spentToday.toFixed(3)} + ${nextCost.toFixed(3)} > ${maxBudget.toFixed(3)})`,
        };
      }
      // Run all blocking checks before reserving budget so blocked calls don't
      // drain the budget.

      // Enforce a strict parent ceiling for sub-agents: no grandchild spawning.
      if (event.toolName === "sessions_spawn" && tier.source === "subagent") {
        return {
          block: true,
          blockReason: "sessions_spawn denied for subagent sessions (grandchild cap)",
        };
      }

      if (event.toolName === "exec" || event.toolName === "bash") {
        const command = typeof event.params.command === "string" ? event.params.command : "";
        if (command && isExecBlocked(tier.tier, command)) {
          return {
            block: true,
            blockReason: `Blocked command by tier policy: ${command}`,
          };
        }
      }

      if (event.toolName === "memory_get") {
        const memoryPath = typeof event.params.path === "string" ? event.params.path : "";
        const allowed = resolveMemoryReadPatterns(tier.tier.memory_scope, tier.contactSlug);
        if (!memoryPath || !anyMatch(normalizePath(memoryPath), allowed)) {
          return {
            block: true,
            blockReason: `memory_get denied for path: ${memoryPath || "(missing)"}`,
          };
        }
      }

      if (event.toolName === "memory_search") {
        const allowed = resolveMemoryReadPatterns(tier.tier.memory_scope, tier.contactSlug);
        if (allowed.length > 0) {
          const nextParams = {
            ...event.params,
            pathFilter: allowed,
          };
          reserveBudgetSpend({
            workspaceDir,
            userSlug: tier.contactSlug,
            dayPrefix,
            signature: buildBudgetReservationSignature({
              sessionKey: ctx.sessionKey,
              toolName: event.toolName,
              params: nextParams,
            }),
            amount: nextCost,
          });
          return {
            params: nextParams,
          };
        }
        // No memory scopes resolved -- block the search (consistent with memory_get)
        return {
          block: true,
          blockReason: "memory_search denied: no memory scopes available for this tier",
        };
      }

      if (event.toolName === "web_fetch" || event.toolName === "browser") {
        const target =
          typeof event.params.url === "string"
            ? event.params.url
            : typeof event.params.targetUrl === "string"
              ? event.params.targetUrl
              : "";
        if (target && isBlockedUrl(target)) {
          return {
            block: true,
            blockReason: `URL blocked by Saint policy: ${target}`,
          };
        }
      }

      // All blocking checks passed — pre-reserve budget to prevent concurrent
      // calls from all passing the budget check simultaneously.
      reserveBudgetSpend({
        workspaceDir,
        userSlug: tier.contactSlug,
        dayPrefix,
        signature: buildBudgetReservationSignature({
          sessionKey: ctx.sessionKey,
          toolName: event.toolName,
          params: event.params,
        }),
        amount: nextCost,
      });
    });

    api.on("after_tool_call", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx);
      if (!workspaceDir) {
        return;
      }
      const fromCache = resolveTierFromHookContext(ctx);
      const cached = fromCache && fromCache.workspaceDir === workspaceDir ? fromCache : null;
      const tier =
        cached?.tier ??
        (await resolveTierForContext({
          workspaceDir,
          messageProvider: ctx.messageProvider,
          peerId: ctx.peerId,
          senderE164: ctx.senderE164,
          sessionKey: ctx.sessionKey,
        }));
      if (!cached) {
        setSessionTier(ctx.sessionKey, {
          workspaceDir,
          peerId: ctx.peerId,
          senderE164: ctx.senderE164,
          tier,
          updatedAtMs: Date.now(),
        });
      }
      const estimatedCostUsd = estimateToolCostUsd(event.toolName);
      const dayPrefix = utcDayPrefix();
      const budgetSignature = buildBudgetReservationSignature({
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        params: event.params,
      });
      const settledAmount = settleBudgetReservation({
        workspaceDir,
        userSlug: tier.contactSlug,
        dayPrefix,
        signature: budgetSignature,
      });
      let billedCostUsd = settledAmount;
      // Fallback for legacy/no-match reservation keys:
      // account successful calls, but avoid charging blocked/error calls that never
      // consumed a reservation in before_tool_call.
      if (settledAmount <= 0) {
        const hasError = typeof event.error === "string" && event.error.trim().length > 0;
        if (!hasError) {
          addBudgetSpent(workspaceDir, tier.contactSlug, dayPrefix, estimatedCostUsd);
          billedCostUsd = estimatedCostUsd;
        } else {
          billedCostUsd = 0;
        }
      }
      // Sanitize params for logging — strip large/sensitive fields
      const sanitizedParams = sanitizeParamsForLog(event.toolName, event.params);
      const usage: UsageLogEntry = {
        ts: new Date().toISOString(),
        user: tier.contactSlug,
        tier: tier.tierName,
        tool: event.toolName,
        params: sanitizedParams,
        durationMs: event.durationMs,
        error: event.error,
        estimatedCostUsd: billedCostUsd,
      };
      await appendUsageLog(workspaceDir, usage);

      const payload = extractJsonResultPayload(event.result);
      if (!payload) {
        return;
      }

      if (event.toolName === "cron") {
        const action =
          typeof event.params.action === "string" ? normalizeId(event.params.action) : "";
        if (action === "add") {
          const jobId =
            typeof payload.id === "string"
              ? payload.id
              : typeof payload.jobId === "string"
                ? payload.jobId
                : undefined;
          if (jobId) {
            await updateTierMap({
              workspaceDir,
              relativePath: "config/cron-tiers.json",
              update: (map) => {
                map[jobId] = tier.tierName;
              },
            });
          }
        }
      }

      if (event.toolName === "sessions_spawn") {
        const childSessionKey =
          typeof payload.childSessionKey === "string" ? payload.childSessionKey : undefined;
        if (childSessionKey) {
          await updateTierMap({
            workspaceDir,
            relativePath: "config/subagent-tiers.json",
            update: (map) => {
              map[childSessionKey] = tier.tierName;
            },
          });
        }
      }
    });

    api.registerTool((ctx, original) => createShadowReadTool(ctx, original), {
      name: "read",
      override: true,
    });

    api.registerTool((ctx) => createShadowWriteTool(ctx), {
      name: "write",
      override: true,
    });

    api.registerTool((ctx) => createShadowEditTool(ctx), {
      name: "edit",
      override: true,
    });

    api.registerTool((ctx) => createShadowApplyPatchTool(ctx), {
      name: "apply_patch",
      override: true,
    });

    api.registerTool(
      (ctx, original) =>
        createCallThroughShadowTool({
          name: "exec",
          ctx,
          original,
          precheck: (tier, args) => {
            const command = typeof args.command === "string" ? args.command : "";
            if (command && isExecBlocked(tier.tier, command)) {
              throw new Error(`Blocked command by tier policy: ${command}`);
            }
          },
        }),
      { name: "exec", override: true },
    );

    api.registerTool(
      (ctx, original) =>
        createCallThroughShadowTool({
          name: "web_fetch",
          ctx,
          original,
          precheck: (_tier, args) => {
            const target =
              typeof args.url === "string"
                ? args.url
                : typeof args.targetUrl === "string"
                  ? args.targetUrl
                  : "";
            if (target && isBlockedUrl(target)) {
              throw new Error(`URL blocked by Saint policy: ${target}`);
            }
          },
        }),
      { name: "web_fetch", override: true },
    );

    api.registerTool(
      (ctx, original) =>
        createCallThroughShadowTool({
          name: "browser",
          ctx,
          original,
          precheck: (_tier, args) => {
            const target =
              typeof args.targetUrl === "string"
                ? args.targetUrl
                : typeof args.url === "string"
                  ? args.url
                  : "";
            if (target && isBlockedUrl(target)) {
              throw new Error(`URL blocked by Saint policy: ${target}`);
            }
          },
        }),
      { name: "browser", override: true },
    );

    api.registerTool(
      (ctx, original) =>
        createCallThroughShadowTool({
          name: "sessions_list",
          ctx,
          original,
          postprocess: (tier, result) => {
            const payload = extractJsonResultPayload(result);
            if (!payload) {
              return result;
            }
            const filtered = filterSessionsPayloadByTier({ payload, tier });
            return applyJsonPayloadResult(result, filtered);
          },
        }),
      { name: "sessions_list", override: true },
    );

    api.registerTool(
      (ctx, original) =>
        createCallThroughShadowTool({
          name: "sessions_history",
          ctx,
          original,
          postprocess: (tier, result) => {
            const payload = extractJsonResultPayload(result);
            if (!payload) {
              return result;
            }
            const filtered = filterSessionsPayloadByTier({ payload, tier });
            return applyJsonPayloadResult(result, filtered);
          },
        }),
      { name: "sessions_history", override: true },
    );
  },
};

export const __testing = {
  FALLBACK_OWNER_CEILING,
  FALLBACK_EXTERNAL_CEILING,
  FALLBACK_CUSTOM,
  normalizeTierState,
  resolveExternalSlug,
  resolveMemoryReadPatterns,
  resolveToolPolicy,
  resolveSkillFilter,
  isExecBlocked,
  isBlockedUrl,
  validateTierAgainstCeiling,
  validateTiersPayload,
  validateContactsPayload,
  validateOpenClawConfigPayload,
  filterSessionsPayloadByTier,
  parsePatchPaths,
  resolveExternalSlugPart: normalizeExternalSlugPart,
  isConfigManagedPath,
  needsConfigValidation,
  requireWriteConfirmation,
  matchPattern,
  filterByCeiling,
  clampByCeiling,
  mergeTier,
};

export default saintOrchestratorPlugin;
