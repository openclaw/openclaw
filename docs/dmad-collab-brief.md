# DMAD Claude × Codex 協作任務簡報

## 背景

Claude Code 剛完成以下三個函數的初版實作（均在 `D:\OpenClaw\extensions\evolution-learning\src\dmad-debate.ts`）。
你（Codex）的任務是：**閱讀 Claude 的實作 → 從技術角度找出缺陷和改進空間 → 直接修改程式碼讓它更完美**。

---

## Claude 的實作（你需要審查的程式碼）

### 1. routeTask()（MasRouter，行 ~555）

```typescript
interface RouteDecision {
  useCodex: boolean;
  useClaude: boolean;
  useOllama: boolean;
  needsMoA: boolean;
  maxRoundsOverride?: number;
}

function routeTask(task: string): RouteDecision {
  const techPattern = /程式|code|bug|fix|implement|api|函數|class|typescript|script|測試|debug/i;
  const langPattern = /策略|分析|評估|建議|如何|為什麼|意見|報告|文件|規劃/i;

  if (techPattern.test(task)) {
    return {
      useCodex: true,
      useClaude: false,
      useOllama: true,
      needsMoA: false,
      maxRoundsOverride: 1,
    };
  }
  if (langPattern.test(task)) {
    return {
      useCodex: false,
      useClaude: true,
      useOllama: true,
      needsMoA: false,
      maxRoundsOverride: 1,
    };
  }
  return { useCodex: true, useClaude: true, useOllama: true, needsMoA: true };
}
```

**Claude 已知的限制**：

- 正則表達式在函數內每次呼叫都重新編譯
- 若 task 同時匹配 tech + lang（如「分析如何實作 API」），只走第一個 branch
- 沒有 `confidence` 分數，呼叫者無法知道路由決策有多確定
- 英文任務覆蓋不夠完整（如 "explain", "design", "review", "refactor"）

---

### 2. rcr()（角色感知上下文壓縮，行 ~600）

```typescript
type RcrRole = "language" | "technical" | "pattern";

const RCR_KEYWORDS: Record<RcrRole, RegExp> = {
  language: /推理|意圖|邏輯|語義|使用者|需求|抽象|概念|策略/i,
  technical: /程式|架構|實作|API|函數|效能|資料庫|效率|schema/i,
  pattern: /框架|模式|歷史|案例|pattern|慣例|template/i,
};

function rcr(text: string, receiverRole: RcrRole): string {
  const keywords = RCR_KEYWORDS[receiverRole];
  const sentences = text
    .split(/[。！？.!?]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const matched = sentences.filter((s) => keywords.test(s));
  const result = matched.length > 0 ? matched.join("。") : text;
  return result.slice(0, 250);
}
```

**Claude 已知的限制**：

- 句子分割只用標點，但英文的 `.` 也會把 `API v3.0` 這類內容錯誤切割
- `RCR_KEYWORDS` 只有中文關鍵字，英文回應完全無法匹配（Codex 通常用英文回應）
- fallback 直接返回完整 text，但若 text 很長還是可能超出 token 限制
- 沒有保護最少保留 N 句的機制（可能壓縮過頭）
- `matched.join("。")` 用中文句號接英文句子不自然

---

### 3. dmad-trend-report.mts（行分析報告，`D:\OpenClaw\scripts\dmad-trend-report.mts`）

**Claude 的 calcTrend()** 只比較最新 3 份 vs 最舊 3 份的平均，沒有：

- 各代理的 win rate（Claude/Codex/OpenClaw 各自在多少輪辯論中「贏得」最終答案）
- convergenceScore 的 p50/p95 百分位數
- stoppedBy=convergence 的比例趨勢（是否越來越快收斂？）

---

## 你的任務

請直接修改以下兩個檔案，讓它們**技術上更完美**：

### 目標 A：改進 `D:\OpenClaw\extensions\evolution-learning\src\dmad-debate.ts`

1. **routeTask()** — 改進：
   - 在模組頂層預編譯正則（`const TECH_RE = ...`）
   - 增加英文語言任務關鍵字（explain, design, review, refactor, analyze, recommend）
   - 增加英文技術任務關鍵字（test, lint, compile, build, deploy, schema, migration）
   - 處理 tech + lang 雙重匹配：若兩者都中，回傳全三方（needsMoA=true）
   - 在 RouteDecision 加入 `confidence: "high" | "medium" | "low"` 欄位

2. **rcr()** — 改進：
   - 改用更智慧的句子分割：避免 `3.0`、`v2.1` 這類數字小數點被誤切
   - 為英文內容加入英文關鍵字映射（在 RCR_KEYWORDS 每個 role 加英文詞）
   - 加入 `minSentences = 2` 參數：即使完全無匹配，也至少保留前 2 句（比直接返回全文更好）
   - 修正 join 分隔符：中文句子用 `。`，英文句子用 `. `（偵測首句是否含 ASCII 字母）

### 目標 B：改進 `D:\OpenClaw\scripts\dmad-trend-report.mts`

1. 加入 `percentiles` 計算：`{ p50: number, p95: number }` for convergenceScore
2. 加入 `agentWinRateNote`：從 latestResult 的 trajectoryScores 中找最高分代理，統計各代理在歷史報告中的最高軌跡分頻率
3. 加入 `convergenceRatePercent`：stoppedBy=convergence 的比例（%）
4. 修正 glob fallback：當 historyPaths 抓不到時，也把 latest 報告加入分析

---

## 技術限制

- **語言**：所有新增程式碼的**註解必須用繁體中文**
- **TypeScript**：嚴格模式，不新增 any 型別，不破壞現有 interface
- **向下相容**：`rcr()` 的 signature 不變（text, receiverRole），新增參數必須有預設值
- **測試指令**：修改完成後執行 `pnpm dmad:smoke-test` 確認無錯

---

## 完成後輸出

修改完成後，輸出 JSON 格式：

```json
{
  "ok": true,
  "changedFiles": [
    "extensions/evolution-learning/src/dmad-debate.ts",
    "scripts/dmad-trend-report.mts"
  ],
  "improvements": {
    "routeTask": "說明你做了什麼",
    "rcr": "說明你做了什麼",
    "trendReport": "說明你做了什麼"
  }
}
```
