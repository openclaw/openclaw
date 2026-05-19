import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerPromptBuildHook } from "./hooks/prompt-build.js";
import { registerLifecycleHooks } from "./hooks/lifecycle.js";
import { registerFileWatcher } from "./hooks/file-watcher.js";
import { registerCommands } from "./commands.js";
import { createIntentRouterTool } from "./tools/intent-router.js";
import { createCodexDispatchTool } from "./tools/codex-dispatch.js";
import { createWorkflowTool } from "./tools/workflow.js";
import { createConfirmGateTool } from "./tools/confirm-gate.js";
import { createStatusTool } from "./tools/status.js";
import { registerSuperClawInteractiveHandler } from "./telegram-ui/callback-router.js";

// ── Dashboard (核心：活的戰情面板) ──
export { buildDashboard } from "./telegram-ui/dashboard.js";
export { getSystemState, updateSystemState, setActiveTask, completeTask, addAttentionItem, dismissAttentionItem, getUrgentItems } from "./telegram-ui/agent-state.js";
export type { SystemState, ActiveTask, AttentionItem, AgentPhase } from "./telegram-ui/agent-state.js";

// ── Task Thread (每個任務一條訊息串) ──
export { buildTaskRoot, buildTaskProgress, buildTaskComplete, buildTaskError, buildTaskAwaitingInput } from "./telegram-ui/task-thread.js";

// ── Notifications (分級通知) ──
export { classifyNotificationTier, formatNotificationMessage, shouldSendNewMessage, shouldNotifyWithSound } from "./telegram-ui/notification.js";
export type { NotificationTier, NotificationEvent } from "./telegram-ui/notification.js";

// ── Proactive Suggestions (智能建議) ──
export { generateSuggestions, formatSuggestionMessage } from "./telegram-ui/suggestions.js";

// ── Callback Router (互動處理) ──
export { registerSuperClawInteractiveHandler } from "./telegram-ui/callback-router.js";

// ── Sub-panels (從「更多」進入) ──
export { buildMorePanel } from "./telegram-ui/more-panel.js";
export { buildMainMenu, buildStartMessage } from "./telegram-ui/main-menu.js";
export { buildAgentPanel, buildResetConfirm } from "./telegram-ui/agent-panel.js";
export { buildCronPanel, buildCronRunPicker, buildCronRunResult } from "./telegram-ui/cron-panel.js";
export { buildModelPanel, buildModelSwitchResult } from "./telegram-ui/model-panel.js";
export { buildWorkflowList, buildWorkflowProgress, buildWorkflowDone } from "./telegram-ui/workflow-panel.js";
export { buildDevOpsPanel, buildPRListPanel, buildDeployConfirm } from "./telegram-ui/devops-panel.js";
export { formatProgressMessage, formatStreamChunk, getReactionEmoji } from "./telegram-ui/progress-updater.js";
export { createSubscriptionInvoice, getProFeatures } from "./telegram-ui/payments.js";

// ── Gateway RPC ──
export { GatewayRPC, getGatewayRPC } from "./gateway-rpc.js";

// ── Lifecycle Hooks ──
export { registerLifecycleHooks } from "./hooks/lifecycle.js";

// ── File Watcher (Codex 自動建置) ──
export { registerFileWatcher } from "./hooks/file-watcher.js";

// ── Commands ──
export { registerCommands } from "./commands.js";

// ── Security ──
export { assessRisk, requiresConfirmation, requiresBiometric } from "./security/risk-assessor.js";
export { isAllowedUser, checkRateLimit, getActionPermission } from "./security/permission-manager.js";

// ── DevOps ──
export { verifyGitHubSignature, formatGitHubEvent } from "./devops/github-webhook.js";
export { formatCIStatusBoard } from "./devops/ci-monitor.js";

// ── Multi-Agent ──
export { resolveAgentFromTopic, buildSessionKeyFromTopic, resolveDeliveryTopic } from "./multi-agent/topic-router.js";
export { spawnAgent, listActiveAgents, getAgentOutput, terminateAgent } from "./multi-agent/agent-spawner.js";

// ── User State ──
export { getUserState, setUserMode, trackAction, getQuickActions } from "./telegram-ui/user-state.js";
export type { UserState, UserMode, RecentAction } from "./telegram-ui/user-state.js";

// ── Workflow Types ──
export { WORKFLOW_TEMPLATES } from "./tools/workflow-types.js";
export type { WorkflowDefinition, WorkflowExecution, WorkflowNode, WorkflowEdge } from "./tools/workflow-types.js";

// ── Shared Types ──
export type { InteractiveReply } from "./telegram-ui/types.js";

const WEBAPP_ROUTE_PREFIX = "/superclaw";

function resolveWebAppDistDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(currentDir, "..");
  return path.join(pluginRoot, "dist-webapp");
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function sanitizeSubPath(requestPath: string): string {
  const normalized = requestPath.replace(/\\/g, "/");
  const withoutPrefix = normalized.startsWith(WEBAPP_ROUTE_PREFIX)
    ? normalized.slice(WEBAPP_ROUTE_PREFIX.length)
    : normalized;
  const trimmed = withoutPrefix.replace(/^\/+/, "");
  if (!trimmed || trimmed.endsWith("/")) {
    return "index.html";
  }
  return trimmed;
}

function registerWebAppHttpRoute(api: OpenClawPluginApi): void {
  const webappRoot = resolveWebAppDistDir();

  api.registerHttpRoute({
    path: WEBAPP_ROUTE_PREFIX,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      const requestUrl = req.url ?? WEBAPP_ROUTE_PREFIX;
      const pathname = new URL(requestUrl, "http://local.openclaw").pathname;
      const subPath = sanitizeSubPath(pathname);
      const requestedPath = path.resolve(webappRoot, subPath);

      if (!requestedPath.startsWith(webappRoot)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Forbidden");
        return true;
      }

      let finalPath = requestedPath;
      let body: Buffer | null = null;

      try {
        body = await readFile(finalPath);
      } catch {
        // SPA fallback: unknown route -> index.html
        if (subPath !== "index.html") {
          finalPath = path.join(webappRoot, "index.html");
          try {
            body = await readFile(finalPath);
          } catch {
            res.statusCode = 503;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("Web app bundle not found. Please build webapp first.");
            return true;
          }
        } else {
          res.statusCode = 503;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Web app bundle not found. Please build webapp first.");
          return true;
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", inferContentType(finalPath));
      res.end(body);
      return true;
    },
  });
}

export function registerAutomationPlugin(api: OpenClawPluginApi) {
  registerPromptBuildHook(api);
  registerLifecycleHooks(api);
  registerFileWatcher(api);
  registerCommands(api);
  registerSuperClawInteractiveHandler(api);
  registerWebAppHttpRoute(api);

  api.registerTool(createIntentRouterTool(api), { names: ["automation_classify_intent"] });
  api.registerTool(createCodexDispatchTool(api), { names: ["automation_codex_execute"] });
  api.registerTool(createWorkflowTool(api), { names: ["automation_workflow"] });
  api.registerTool(createConfirmGateTool(api), { names: ["automation_confirm_gate"] });
  api.registerTool(createStatusTool(api), { names: ["automation_status"] });
}
