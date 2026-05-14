# 架構決策紀錄：自動化進化學習擴張架構

> 狀態：草稿
> 日期：2026-05-14
> 語言：繁體中文

---

## 1. 背景與問題陳述

### 1.1 現有系統規模

| 層次                          | 數量            | 涵蓋範圍                                                                                |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| 核心模組（src/）              | 80+ 子系統      | 閘道、代理、插件、頻道、ACP、MCP、會話、任務、掛鉤、排程、上下文引擎、軌跡、承諾、路由… |
| 擴充套件（extensions/）       | 126 個          | 50+ AI 提供者、20+ 訊息平台、記憶系統、瀏覽器自動化、交易…                              |
| 技能（skills/）               | 59 個           | coding-agent、taskflow、github、skill-creator…                                          |
| 自動化代理（.agents/skills/） | 19 個           | ClawSweeper、PR 維護、QA 測試、發布…                                                    |
| 原生應用（apps/）             | 5 個            | iOS、macOS、Android、MLX-TTS、Swabble                                                   |
| 套件（packages/）             | 4 個            | Plugin SDK、Memory Host SDK、SDK…                                                       |
| npm 腳本                      | 400+            | brokerdesk HFT、自動化、畫布…                                                           |
| 插件掛鉤                      | 36 個（具型別） | 代理生命週期、訊息、工具、會話、子代理、閘道、安裝                                      |
| 內部掛鉤                      | 12 種事件       | 命令、會話、代理、閘道、訊息                                                            |
| 提供者執行期掛鉤              | 43 個           | 完整 LLM 提供者生命週期                                                                 |

### 1.2 現有學習機制（分散孤立）

| 機制                 | 位置                                          | 功能                                 | 限制                     |
| -------------------- | --------------------------------------------- | ------------------------------------ | ------------------------ |
| Dreaming（睡眠整理） | extensions/memory-core                        | 淺/快速眼動/深層記憶鞏固             | 只整理記憶，不回饋到行為 |
| 主動記憶             | extensions/active-memory                      | 斷路器、自適應思考、阻斷式子代理召回 | 讀取記憶但不從結果中學習 |
| Memory LanceDB       | extensions/memory-lancedb                     | 向量嵌入儲存、自動擷取/召回          | 儲存但不分析模式         |
| Memory Wiki          | extensions/memory-wiki                        | Obsidian 知識庫編譯器                | 靜態編譯，不成長         |
| Hermes 學習          | extensions/hermes-agent/src/learning.ts       | 成功/失敗模式記錄（最多200筆）       | 記錄但不更新路由或策略   |
| Hermes 晉升          | extensions/hermes-agent/src/promotion.ts      | 驗證閘道（暫存→晉升/回滾）           | 二元通過/失敗，無梯度    |
| MSTeams 回饋         | extensions/msteams/src/feedback-reflection.ts | 按讚觸發反思迴圈                     | 頻道特定，不傳播         |
| 軌跡記錄             | src/trajectory/                               | 執行追蹤記錄與匯出                   | 記錄但從不回饋           |
| 承諾追蹤             | src/commitments/                              | 承諾追蹤、模型選擇學習               | 範圍窄（只管模型選擇）   |
| 上下文引擎           | src/context-engine/                           | 可插拔上下文組裝/壓縮                | 只是框架，不自我改進     |
| 掛鉤系統             | src/hooks/                                    | 36 個具型別事件掛鉤                  | 被動管道，無自適應行為   |
| 排程/心跳            | src/cron/                                     | 排程執行、心跳策略                   | 固定排程，無自適應時機   |

### 1.3 缺少的四個關鍵架構層

系統有 126 個擴充套件、80+ 核心模組、59 個技能，但全部都是**靜態組裝**。每個元件都是死的零件，用固定介面鎖在一起。系統缺少讓它成為**活的、成長的有機體**所需的四個基本架構層：

| 缺少的層           | 含義                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| **運行即學習**     | 每次操作都產生學習資料，但全部被丟掉。用完即忘，而非用完即長。                |
| **神經元模組**     | 所有連接都是硬接線。沒有動態權重、沒有競爭激活、沒有自適應路由。              |
| **貫穿式增長模式** | Dreaming 只在 memory-core 執行。其他 125 個擴充套件和 79 個核心模組從不成長。 |
| **擬人有機體架構** | 系統是機器（由死零件組裝），而非有機體（活的、自我修復、新陳代謝）。          |

---

## 2. 設計原則

### 2.1 架構合規（不可違反）

這些規則來自 `AGENTS.md` 和 `extensions/AGENTS.md`，不可違反：

| 規則                 | 來源                                   | 含義                                                 |
| -------------------- | -------------------------------------- | ---------------------------------------------------- |
| 擴充套件是第三方插件 | extensions/AGENTS.md                   | 只從 `openclaw/plugin-sdk/*` 匯入                    |
| 不修改核心           | AGENTS.md 架構                         | 絕不匯入或修改 `src/**`                              |
| 清單優先             | 插件架構                               | 在執行期登記前，在 `openclaw.plugin.json` 中宣告能力 |
| 掛鉤整合             | 36 個具型別插件掛鉤                    | 用 `api.on()` 掛入生命週期，絕不修改核心流程         |
| 懶載入               | 現有模式（memory-core、active-memory） | 延遲到首次使用才初始化，不影響啟動效能               |
| 插件狀態儲存         | plugin-state-store.ts                  | 透過官方 API 使用 SQLite 或 JSON，不自創儲存         |
| 不跨擴充套件匯入     | extensions/AGENTS.md                   | 擴充套件不能匯入另一個擴充套件的 `src/**`            |
| 向後相容接縫         | AGENTS.md                              | 新接縫必須有版本、有文件、向後相容                   |

### 2.2 設計哲學

| 原則                   | 含義                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| **從現有接縫成長**     | 不建新基礎設施。使用已有的掛鉤、記憶、插件狀態、排程。                     |
| **每個階段獨立有價值** | 第一階段單獨運作。第二階段強化第一階段。沒有任何階段需要全部四個才能運作。 |
| **預設失敗開放**       | 如果任何進化元件失敗，系統行為完全等同今天。零回歸風險。                   |
| **先可觀測，後自主**   | 每個學習動作先記錄可審計，才被允許自主行動。                               |
| **有機，而非機械**     | 設計為成長、自適應、自我修復，而非只是設定和部署。                         |

---

## 3. 架構總覽

### 3.1 四層進化堆疊

```
+=====================================================================+
|                                                                     |
|  第四層：有機細胞           extensions/organic-cells/               |
|  （擬人有機體架構）                                                 |
|  細胞登記、新陳代謝、免疫系統、內分泌、幹細胞池、DNA 完整性驗證    |
|                                                                     |
+---------------------------------------------------------------------+
|                                                                     |
|  第三層：增長心跳           extensions/growth-pulse/                |
|  （貫穿式增長模式）                                                 |
|  心跳驅動的增長週期：淺層（每小時）、快速眼動（每天）、深層（每週）|
|  與 memory-core Dreaming 各階段對齊                                 |
|                                                                     |
+---------------------------------------------------------------------+
|                                                                     |
|  第二層：神經路由           extensions/neural-router/               |
|  （動態突觸路由）                                                   |
|  突觸權重、激活閾值、競爭路徑選擇、權重衰減                        |
|  由第一層學習資料驅動                                              |
|                                                                     |
+---------------------------------------------------------------------+
|                                                                     |
|  第一層：運行即學習         extensions/operational-learning/        |
|  （用完即長閉環）                                                   |
|  從每個掛鉤事件收集訊號，分析模式，                                |
|  透過 before_prompt_build 回饋洞察                                  |
|                                                                     |
+=====================================================================+
|                                                                     |
|  現有 OpenClaw 基礎（不修改）                                       |
|  126 擴充套件 | 80+ 核心模組 | 36 掛鉤 | 59 技能                   |
|  Plugin SDK | 記憶（核心+LanceDB+wiki+主動）| 軌跡 | 承諾           |
|  上下文引擎 | 排程 | Hermes 代理                                    |
|                                                                     |
+=====================================================================+
```

### 3.2 層間通訊（合規方式）

擴充套件不能互相匯入 `src/`。合規通訊管道：

| 管道         | 方式                                       | 範例                                      |
| ------------ | ------------------------------------------ | ----------------------------------------- |
| 記憶儲存     | 透過記憶工具共用讀寫                       | 運行即學習寫入模式 → 神經路由讀取         |
| 插件狀態     | JSON 檔案讀寫                              | 運行即學習寫 weights.json → 神經路由讀    |
| 掛鉤優先順序 | before_prompt_build 優先順序控制注入順序   | 第一層(100) → 第二層(90) → 第三層(80)     |
| 工具呼叫     | 一個擴充套件登記工具，另一個在子代理中呼叫 | 第一層登記 learning_insights → 第三層查詢 |

---

## 4. 第一層：運行即學習

### 4.1 目的

將每次 OpenClaw 操作轉換為學習訊號。目前系統是**用完即忘**，這一層讓它變成**用完即長**。

### 4.2 資料流向

```
使用者操作 OpenClaw
    |
    v
after_tool_call 掛鉤 ---------> 工具結果記錄
model_call_ended 掛鉤 --------> 模型效能記錄
agent_end 掛鉤---------------> 會話結果記錄
session_end 掛鉤 -------------> 會話統計記錄
    |
    v
模式分析器（非同步，不阻斷）
    |
    v
權重矩陣更新 + 模式庫更新 + 偏好模型更新
    |
    v
before_prompt_build 掛鉤 -----> 注入學習洞察到下次會話
```

### 4.3 清單（openclaw.plugin.json）

```json
{
  "id": "operational-learning",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["learning_insights", "learning_stats", "learning_correct"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "maxRecords": { "type": "number", "default": 2000 },
      "decayHalfLifeHours": { "type": "number", "default": 168 },
      "minConfidence": { "type": "number", "default": 0.6 },
      "analysisIntervalMs": { "type": "number", "default": 300000 },
      "promptInjection": { "type": "boolean", "default": true },
      "maxPromptTokens": { "type": "number", "default": 200 }
    }
  }
}
```

### 4.4 入口程式（index.ts）

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "operational-learning",
  name: "運行即學習",
  description: "從每次操作中學習，將用完即忘轉變為用完即長。",

  register(api: OpenClawPluginApi) {
    // --- 收集層（void 掛鉤，純觀察，絕不阻斷）---

    api.on("after_tool_call", async (event, ctx) => {
      const { collectToolOutcome } = await import("./src/collector.js");
      await collectToolOutcome(api, event, ctx);
    });

    api.on("model_call_ended", async (event, ctx) => {
      const { collectModelPerformance } = await import("./src/collector.js");
      await collectModelPerformance(api, event, ctx);
    });

    api.on("agent_end", async (event, ctx) => {
      const { collectSessionOutcome } = await import("./src/collector.js");
      await collectSessionOutcome(api, event, ctx);
    });

    api.on("session_end", async (event, ctx) => {
      const { collectSessionStats } = await import("./src/collector.js");
      await collectSessionStats(api, event, ctx);
    });

    // --- 注入層（修改掛鉤，同 active-memory 模式）---

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const { injectLearnedPatterns } = await import("./src/injector.js");
        return injectLearnedPatterns(api, event, ctx);
      },
      { priority: 100 },
    );

    // --- 工具登記（懶載入）---

    api.registerTool({
      name: "learning_insights",
      description: "查詢學習模式與操作洞察",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: {
            type: "string",
            enum: ["tool", "model", "route", "preference", "all"],
            default: "all",
          },
          limit: { type: "number", default: 10 },
        },
      },
      handler: async (params) => {
        const { queryInsights } = await import("./src/tools.js");
        return queryInsights(api, params);
      },
    });

    api.registerTool({
      name: "learning_correct",
      description: "手動矯正學習訊號（標記好/壞的操作）",
      parameters: {
        type: "object",
        properties: {
          recordId: { type: "string" },
          feedback: { type: "string", enum: ["good", "bad"] },
          reason: { type: "string" },
        },
        required: ["recordId", "feedback"],
      },
      handler: async (params) => {
        const { applyCorrection } = await import("./src/tools.js");
        return applyCorrection(api, params);
      },
    });
  },
});
```

### 4.5 核心型別（src/types.ts）

```typescript
export type LearningCategory = "tool" | "model" | "route" | "preference" | "strategy";

export type LearningRecord = {
  id: string;
  category: LearningCategory;
  timestamp: number;
  sessionKey?: string;

  // 發生了什麼
  action: string;
  target: string;
  params?: Record<string, unknown>;

  // 結果
  success: boolean;
  durationMs?: number;
  errorType?: string;

  // 衍生欄位
  weight: number; // 衰減後的當前權重
  confidence: number; // 統計信心度
  occurrences: number; // 此模式出現次數
};

export type LearnedPattern = {
  id: string;
  category: LearningCategory;
  pattern: string;
  description: string;
  weight: number;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
  successRate: number;
  avgDurationMs?: number;
};

export type WeightMatrix = {
  version: number;
  updatedAt: number;
  tools: Record<string, number>; // 工具名稱 → 有效性權重
  models: Record<string, number>; // 模型 ID → 效能權重
  routes: Record<string, number>; // 路由模式 → 成功權重
  strategies: Record<string, number>; // 策略名稱 → 結果權重
};
```

### 4.6 收集器邏輯（src/collector.ts）

```typescript
export async function collectToolOutcome(
  api: OpenClawPluginApi,
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  try {
    const record: LearningRecord = {
      id: `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      category: "tool",
      timestamp: Date.now(),
      sessionKey: ctx.sessionKey,
      action: "tool_call",
      target: event.toolName,
      params: event.params,
      success: !event.error,
      durationMs: event.durationMs,
      errorType: event.error?.type,
      weight: 1.0,
      confidence: 1.0,
      occurrences: 1,
    };

    // 非同步追加寫入（不阻斷）
    await api.pluginState.appendLine("learning-records.jsonl", JSON.stringify(record));

    // 更新即時權重（指數移動平均）
    const reward = record.success ? 1.0 : -0.5;
    await updateWeight(api, "tools", event.toolName, reward, event.durationMs);
  } catch {
    // 失敗開放：學習失敗不影響主流程
  }
}

async function updateWeight(
  api: OpenClawPluginApi,
  category: keyof WeightMatrix,
  key: string,
  reward: number,
  durationMs?: number,
): Promise<void> {
  const α = 0.1;
  const p90 = 2000; // 90 百分位基準延遲（毫秒）
  const latencyPenalty = durationMs ? Math.max(0, (durationMs - p90) / 1000) : 0;
  const adjustedReward = reward - latencyPenalty;

  const weights =
    (await api.pluginState.readJSON<WeightMatrix>("weights.json")) ?? createDefaultWeights();
  const current = (weights[category] as Record<string, number>)[key] ?? 0.5;
  const updated = α * adjustedReward + (1 - α) * current;
  (weights[category] as Record<string, number>)[key] = Math.max(0, Math.min(1, updated));
  weights.updatedAt = Date.now();

  await api.pluginState.writeJSON("weights.json", weights);
}
```

---

## 5. 第二層：神經路由

### 5.1 目的

在工具、模型、路由選擇上加入**動態突觸權重**，實現競爭激活的自適應路由。利用第一層的學習資料，讓每次選擇比上一次更準確。

### 5.2 競爭選擇演算法（epsilon-greedy）

```typescript
// src/compete.ts

export type ActivationSignal = {
  context: string;
  taskType: string;
  complexity: "low" | "medium" | "high";
  historyKey?: string;
};

export async function selectPath(
  api: OpenClawPluginApi,
  candidates: string[],
  signal: ActivationSignal,
  weights: WeightMatrix,
  ε: number = 0.1,
): Promise<string> {
  // Epsilon-greedy：以 ε 機率探索（隨機），以 1-ε 機率利用（最高權重）
  if (Math.random() < ε) {
    // 探索：隨機選擇（避免局部最優）
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // 利用：選擇最高突觸權重的路徑
  let bestCandidate = candidates[0];
  let bestWeight = -Infinity;

  for (const candidate of candidates) {
    const w = weights.models[candidate] ?? weights.tools[candidate] ?? 0.5;
    if (w > bestWeight) {
      bestWeight = w;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}
```

### 5.3 清單（openclaw.plugin.json）

```json
{
  "id": "neural-router",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["neural_weights", "neural_topology"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "epsilon": { "type": "number", "default": 0.1 },
      "epsilonDecay": { "type": "number", "default": 0.995 },
      "epsilonMin": { "type": "number", "default": 0.05 },
      "decayRate": { "type": "number", "default": 0.99 }
    }
  }
}
```

### 5.4 入口程式（index.ts）

```typescript
export default definePluginEntry({
  id: "neural-router",
  name: "神經路由",
  description: "動態突觸路由：epsilon-greedy 競爭選優，EMA 權重更新。",

  register(api: OpenClawPluginApi) {
    // 模型選擇掛鉤：根據突觸權重動態選擇最優模型
    api.on("before_model_resolve", async (event, ctx) => {
      const { selectOptimalModel } = await import("./src/compete.js");
      return selectOptimalModel(api, event, ctx);
    });

    // 回合準備掛鉤：提取上下文訊號用於決策
    api.on("agent_turn_prepare", async (event, ctx) => {
      const { prepareContextSignal } = await import("./src/context-signal.js");
      return prepareContextSignal(api, event, ctx);
    });

    // 提示建構前：注入神經路由上下文
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const { injectRoutingContext } = await import("./src/injector.js");
        return injectRoutingContext(api, event, ctx);
      },
      { priority: 90 },
    );

    // 工具結果掛鉤：更新突觸權重
    api.on("after_tool_call", async (event, ctx) => {
      const { updateSynapseWeight } = await import("./src/synapse-weights.js");
      await updateSynapseWeight(api, event, ctx);
    });

    // 模型結束掛鉤：更新模型突觸權重
    api.on("model_call_ended", async (event, ctx) => {
      const { updateModelWeight } = await import("./src/synapse-weights.js");
      await updateModelWeight(api, event, ctx);
    });
  },
});
```

---

## 6. 第三層：增長心跳

### 6.1 目的

讓進化不只發生在單次操作時，還要**主動驅動**系統的長期增長。三個增長週期與 memory-core Dreaming 對齊，確保系統越用越聰明。

### 6.2 三週期設計

| 週期         | 頻率       | 觸發時機                                    | 任務                             | 時間預算   |
| ------------ | ---------- | ------------------------------------------- | -------------------------------- | ---------- |
| 淺層週期     | 每 1 小時  | heartbeat_prompt_contribution               | 微調突觸權重、套用時間衰減       | &lt; 500ms |
| 快速眼動週期 | 每 24 小時 | heartbeat_prompt_contribution（凌晨 03:00） | 提取模式、評估胚胎、更新增長指標 | &lt; 5s    |
| 深層週期     | 每 7 天    | heartbeat_prompt_contribution（週日 04:00） | 剪除死突觸、DNA 驗證、結構重組   | &lt; 30s   |

### 6.3 增長指標型別（src/types.ts）

```typescript
export type GrowthMetrics = {
  cycleId: string;
  timestamp: number;

  // 五維增長趨勢（每個維度 0–1，越高越好）
  perception: { score: number; trend: number }; // 感知能力
  routing: { score: number; trend: number }; // 路由精準度
  skill: { score: number; trend: number }; // 技能擴張
  judgment: { score: number; trend: number }; // 判斷品質
  structural: { score: number; trend: number }; // 結構健康

  // 幹細胞池狀態
  embryos: Array<{
    id: string;
    maturityScore: number;
    status: "embryo" | "incubating" | "ready" | "installed";
  }>;
};
```

### 6.4 清單（openclaw.plugin.json）

```json
{
  "id": "growth-pulse",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["growth_status", "growth_report"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "lightCycleIntervalMs": { "type": "number", "default": 3600000 },
      "remCycleHour": { "type": "number", "default": 3 },
      "deepCycleDayOfWeek": { "type": "number", "default": 0 }
    }
  }
}
```

---

## 7. 第四層：有機細胞

### 7.1 目的

將 OpenClaw 從機器（由死零件組裝）轉變為**有機體**（活的、自我修復、新陳代謝）。每個擴充套件都是一個細胞，整個系統形成一個生命有機體。

### 7.2 仿生概念對應

| 生物概念   | OpenClaw 實現                    |
| ---------- | -------------------------------- |
| 細胞       | 每個擴充套件                     |
| 血液循環   | 掛鉤事件流                       |
| 神經系統   | 神經路由（第二層）               |
| 免疫系統   | before_tool_call 異常攔截        |
| 內分泌系統 | 四種荷爾蒙全域狀態調節           |
| 幹細胞     | 技能胚胎池                       |
| DNA        | 清單校驗碼（manifest checksum）  |
| 新陳代謝   | 每個擴充套件的輸入/輸出/廢物記帳 |

### 7.3 核心型別（src/types.ts）

```typescript
export type CellState = "healthy" | "stressed" | "quarantined" | "recovering";

export type CellHealth = {
  extensionId: string;
  state: CellState;
  errorRate: number; // 滾動 1 小時錯誤率
  inputCount: number; // 接收的呼叫數
  outputCount: number; // 成功輸出數
  wasteCount: number; // 失敗/廢棄數
  lastHealthCheck: number;
  dnaChecksum: string; // 清單 SHA256 校驗碼
};

export type HormoneType = "cortisol" | "growth" | "melatonin" | "adrenaline";

export type Hormone = {
  type: HormoneType;
  level: number; // 0–100
  updatedAt: number;
};

export type OrganismState = {
  version: number;
  hormones: Record<HormoneType, Hormone>;
  cells: Record<string, CellHealth>;
  overallHealth: "thriving" | "growing" | "stable" | "stressed" | "critical";
};

export type StemCell = {
  id: string;
  skillId: string;
  status: "embryo" | "incubating" | "ready" | "installed";
  maturityScore: number; // 0.0–1.0
  patternIds: string[]; // 支撐此胚胎的模式 ID
  createdAt: number;
  lastEvaluated: number;
};
```

### 7.4 免疫系統邏輯（src/immune.ts）

```typescript
export async function evaluateThreat(
  api: OpenClawPluginApi,
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookAgentContext,
): Promise<{ blocked: boolean; reason?: string }> {
  const registry = await api.pluginState.readJSON<OrganismState>("cell-registry.json");
  const extensionId = event.toolExtensionId;

  if (!registry || !extensionId) {
    return { blocked: false }; // 無登記資料 → 通過（新工具）
  }

  const cell = registry.cells[extensionId];
  if (!cell) {
    return { blocked: false }; // 未知細胞 → 通過並開始觀察
  }

  if (cell.state === "quarantined") {
    return {
      blocked: true,
      reason: `擴充套件 ${extensionId} 已被免疫系統隔離（錯誤率 ${(cell.errorRate * 100).toFixed(1)}%）`,
    };
  }

  return { blocked: false };
}
```

### 7.5 清單（openclaw.plugin.json）

```json
{
  "id": "organic-cells",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["organism_status", "cell_health", "hormone_status"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "immuneEnabled": { "type": "boolean", "default": true },
      "quarantineThreshold": { "type": "number", "default": 0.5 },
      "stressThreshold": { "type": "number", "default": 0.2 },
      "maxQuarantinedCells": { "type": "number", "default": 5 },
      "stemCellMaturityThreshold": { "type": "number", "default": 0.8 }
    }
  }
}
```

---

## 8. 實施時程

### 第一階段：運行即學習（第 1–2 週）

**目標**：建立 `extensions/operational-learning/`

**驗收閘道**：

- [ ] 清單 + 套件設定 + 入口程式通過 `pnpm check:changed`
- [ ] 4 個觀察掛鉤正確收集資料
- [ ] 分析器成功提取模式（非阻斷）
- [ ] 注入品質 A/B 測試：注入後回應品質不下降
- [ ] 冷啟動狀態：20 筆前不注入

### 第二階段：神經路由（第 3–5 週）

**目標**：建立 `extensions/neural-router/`

**驗收閘道**：

- [ ] 競爭選擇優於隨機（統計顯著）
- [ ] 停用開關正常運作（回退到預設路由）
- [ ] before_model_resolve 延遲 < 10ms P99

### 第三階段：增長心跳（第 6–7 週）

**目標**：建立 `extensions/growth-pulse/`

**驗收閘道**：

- [ ] 三週期按時執行，不影響主流程
- [ ] 增長指標顯示正向趨勢（連續2週）
- [ ] 與 memory-core Dreaming 同步驗證

### 第四階段：有機細胞（第 8–11 週）

**目標**：建立 `extensions/organic-cells/`

**驗收閘道**：

- [ ] 免疫誤判率 < 1%（測試 1000 次正常呼叫）
- [ ] DNA 完整性驗證通過所有 126 個擴充套件
- [ ] 幹細胞孵化從胚胎到就緒的端到端流程驗證

---

## 9. 冷啟動策略

### 9.1 四個啟動狀態

| 狀態      | 記錄數  | 行為                   | ε 探索率 |
| --------- | ------- | ---------------------- | -------- |
| ❄ 冷態    | 0–19    | 只收集，不分析，不注入 | 0.30     |
| 🌡 暖機中 | 20–99   | 收集 + 分析，不注入    | 0.25     |
| 🔥 半熱   | 100–499 | 低信心注入（≥ 0.5）    | 0.15     |
| 🚀 熱態   | ≥ 500   | 全功能注入（≥ 0.6）    | 0.10     |

### 9.2 Bootstrap 預設權重（冷態使用）

```json
{
  "tools": {
    "bash": 0.7,
    "read": 0.75,
    "edit": 0.7,
    "write": 0.65,
    "glob": 0.7,
    "grep": 0.7
  },
  "models": {
    "claude-opus-4": 0.75,
    "claude-sonnet-4": 0.65,
    "claude-haiku": 0.5
  }
}
```

---

## 10. 架構合規檢查清單

| 檢查項目             | 第一層 | 第二層 | 第三層 | 第四層 |
| -------------------- | ------ | ------ | ------ | ------ |
| 只匯入 plugin-sdk/\* | ✅     | ✅     | ✅     | ✅     |
| 不修改核心 src/\*\*  | ✅     | ✅     | ✅     | ✅     |
| 清單優先宣告能力     | ✅     | ✅     | ✅     | ✅     |
| 只用掛鉤整合         | ✅     | ✅     | ✅     | ✅     |
| 懶載入模式           | ✅     | ✅     | ✅     | ✅     |
| 用 plugin state 儲存 | ✅     | ✅     | ✅     | ✅     |
| 不跨擴充套件匯入     | ✅     | ✅     | ✅     | ✅     |
| 向後相容             | ✅     | ✅     | ✅     | ✅     |
| 失敗開放語意         | ✅     | ✅     | ✅     | ✅     |
| 共置 \*.test.ts      | ✅     | ✅     | ✅     | ✅     |

---

## 11. 核心承諾

**4 個擴充套件 ｜ 13 個掛鉤 ｜ 零核心修改 ｜ 100% Plugin SDK 合規**

每個階段獨立有價值、獨立可關閉。關閉任何一個，系統行為和今天完全一樣。

```jsonc
// 回滾方式：openclaw.json 中關閉任何一層
{
  "plugins": {
    "entries": {
      "operational-learning": { "enabled": false },
      "neural-router": { "enabled": false },
      "growth-pulse": { "enabled": false },
      "organic-cells": { "enabled": false },
    },
  },
}
```
