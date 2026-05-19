import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getSystemState, setActiveTask, completeTask, dismissAttentionItem } from "./agent-state.js";
import { buildDashboard } from "./dashboard.js";
import {
  buildTaskRoot,
  buildTaskComplete,
  buildTaskError,
  buildTaskAwaitingInput,
} from "./task-thread.js";
import { buildMorePanel } from "./more-panel.js";
import { buildWorkflowList } from "./workflow-panel.js";
import { buildCronPanel, buildCronRunPicker } from "./cron-panel.js";
import { buildModelPanel, buildModelSwitchResult } from "./model-panel.js";
import { buildAgentPanel, buildResetConfirm } from "./agent-panel.js";
import { buildDevOpsPanel, buildPRListPanel, buildDeployConfirm } from "./devops-panel.js";
import { generateSuggestions } from "./suggestions.js";
import { trackAction } from "./user-state.js";
import { getGatewayRPC } from "../gateway-rpc.js";
import type { InteractiveReply } from "./types.js";

const NAMESPACE = "sc";

export function registerSuperClawInteractiveHandler(api: OpenClawPluginApi) {
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: NAMESPACE,
    handler: async (ctx: any) => {
      const userId = Number(ctx.senderId) || 0;
      const payload = ctx.callback.payload;
      const parts = payload.split(":");
      const [action, sub, param] = parts;

      const respond = ctx.respond;

      const editPanel = async (panel: InteractiveReply) => {
        const text = panel.blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const buttonBlocks = panel.blocks.filter(
          (b): b is { type: "buttons"; buttons: any[] } => b.type === "buttons",
        );
        const buttons = buttonBlocks.map((b) =>
          b.buttons.map((btn: any) => ({
            text: btn.label,
            callback_data: btn.value,
          })),
        );
        await respond.editMessage({ text, buttons, textMode: "html" });
      };

      try {
        switch (action) {
          // ── Dashboard (home) ──
          case "home": {
            const state = getSystemState();
            await editPanel(buildDashboard(state));
            break;
          }

          // ── Primary actions (from dashboard) ──
          case "ask": {
            trackAction(userId, "對話", "sc:ask");
            await respond.editMessage({
              text:
                "💬 <b>對話模式</b>\n\n直接打字，Claude 會回覆。\n語音、圖片、檔案都能處理。\n\n<i>輸入任何訊息開始...</i>",
              textMode: "html",
            });
            break;
          }

          case "code": {
            trackAction(userId, "寫碼", "sc:code");
            await respond.editMessage({
              text:
                "💻 <b>程式碼模式</b>\n\n輸入你要做的事，Codex 會執行：\n\n" +
                "<i>→ 重構 auth module 改用 JWT</i>\n" +
                "<i>→ 修復 login 頁面的 bug</i>\n" +
                "<i>→ 幫我寫測試</i>",
              textMode: "html",
            });
            break;
          }

          // ── Task lifecycle ──
          case "detail": {
            const state = getSystemState();
            if (state.activeTask) {
              const t = state.activeTask;
              const elapsed = Date.now() - t.startedAt;
              await respond.reply({
                text:
                  `📋 <b>任務詳情</b>\n\n` +
                  `ID: <code>${t.id}</code>\n` +
                  `Agent: ${t.agent}\n` +
                  `階段: ${t.phase}\n` +
                  `進度: ${t.stepCurrent}/${t.stepTotal}\n` +
                  `耗時: ${(elapsed / 1000).toFixed(0)}s\n` +
                  `動作: ${t.currentAction}`,
                textMode: "html",
              });
            }
            break;
          }

          case "pause":
            await respond.editMessage({ text: "⏸ 已暫停任務。\n\n輸入任何訊息繼續。" });
            break;

          case "kill":
            completeTask(false);
            await editPanel(buildDashboard(getSystemState()));
            break;

          case "retry": {
            await respond.editMessage({ text: "🔄 重新嘗試中..." });
            break;
          }

          case "skip": {
            if (sub) dismissAttentionItem(sub);
            await editPanel(buildDashboard(getSystemState()));
            break;
          }

          case "approve": {
            if (sub) {
              await respond.editMessage({ text: `✅ 已批准 — 繼續執行中...` });
            }
            break;
          }

          case "deny": {
            if (sub) {
              completeTask(false);
              await respond.editMessage({ text: `❌ 已拒絕 — 任務已取消` });
            }
            break;
          }

          case "errlog": {
            await respond.reply({
              text: "📋 <b>錯誤日誌</b>\n\n<code>(錯誤詳情將在此顯示)</code>",
              textMode: "html",
            });
            break;
          }

          // ── Do actions (proactive suggestions) ──
          case "do": {
            const actionMap: Record<string, string> = {
              test: "🧪 執行測試中...",
              commit: "📝 準備提交...",
              pr: "🚀 建立 PR 中...",
              push: "📤 Push 中...",
              merge: "✅ 合併中...",
              scan: "📊 掃描專案中...",
              cleanup: "🧹 程式碼清理中...",
              "analyze-ci": "🔍 分析 CI 失敗中...",
              review: "📋 開始 Code Review...",
              verify: "🔍 驗證部署中...",
              monitor: "📊 開始監控...",
            };
            const msg = actionMap[sub ?? ""] ?? `🔄 執行 ${sub} 中...`;
            trackAction(userId, msg.slice(2), `sc:do:${sub}`);
            await respond.editMessage({ text: msg });
            break;
          }

          // ── More panel ──
          case "more":
            await editPanel(buildMorePanel());
            break;

          // ── Sub-panels (accessed from "More") ──
          case "wf":
            if (!sub) {
              trackAction(userId, "工作流", "sc:wf");
              await editPanel(buildWorkflowList());
            } else if (sub === "run" && param) {
              trackAction(userId, `▶️ ${param}`, `sc:wf:run:${param}`);
              await respond.editMessage({ text: `🔄 啟動工作流 <b>${param}</b>...`, textMode: "html" });
            } else if (sub === "stop" && param) {
              await respond.editMessage({ text: "⏹ 工作流已取消" });
            }
            break;

          case "cron":
            trackAction(userId, "排程", "sc:cron");
            await editPanel(buildCronPanel(await fetchCronJobs(api)));
            break;

          case "cr":
            await handleCron(sub, param, api, respond, editPanel, userId);
            break;

          case "model":
            trackAction(userId, "模型", "sc:model");
            await editPanel(buildModelPanel(await fetchModels(api), await fetchCurrentModel(api)));
            break;

          case "md":
            if (sub === "sw" && param) {
              trackAction(userId, `模型→${param}`, `sc:md:sw:${param}`);
              await respond.editMessage({ text: "🔄 切換模型中..." });
              try {
                await switchModel(api, param);
                await editPanel(buildModelSwitchResult(param, true));
              } catch {
                await editPanel(buildModelSwitchResult(param, false));
              }
            }
            break;

          case "agents":
            trackAction(userId, "Agent", "sc:agents");
            await editPanel(buildAgentPanel(await fetchAgents(api), await fetchActiveAgentId(api)));
            break;

          case "ag":
            await handleAgent(sub, param, api, respond, editPanel);
            break;

          case "devops":
            trackAction(userId, "DevOps", "sc:devops");
            await editPanel(buildDevOpsPanel(await fetchCIStatuses(api)));
            break;

          case "dv":
            await handleDevOps(sub, param, api, respond, editPanel, userId);
            break;

          case "history":
            await respond.reply({ text: "📜 <b>對話歷史</b>\n\n(最近 10 輪)", textMode: "html" });
            break;

          case "reset":
            await editPanel(buildResetConfirm("main"));
            break;

          case "dash":
            break;

          case "build": {
            trackAction(userId, "建置狀態", "sc:build");
            try {
              const status: any = await api.runtime.gateway.call("automation.codex.taskStatus");
              const text =
                `🔨 <b>Codex 自動建置</b>\n\n` +
                `總任務: ${status.total}\n` +
                `✅ 完成: ${status.done}\n` +
                `⏳ 待執行: ${status.pending}\n` +
                `${status.isProcessing ? "🔄 正在執行中..." : "💤 閒置"}\n` +
                (status.nextTask ? `\n下一個: <code>${escapeHtml(status.nextTask.slice(0, 100))}</code>` : "");
              await respond.editMessage({
                text,
                textMode: "html",
                buttons: [
                  [
                    { text: "▶️ 執行下一個", callback_data: "sc:buildrun" },
                    { text: "🔄 刷新", callback_data: "sc:build" },
                  ],
                  [{ text: "← 返回", callback_data: "sc:home" }],
                ],
              });
            } catch {
              await respond.editMessage({
                text: "🔨 <b>Codex 建置</b>\n\n無法取得狀態",
                textMode: "html",
                buttons: [[{ text: "← 返回", callback_data: "sc:home" }]],
              });
            }
            break;
          }

          case "buildrun": {
            trackAction(userId, "觸發建置", "sc:buildrun");
            try {
              const result: any = await api.runtime.gateway.call("automation.codex.runNextTask");
              await respond.editMessage({
                text: `🔄 ${escapeHtml(result.message ?? "已觸發")}`,
                buttons: [
                  [
                    { text: "📊 查看狀態", callback_data: "sc:build" },
                    { text: "← 返回", callback_data: "sc:home" },
                  ],
                ],
              });
            } catch {
              await respond.editMessage({ text: "❌ 觸發失敗" });
            }
            break;
          }

          default:
            await respond.editMessage({ text: "❓ 未知操作" });
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        await respond.editMessage({
          text: `❌ <b>操作失敗</b>\n\n<code>${escapeHtml(msg.slice(0, 200))}</code>`,
          textMode: "html",
          buttons: [
            [
              { text: "🔄 重試", callback_data: `sc:${payload}` },
              { text: "← 回首頁", callback_data: "sc:home" },
            ],
          ],
        });
      }
    },
  });
}

async function handleCron(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: any,
  editPanel: (p: InteractiveReply) => Promise<void>,
  userId: number,
) {
  switch (sub) {
    case "tg":
      if (param) {
        const jobs = await fetchCronJobs(api);
        const job = jobs.find((j: any) => j.id === param);
        if (job) {
          await toggleCronJob(api, param, !job.enabled);
          trackAction(userId, `${!job.enabled ? "▶️" : "⏸"} ${param}`, `sc:cr:tg:${param}`);
          await editPanel(buildCronPanel(await fetchCronJobs(api)));
        }
      }
      break;
    case "pick":
      await editPanel(buildCronRunPicker(await fetchCronJobs(api)));
      break;
    case "run":
      if (param) {
        trackAction(userId, `執行 ${param}`, `sc:cr:run:${param}`);
        await respond.editMessage({ text: `▶️ 執行 <b>${param}</b> 中...`, textMode: "html" });
      }
      break;
  }
}

async function handleAgent(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: any,
  editPanel: (p: InteractiveReply) => Promise<void>,
) {
  switch (sub) {
    case "sw":
      if (param) {
        await switchAgent(api, param);
        await editPanel(buildAgentPanel(await fetchAgents(api), param));
      }
      break;
    case "rst":
      if (!param) {
        await editPanel(buildResetConfirm("main"));
      } else if (param === "yes") {
        await resetSession(api);
        await respond.editMessage({ text: "✅ 對話已重置" });
      }
      break;
  }
}

async function handleDevOps(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: any,
  editPanel: (p: InteractiveReply) => Promise<void>,
  userId: number,
) {
  switch (sub) {
    case "ref":
      trackAction(userId, "CI 刷新", "sc:dv:ref");
      await editPanel(buildDevOpsPanel(await fetchCIStatuses(api)));
      break;
    case "prs":
      await editPanel(buildPRListPanel(await fetchPRs(api)));
      break;
    case "rv":
      if (param) {
        trackAction(userId, `Review #${param}`, `sc:dv:rv:${param}`);
        await respond.editMessage({ text: `🔍 啟動 Code Review — PR #${param}...`, textMode: "html" });
      }
      break;
    case "dep":
      if (param) {
        await editPanel(buildDeployConfirm(param));
      }
      break;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Gateway RPC (real implementations via GatewayRPC class) ──

function rpc(api: OpenClawPluginApi) {
  return getGatewayRPC(api);
}

async function fetchCronJobs(api: OpenClawPluginApi) {
  return rpc(api).fetchCronJobs();
}

async function fetchModels(api: OpenClawPluginApi) {
  return rpc(api).fetchModels();
}

async function fetchCurrentModel(api: OpenClawPluginApi) {
  return rpc(api).fetchCurrentModel();
}

async function fetchAgents(api: OpenClawPluginApi) {
  return rpc(api).fetchAgents();
}

async function fetchActiveAgentId(api: OpenClawPluginApi) {
  return rpc(api).fetchActiveAgentId();
}

async function fetchCIStatuses(api: OpenClawPluginApi) {
  try {
    const statuses: any[] = await api.runtime.gateway.call("ci.statuses");
    return statuses.map((s) => ({
      provider: (s.provider ?? "github-actions") as "github-actions" | "gitlab-ci" | "other",
      repo: s.repo ?? s.repository ?? "unknown",
      branch: s.branch ?? "main",
      status: (s.status ?? "pending") as "success" | "failure" | "pending" | "running",
      url: s.url ?? "",
      updatedAt: s.updatedAt ?? Date.now(),
    }));
  } catch {
    return [];
  }
}

async function fetchPRs(api: OpenClawPluginApi) {
  try {
    const prs: any[] = await api.runtime.gateway.call("github.prs.list");
    return prs.map((pr) => ({
      number: pr.number as number,
      title: (pr.title ?? `PR #${pr.number}`) as string,
      state: (pr.state ?? "open") as string,
      draft: (pr.draft ?? false) as boolean,
    }));
  } catch {
    return [];
  }
}

async function switchModel(api: OpenClawPluginApi, id: string) {
  return rpc(api).switchModel(id);
}

async function switchAgent(api: OpenClawPluginApi, id: string) {
  return rpc(api).switchAgent(id);
}

async function resetSession(api: OpenClawPluginApi) {
  return rpc(api).resetSession();
}

async function toggleCronJob(api: OpenClawPluginApi, id: string, enabled: boolean) {
  return rpc(api).toggleCronJob(id, enabled);
}
