# nuwa AI Agent Mesh — Codex 待完成任務清單

> 工作目錄：`extensions/evolution-learning/`（pnpm workspace `@openclaw/evolution-learning`）
> 語言：TypeScript ESM（`"type": "module"`），Node.js v24，better-sqlite3 v12
> 所有程式碼、變數、函數名稱用英文，**所有註解用繁體中文**

---

## 任務 1：修正 `debates` 表 schema 欄位不符

**問題**：`src/dmad-debate.ts` 寫入 debates 表時使用以下欄位：
`rounds_json, stopped_by, pattern_slugs_used, estimated_cost_usd, completed_at`

但 `src/db.ts` 裡的 `debates` 表 schema（約第 146 行）沒有這些欄位，只有：
`id, conversation_id, task, rounds, final_answer, participants, convergence_score, rounds_count, started_at, ended_at`

**修正方式**：在 `src/db.ts` 的 `debates` CREATE TABLE 語句中補加欄位：

```sql
  rounds_json TEXT NOT NULL DEFAULT '[]',   -- JSON 格式的完整輪次紀錄（取代 rounds）
  stopped_by TEXT,                           -- "convergence" | "variance" | "max_rounds"
  pattern_slugs_used TEXT DEFAULT '[]',      -- JSON 陣列，被激活的 pattern slugs
  estimated_cost_usd REAL DEFAULT 0,         -- 費用估算
  completed_at TEXT                          -- 完成時間（與 ended_at 二選一，保留兩者）
```

同時更新 `src/migrate.ts`：確保 `debates` 表的遷移在舊版 DB 上也能新增這些欄位（用 `ALTER TABLE IF NOT EXISTS column` 或重建邏輯）。

---

## 任務 2：`nuwa debate` CLI 接入真實 `runDMAD()`

**檔案**：`src/cli.ts`，函數 `cmdDebate`（約第 962 行）

**現況**：只印說明文字，不執行任何辯論。

**修正**：改寫 `cmdDebate` 函數，實際呼叫 `runDMAD()`：

```typescript
import { runDMAD } from "./dmad-debate.js";

export async function cmdDebate(
  topic: string,
  opts: { workspace?: string; rounds?: number; model?: string; noMoa?: boolean },
): Promise<void> {
  const stateDir = resolveStateDir(opts.workspace);
  const db = openDb(stateDir);

  console.log(`🗣️  DMAD 三代理辯論啟動...`);
  console.log(`主題：${topic}`);
  console.log(`最多輪次：${opts.rounds ?? 3}`);
  console.log();

  const result = await runDMAD(topic, db.local, {
    maxRounds: opts.rounds ?? 3,
    claudeModel: opts.model ?? "claude-haiku-4-5",
  });

  console.log(`\n✅ 辯論完成（${result.totalRounds} 輪，停止原因：${result.stoppedBy}）`);
  console.log(`收斂分：${result.convergenceScore.toFixed(2)}`);
  console.log(`費用估算：$${result.estimatedCostUsd}`);
  console.log(`激活 patterns：${result.patternSlugsUsed.join(", ") || "無"}`);
  console.log(`\n## MoA 最終答案`);
  console.log(result.finalAnswer);

  db.local.close();
}
```

同時修正 REPL 的 `/debate <topic>` 指令（`cmdChat` 函數，約第 944 行）：

```typescript
} else if (trimmed.startsWith("/debate ")) {
  const topic = trimmed.slice(8).trim()
  if (!topic) { console.log("用法：/debate <主題>"); ask(); return }
  console.log(`🗣️ 觸發辯論：${topic}`)
  const db = openDb(stateDir)
  runDMAD(topic, db.local, { maxRounds: 3 })
    .then(r => {
      console.log(`\n✅ 辯論完成\n## 最終答案\n${r.finalAnswer}`)
      db.local.close()
      ask()
    })
    .catch(e => { console.error("辯論失敗：", e); db.local.close(); ask() })
  return  // 不呼叫 ask()，等 Promise 完成
```

---

## 任務 3：補 MCP 工具 `run_cognitive_cycle`

**檔案**：`mcp/server.ts`

`src/cognitive-cycle.ts` 已完整實作 `runCognitiveCycle()`，但 MCP server 沒有對應工具。
在 `check_risk_gate`（工具 27）**之前**插入工具 `run_cognitive_cycle`（工具 27，其他順延）：

```typescript
// ── 工具 27：run_cognitive_cycle（ABCD 統合認知迴圈）─────────────────
server.registerTool(
  "run_cognitive_cycle",
  {
    title: "ABCD 統合認知迴圈",
    description:
      "執行完整 ABCD 四層認知迴圈：D(憲法同步) → C(GoT圖思維) → B(MAR多角色反思) → MoA聚合。" +
      "回傳所有 promptText 供 MCP 依序呼叫 Claude 填入結果。",
    inputSchema: {
      task: z.string().describe("任務描述"),
      taskType: z
        .enum([
          "architecture",
          "security",
          "cost_optimization",
          "code_quality",
          "agent_design",
          "general",
        ])
        .describe("任務類型"),
      proposal: z.string().describe("初始提案（由呼叫者先用 Claude 產生後傳入）"),
      learningStatePath: z.string().optional().describe("learning-state.json 路徑"),
    },
  },
  async ({ task, taskType, proposal, learningStatePath }) => {
    const { runCognitiveCycle } = await import("../src/cognitive-cycle.js");
    const result = await runCognitiveCycle({ task, taskType, proposal, db, learningStatePath });
    const text = [
      `🧠 ABCD 認知迴圈完成`,
      `GoT 節點：${result.stats.gotNodes}  批評者：${result.stats.critics}  重試：${result.stats.retries}`,
      `費用估算：$${result.stats.totalEstimatedCostUsd}  MAR跳過：${result.stats.skippedMAR}`,
      ``,
      `## GoT 遍歷策略`,
      result.got.strategy,
      ``,
      `## MoA 聚合 Prompt（請呼叫 Claude Sonnet 執行）`,
      result.prompts.moaPrompt.slice(0, 1000),
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);
```

同時更新工具 28 的編號標記從 27 改為 28（check_risk_gate），29 改為 run_dmad_debate，依此類推。實際上只要改註解就好，工具名稱不變。

---

## 任務 4：`nuwa chat` REPL 接入真實 Claude API

**檔案**：`src/cli.ts`，函數 `cmdChat`（約第 870 行附近）

**現況**：REPL 讀取使用者輸入後，只顯示 `（請連接 MCP 取得 AI 回應）`。

**修正**：讓 REPL 實際呼叫 `claude -p` CLI（非互動模式），把使用者訊息送給 Claude：

```typescript
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)

// 在 ask() 的 else 分支中
} else {
  // 真實呼叫 claude CLI（若未安裝則顯示錯誤）
  const label = `${agent}${persona ? ` / ${persona}` : ""}`
  process.stdout.write(`[${label}] 思考中...`)

  // 組裝 system prompt（注入激活的 pattern + persona）
  let systemPrompt = ""
  if (persona) {
    const pRow = db.local.prepare(
      "SELECT description FROM personas WHERE slug = ?"
    ).get(persona) as { description: string } | undefined
    if (pRow) systemPrompt = `你正在扮演：${pRow.description}\n`
  }

  const fullPrompt = systemPrompt + trimmed

  execFileAsync("claude", ["-p", fullPrompt, "--output-format", "json"], {
    timeout: 30_000,
  })
    .then(({ stdout }) => {
      try {
        const json = JSON.parse(stdout) as { result?: string }
        process.stdout.write(`\r[${label}]: ${json.result ?? stdout}\n`)
      } catch {
        process.stdout.write(`\r[${label}]: ${stdout.slice(0, 500)}\n`)
      }
      ask()
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        process.stdout.write(`\r[${label}]: （claude CLI 未安裝，請執行：npm install -g @anthropic-ai/claude-code）\n`)
      } else {
        process.stdout.write(`\r[${label}]: （呼叫失敗：${String(err).slice(0, 100)}）\n`)
      }
      ask()
    })
  return  // 等 Promise 完成後再 ask()
```

需要在 `cmdChat` 頂部加 import：

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
```

（若 cli.ts 頂部已有則不重複加）

---

## 任務 5：修正 `list_debates` 欄位不符

**檔案**：`mcp/server.ts`，工具 `list_debates`（約第 1264 行）

**問題**：查詢 `rounds_count, convergence_score` — 確保這些欄位在 debates 表存在（任務 1 修正後就 OK），但還需要加 `stopped_by, pattern_slugs_used` 到查詢輸出：

```typescript
const rows = db
  .prepare(
    `SELECT task, rounds_count, convergence_score, stopped_by, pattern_slugs_used, started_at 
   FROM debates ${conditions} ORDER BY started_at DESC LIMIT ?`,
  )
  .all(limit) as Array<{
  task: string;
  rounds_count: number;
  convergence_score: number | null;
  stopped_by: string | null;
  pattern_slugs_used: string | null;
  started_at: string;
}>;

const text =
  rows.length === 0
    ? "📭 尚無辯論記錄。"
    : [
        `⚔️ DMAD 辯論歷程（${rows.length} 筆）：`,
        "",
        ...rows.map((r) => {
          const patterns = (() => {
            try {
              return (JSON.parse(r.pattern_slugs_used ?? "[]") as string[]).join(", ");
            } catch {
              return "";
            }
          })();
          return (
            `• [${r.started_at.slice(0, 10)}] ${r.task.slice(0, 60)}\n  ` +
            `rounds=${r.rounds_count}  收斂=${((r.convergence_score ?? 0) * 100).toFixed(0)}%` +
            `  停止：${r.stopped_by ?? "?"}  patterns：${patterns || "無"}`
          );
        }),
      ].join("\n");
```

---

## 任務 6：`spawn_agent` MCP 工具接入 Task Bus 實際執行

**檔案**：`mcp/server.ts`，工具 `spawn_agent`（約第 1132 行）

**現況**：只回傳 CLI command 字串，不實際執行。

**修正**：加入 `execute: true` 選項，若啟用則透過 Task Bus adapters 真實呼叫：

```typescript
inputSchema: {
  // ...現有欄位保留...
  execute: z.boolean().optional().describe("若 true 則實際執行（預設 false，僅回傳指令）"),
  timeoutMs: z.number().optional().describe("執行 timeout（ms，預設 30000）"),
},
async ({ agentType, task, model, context, role, execute, timeoutMs = 30_000 }) => {
  // 組裝 command（現有邏輯保留）...

  if (!execute) {
    // 現有行為：只回傳 command 字串
    return { content: [{ type: "text" as const, text: `CLI 指令：\n${command}` }] }
  }

  // 實際執行
  try {
    const { callClaudeCli } = await import("../../tools/openclaw_runtime/adapters/claude_code_cli_adapter.js")
    const { callCodexCli } = await import("../../tools/openclaw_runtime/adapters/codex_cli_adapter.js")
    const { callLocalModel } = await import("../../tools/openclaw_runtime/adapters/local_model_adapter.js")

    let result: string
    if (agentType === "claude") {
      const r = await callClaudeCli(task, { model, systemPrompt: role, timeoutMs })
      result = r.result
    } else if (agentType === "codex") {
      const r = await callCodexCli(task, { model, timeoutMs })
      result = r.result
    } else {
      const r = await callLocalModel(task, { model })
      result = r.result
    }
    return { content: [{ type: "text" as const, text: result }] }
  } catch (err) {
    return { content: [{ type: "text" as const, text: `執行失敗：${String(err).slice(0, 200)}` }] }
  }
},
```

---

## 任務 7：Croner 接入 `syncHermesToCausal`（方向 B 雙向回饋）

**檔案**：`src/croner.ts`

**現況**：`runRemDecay` 每晚 03:00 執行，但 `writeback.ts` 裡的 `syncHermesToCausal()` 從未被 Croner 呼叫。

**修正**：在 `runRemDecay` 函數執行完 REM 衰減後，呼叫 `syncHermesToCausal`：

```typescript
import { syncHermesToCausal } from "./writeback-bridge.js";
// 注意：tools/openclaw_runtime/task_bus/writeback.ts 接收 db 實例
// 需要在 croner.ts 內 import 並在 runRemDecay 後調用

// 在 startCroner 內：
async function runRemDecay() {
  // ...現有 REM 衰減 SQL...（保留）

  // 方向 B：Hermes learning-state → nuwa causal_edges
  try {
    const { syncHermesToCausal } =
      await import("../../tools/openclaw_runtime/task_bus/writeback.js");
    syncHermesToCausal(db, stateDir);
    console.log("🔄 Hermes → causal_edges 同步完成");
  } catch {
    // writeback 失敗不影響 REM 衰減主流程
  }
}
```

但注意 `writeback.ts` 的路徑從 `extensions/evolution-learning/src/croner.ts` 到 `tools/openclaw_runtime/task_bus/writeback.ts` 是 `../../../tools/...`，需調整相對路徑。

---

## 任務 8：pattern 繼承鏈注入 MCP Prompt（parent_slug）

**檔案**：`mcp/server.ts`，Prompts 註冊區塊（約第 1380 行的 for loop）

**現況**：每個 pattern 的 MCP Prompt 只注入自身的 `context + mental_models`，沒有沿 `parent_slug` 繼承鏈往上合併父 pattern 的心智模型。

**修正**：在 for loop 內，遞迴取得父 pattern 的 `mental_models` 並 merge：

```typescript
// 在 for (const p of allPatterns) 迴圈內，組裝 mentalModelsList 之後：

// 繼承父 pattern 的心智模型（最多往上 2 層）
let parentSlug = (p as PatternRow & { parent_slug?: string | null }).parent_slug ?? null;
let depth = 0;
while (parentSlug && depth < 2) {
  const parent = db
    .prepare("SELECT mental_models, parent_slug FROM patterns WHERE slug = ?")
    .get(parentSlug) as { mental_models: string | null; parent_slug: string | null } | undefined;
  if (!parent) break;
  try {
    const parentModels = JSON.parse(parent.mental_models ?? "[]") as string[];
    // 只加入不重複的模型，標記 [繼承]
    for (const m of parentModels) {
      if (!mentalModelsList.includes(m) && !mentalModelsList.includes(`[繼承] ${m}`)) {
        mentalModelsList.push(`[繼承] ${m}`);
      }
    }
  } catch {
    /* 略過 */
  }
  parentSlug = parent.parent_slug;
  depth++;
}
```

同時在 `PatternRow` type 加入 `parent_slug: string | null`，並在 SQL 查詢加入 `parent_slug` 欄位。

---

## 任務 9：補全 `before-prompt-build` 空 DB 的用戶提示

**檔案**：`hooks/before-prompt-build.js`

**現況**：DB 不存在或 patterns 為空時靜默退出，使用者不知道 nuwa 還沒初始化。

**修正**：當 DB 不存在時，輸出一個輕量提示（不干擾 AI 推理）：

```javascript
// 在 catch 區塊：
} catch (err) {
  // DB 不存在（migrate 尚未執行），輸出輕量提示
  if (err && err.code === 'SQLITE_CANTOPEN') {
    process.stdout.write(JSON.stringify({
      type: "context",
      content: "<!-- nuwa: DB 尚未初始化，請執行 `nuwa-mcp` 啟動 MCP Server 以開始記憶學習 -->"
    }) + "\n")
  }
  process.exit(0)
}
```

---

## 任務 10：Task Bus `index.ts` 補完所有 export

**檔案**：`tools/openclaw_runtime/index.ts`

確認以下全部 export：

```typescript
// task_bus
export { createTaskResult, markSucceeded, markFailed } from "./task_bus/task_schema.js";
export {
  routeTask,
  routeTaskSync,
  routeL1,
  routeL2,
  routeL3,
  classifyRisk,
  isApprovalRequired,
} from "./task_bus/task_router.js";
export { collectResult, collectResults } from "./task_bus/result_collector.js";
export { writebackToCausal, syncHermesToCausal } from "./task_bus/writeback.js";

// adapters
export { callClaudeCli } from "./adapters/claude_code_cli_adapter.js";
export { callCodexCli } from "./adapters/codex_cli_adapter.js";
export { callLocalModel } from "./adapters/local_model_adapter.js";
```

---

## 執行順序建議

1. **任務 1**（schema 修正）→ **任務 5**（list_debates 欄位）— 必須先修 schema
2. **任務 2**（debate CLI）— 獨立，直接可做
3. **任務 3**（cognitive_cycle MCP tool）— 獨立，直接可做
4. **任務 4**（chat REPL → Claude CLI）— 獨立，直接可做
5. **任務 6**（spawn_agent 執行）— 依賴 Task Bus（已完成）
6. **任務 7**（Croner syncHermesToCausal）— 確認路徑後直接可做
7. **任務 8**（pattern 繼承鏈）— 獨立，直接可做
8. **任務 9**（before-prompt-build 提示）— 最小改動
9. **任務 10**（Task Bus index.ts）— 確認後補完

---

## 注意事項

- **不需要外部服務**：以上全部任務在純 Node.js 環境可完成，不需要 Ollama / Graphiti / Mem0
- **CLI 未安裝時的 fallback**：所有呼叫 `claude -p` 或 `codex exec` 的地方必須 catch `ENOENT` 並給出清楚提示
- **ESM**：所有 `.js` 檔案用 `import { createRequire } from "node:module"` 取得 `require`，不用 `"use strict"` + `require()` 直接呼叫
- **TypeScript**：型別要完整，不用 `any`，prefer `unknown` + type guard
- **DB 操作**：所有 better-sqlite3 操作都是同步的，不要加 await
- **測試方式**：

  ```bash
  # 啟動 MCP server
  pnpm --filter @openclaw/evolution-learning run mcp

  # 測試 CLI
  npx tsx extensions/evolution-learning/bin/nuwa.ts debate "微服務架構的優缺點"
  npx tsx extensions/evolution-learning/bin/nuwa.ts chat
  ```

---

## 檔案路徑速查

```
extensions/evolution-learning/
  src/
    cli.ts          ← 任務 2, 4
    db.ts           ← 任務 1
    croner.ts       ← 任務 7
    dmad-debate.ts  ← 已完成，任務 1 修正 schema 後可正常寫入
    cognitive-cycle.ts ← 已完成，任務 3 補 MCP tool
  mcp/
    server.ts       ← 任務 3, 5, 6, 8
  hooks/
    before-prompt-build.js ← 任務 9
tools/
  openclaw_runtime/
    index.ts              ← 任務 10
    task_bus/writeback.ts ← 任務 7 呼叫來源
```
