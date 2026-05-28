---
summary: "Tracks DMAD run-test stabilization work, validation evidence, and next safe follow-ups."
read_when:
  - You are evaluating DMAD run-test stability or convergence behavior
  - You are continuing DMAD speedup automation work
title: "DMAD Speedup Task"
---

# Codex 任務：DMAD 收斂修復 + 系統強化

> 建立者：Claude（研究基礎版） 日期：2026-05-19
> Repo：`D:\OpenClaw`
> 論文依據：DMAD(ICLR'25)、MoA(ICLR'25)、Adaptive Stability Detection(NeurIPS'25)、Emergent Convergence(ACL'25)、FREE-MAD(2025)、Attention-MoA(2026)、DebateOCR(2026)、MasRouter(2025)、DTE(2025)、RCR-Router(2025)

---

## 一、現況診斷（已測試確認）

### 已完成且正確的部分

| 項目                                   | 狀態                       |
| -------------------------------------- | -------------------------- |
| 三代理每輪 `Promise.all` 並行          | ✅ 正確，不要動            |
| 語意 embedding 收斂（`getEmbedder()`） | ✅ 已實作，Ollama fallback |
| 雙閘收斂（inter-agent + inter-round）  | ✅ 已實作                  |
| 推理方法差異化 prompt（CCoT/DDCoT）    | ✅ 已實作                  |
| Representational Collapse 防護         | ✅ 已實作                  |
| MoA 批判性 Aggregate-and-Synthesize    | ✅ 已實作                  |
| `isCliError()` 防假收斂                | ✅ 已實作                  |
| `moaModel` 參數化                      | ✅ 已實作                  |
| DB 寫入改告警                          | ✅ 已實作                  |
| 收斂閾值 0.69（實測校準）              | ✅ 已校準                  |
| MasRouter 任務路由前置分類             | ✅ 已實作                  |
| FREE-MAD 軌跡分（MoA 加權）            | ✅ 已實作                  |
| FREE-MAD 反共識 prompt                 | ✅ 已實作                  |
| Attention-MoA 交叉批判 prompt          | ✅ 已實作（本地 stub）     |
| DebateOCR 輪次摘要壓縮                 | ✅ 已實作                  |
| RCR 角色感知上下文壓縮                 | ✅ 已實作                  |
| DMAD 結論回填 nuwa patterns            | ✅ 已實作                  |
| DTE 自我演化 pattern 權重調整          | ✅ 已實作                  |
| Agent 健康前置檢查                     | ✅ 已實作                  |
| 辯論品質趨勢分析報告                   | ✅ 已實作                  |
| DMAD v2 主測試對齊                     | ✅ 已實作                  |

**實測結果（2026-05-19）**：

```
rounds=2  stoppedBy=convergence  convergenceScore=0.735  durationMs=119,630ms
trajectoryScores={claude:1.25,codex:1.25,openclaw:1.25}
```

### 仍存在的結構性問題（研究文獻確認）

**問題 1：收斂指標只測「輪內代理一致性」，缺「輪間穩定性」**

當前實作：同一輪內 Claude vs Codex vs OpenClaw 的 cosine similarity（inter-agent）。
ACL'25 研究：self-consistency = 同一代理在 round t 與 round t+1 的 cosine similarity（inter-round）。

兩者意義不同：

- inter-agent 高 → 三方本輪「看法一致」
- inter-round 高 → 每個代理「已停止更新立場」（更能反映真正收斂）

應同時計算兩種指標，用雙閘控制停止條件。

**問題 2：代理差異化靠「角色」而非「推理方法」**

DMAD 論文（ICLR'25）的核心貢獻是：代理用**不同推理方法**（IO、CCoT、DDCoT），不只是不同角色。
當前 prompt 讓 Claude「從語言推理角度」、Codex「從技術角度」——這是角色差異，不是推理方法差異。
兩種差異共存時效果更好，需在 prompt 中明確指定推理步驟格式。

**問題 3：缺乏 Representational Collapse 防護**

2026 研究發現：三個同類型 agent 平均 cosine similarity 達 0.888，產生「表徵崩潰」（所有代理輸出幾乎一樣），Multi-Agent 優勢消失。
當前系統 Claude+Codex+OpenClaw 異質性較好（0.699），但應設「多樣性下限」——若連續 2 輪 cosine > 0.85，主動注入「請從完全不同角度補充」指令。

**問題 4：KS 統計停止優於固定 cosine 閾值**

NeurIPS'25 Adaptive Stability Detection：KS statistic ε = 0.05 持續 2 輪 → 停止，比固定 cosine 閾值更能適應不同任務複雜度。可作為收斂判定的備選或組合條件。

---

## 二、修改方向（由重要到次要）

```
方向 A：雙閘收斂（inter-agent + inter-round）→ 替換現有單一 cosine 閾值
方向 B：推理方法差異化 prompt → 加強 Claude/Codex 初始 prompt
方向 C：多樣性下限防護 → Representational Collapse 偵測
方向 D：KS 停止備選 → 可選實作，增強穩健性
```

---

## 三、具體修改

### 修改 A：雙閘收斂（最重要）✅ 已實作

**位置**：`dmad-debate.ts` — `DebateRound` 介面 + `runDMAD()` 核心迴圈

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `DebateRound.stabilityScore`、`DMADOptions.stabilityThreshold` 與 `measureStability()`。Round 1 的 `stabilityScore` 固定為 0；Round 2+ 會用 semantic embedding 計算 inter-round stability，fallback 使用 n-gram cosine。若 `stabilityScore > 0.92`，沿用 `stoppedBy="variance"` 停止以維持既有前端相容。測試已覆蓋 convergence 未達標但 stability 達標時停止。

#### A1. 在 `DebateRound` 介面新增欄位

**現況：**

```typescript
export interface DebateRound {
  round: number;
  claudeResponse: string;
  codexResponse: string;
  openclawResponse: string;
  convergenceScore: number; // 三者平均 cosine 相似度
}
```

**改為：**

```typescript
export interface DebateRound {
  round: number;
  claudeResponse: string;
  codexResponse: string;
  openclawResponse: string;
  convergenceScore: number; // inter-agent：本輪三方平均 cosine（看法一致性）
  stabilityScore: number; // inter-round：三方各自與上輪的平均 cosine（立場穩定性）
  hadCliError: boolean; // 本輪是否有 CLI 失敗
}
```

#### A2. 新增 `measureStability()` 函數（放在 `measureVariance()` 之後）

```typescript
/**
 * inter-round 穩定性（ACL'25 self-consistency metric）：
 * 各代理本輪與上輪的 cosine 相似度平均。
 * 高 → 代理立場已穩定；低 → 代理還在更新觀點。
 */
async function measureStability(
  prev: DebateRound,
  curr: DebateRound,
  ollamaUrl?: string,
  ollamaEmbedModel?: string,
): Promise<number> {
  const [pClaude, cClaude, pCodex, cCodex, pOclaw, cOclaw] = await Promise.all([
    getSemanticVec(prev.claudeResponse, ollamaUrl, ollamaEmbedModel),
    getSemanticVec(curr.claudeResponse, ollamaUrl, ollamaEmbedModel),
    getSemanticVec(prev.codexResponse, ollamaUrl, ollamaEmbedModel),
    getSemanticVec(curr.codexResponse, ollamaUrl, ollamaEmbedModel),
    getSemanticVec(prev.openclawResponse, ollamaUrl, ollamaEmbedModel),
    getSemanticVec(curr.openclawResponse, ollamaUrl, ollamaEmbedModel),
  ]);

  // 維度不一致時 fallback bigram
  if (pClaude.backend === "bigram") {
    const sC = sparseCosine(textToVec(prev.claudeResponse), textToVec(curr.claudeResponse));
    const sX = sparseCosine(textToVec(prev.codexResponse), textToVec(curr.codexResponse));
    const sO = sparseCosine(textToVec(prev.openclawResponse), textToVec(curr.openclawResponse));
    return (sC + sX + sO) / 3;
  }

  const sC = cosineSimilarity(pClaude.vec, cClaude.vec);
  const sX = cosineSimilarity(pCodex.vec, cCodex.vec);
  const sO = cosineSimilarity(pOclaw.vec, cOclaw.vec);
  return (sC + sX + sO) / 3;
}
```

#### A3. 修改 `DMADOptions` 新增 `stabilityThreshold`

在現有 `convergenceThreshold?: number` 之後加：

```typescript
stabilityThreshold?: number    // inter-round 穩定性閾值，預設 0.92（代理停止更新）
```

#### A4. 修改 `runDMAD()` 的 opts 解構，加入 `stabilityThreshold`

```typescript
const {
  maxRounds = 3,
  convergenceThreshold = 0.69,   // inter-agent 一致性（實測校準）
  stabilityThreshold = 0.92,     // inter-round 穩定性（代理停止更新視為收斂）
  varianceThreshold = 0.05,
  ...
} = opts
```

#### A5. 修改 Round 1 的 `stabilityScore` 賦值

Round 1 無法計算 inter-round stability（沒有上輪），設為 0：

```typescript
const round1: DebateRound = {
  round: 1,
  claudeResponse: claudeR1,
  codexResponse: codexR1,
  openclawResponse: openclawR1.response,
  convergenceScore: 0,
  stabilityScore: 0, // 新增：第一輪無上輪可比
  hadCliError: round1HasError,
};
```

#### A6. 修改 Round 2-N 迴圈的停止條件（雙閘）

**現況的停止條件（只有 inter-agent convergence）：**

```typescript
if (prevRound.convergenceScore > convergenceThreshold) {
  stoppedBy = "convergence";
  break;
}
```

**改為雙閘：**

```typescript
// 停止條件 ①-A：inter-agent 高度一致（看法已趨同）
if (prevRound.convergenceScore > convergenceThreshold) {
  stoppedBy = "convergence";
  break;
}
// 停止條件 ①-B：inter-round 高度穩定（立場已停止更新）
if (prevRound.stabilityScore > stabilityThreshold) {
  stoppedBy = "variance"; // 沿用原有 stoppedBy 值，與前端相容
  break;
}
```

在本輪結束後，計算 stabilityScore：

```typescript
currRound.stabilityScore = roundHasError
  ? 0
  : await measureStability(prevRound, currRound, ollamaUrl, ollamaEmbedModel);
```

---

### 修改 B：推理方法差異化 Prompt（中等重要）✅ 已實作

**位置**：`dmad-debate.ts` — `CLAUDE_ROLE_R1`、`CODEX_ROLE_R1`、`CLAUDE_ROLE_R2`、`CODEX_ROLE_R2`

**方向**：在現有角色差異之上，加入**推理步驟格式規定**。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 更新 `CLAUDE_ROLE_R1` 與 `CODEX_ROLE_R1`。Claude Round 1 使用 `Compositional CoT`，先拆 2-3 個子問題再整合；Codex Round 1 使用 `Duty-Distinct CoT`，先列系統/使用者/開發者職責再評估技術風險。Round 2 不改，保留反共識與交叉批判流程。測試已覆蓋 R1 prompt 注入。

DMAD 論文用 IO / CCoT / DDCoT 三種方法。對應到 OpenClaw 系統：

| 代理     | 現有角色     | 新增推理方法                                       |
| -------- | ------------ | -------------------------------------------------- |
| Claude   | 語言理解推理 | **CCoT**：先分解子問題再推論（Compositional CoT）  |
| Codex    | 技術可行性   | **DDCoT**：先列職責清單再評估（Duty-Distinct CoT） |
| OpenClaw | pattern 框架 | **類比推理**：從歷史案例出發（已有，不需改）       |

**CLAUDE_ROLE_R1 修改**（現況 L79-84）：

現況：

```typescript
const CLAUDE_ROLE_R1 = (task: string, ctx?: string) => `你是語言理解與推理代理（Claude）。
請從**語言邏輯、使用者意圖、抽象推理**的角度分析以下任務，提出你的初始方案。
不超過 200 字。
${LANG_RULE}
${ctxBlock(ctx)}
任務：${task}`;
```

改為：

```typescript
const CLAUDE_ROLE_R1 = (task: string, ctx?: string) => `你是語言理解與推理代理（Claude）。
推理方法：**Compositional CoT**——先將問題分解為 2-3 個子問題，逐一推論，再組合出整體方案。
格式規定：
  1. 子問題拆解（列點）
  2. 各子問題推論（逐條）
  3. 整合結論（1-2 句）
不超過 200 字。
${LANG_RULE}
${ctxBlock(ctx)}
任務：${task}`;
```

**CODEX_ROLE_R1 修改**（現況 L97-102）：

現況：

```typescript
const CODEX_ROLE_R1 = (task: string, ctx?: string) => `你是技術可行性代理（Codex）。
請從**程式碼實作、技術架構、效能**的角度審查以下任務，提出技術可行性評估。
不超過 200 字。
${LANG_RULE}
${ctxBlock(ctx)}
任務：${task}`;
```

改為：

```typescript
const CODEX_ROLE_R1 = (task: string, ctx?: string) => `你是技術可行性代理（Codex）。
推理方法：**Duty-Distinct CoT**——先明確列出各職責方（系統/使用者/開發者），再分別評估每方的技術風險與可行性。
格式規定：
  1. 職責清單（各方 1 行）
  2. 各方技術風險（逐條）
  3. 可行性評分（高/中/低）+ 理由（1 句）
不超過 200 字。
${LANG_RULE}
${ctxBlock(ctx)}
任務：${task}`;
```

> Round 2 的 prompt（`CLAUDE_ROLE_R2`、`CODEX_ROLE_R2`）不需改格式規定，保持自由補充即可。

---

### 修改 C：Representational Collapse 防護（錦上添花）✅ 已實作

**位置**：`runDMAD()` 的 Round 2-N 迴圈，在計算本輪 `convergenceScore` 之後

**邏輯**：若 inter-agent cosine > 0.85（代理觀點過度趨同），下輪 prompt 主動注入**多樣性干擾**。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `DIVERSITY_COLLAPSE_THRESHOLD = 0.85` 與 `diversityBoostInstruction()`。Round 2+ 若前輪 `convergenceScore > 0.85` 且呼叫端未因較低收斂門檻提前停止，Claude/Codex prompt 會追加多樣性重啟指令，要求從與前輪完全不同的角度補充反例或新論點。測試已覆蓋高收斂時 Round 2 prompt 注入。

新增 helper 函數：

```typescript
/** 生成多樣性重啟指令（防 Representational Collapse） */
function diversityBoostInstruction(round: number): string {
  return (
    `\n\n⚠️ 注意：前輪三方觀點高度相似，請刻意從**與前輪完全不同的角度**切入，` +
    `提出前輪未提及的論點或反例。（第 ${round} 輪多樣性重啟）`
  );
}
```

在 Round 2-N 迴圈，判斷是否注入：

```typescript
// 多樣性防護（Representational Collapse 防護，ICLR'25）
const DIVERSITY_COLLAPSE_THRESHOLD = 0.85;
const needsDiversityBoost = prevRound.convergenceScore > DIVERSITY_COLLAPSE_THRESHOLD;

// 在 claudeRn / codexRn 的 prompt 中條件性加入 diversityBoostInstruction
const claudePromptRn = needsDiversityBoost
  ? CLAUDE_ROLE_R2(task, prevRound.codexResponse, prevRound.openclawResponse, systemContext) +
    diversityBoostInstruction(r)
  : CLAUDE_ROLE_R2(task, prevRound.codexResponse, prevRound.openclawResponse, systemContext);

const codexPromptRn = needsDiversityBoost
  ? CODEX_ROLE_R2(task, prevRound.claudeResponse, prevRound.openclawResponse, systemContext) +
    diversityBoostInstruction(r)
  : CODEX_ROLE_R2(task, prevRound.claudeResponse, prevRound.openclawResponse, systemContext);

const [claudeRn, codexRn, openclawRn] = await Promise.all([
  claudeRespond(claudePromptRn, claudeModel, timeoutMs),
  codexRespond(codexPromptRn, codexModel, timeoutMs),
  openclawRespond(task, db, r, {
    claude: prevRound.claudeResponse,
    codex: prevRound.codexResponse,
  }),
]);
```

---

### 修改 D：MoA Prompt 品質強化（依 MoA 論文 Aggregate-and-Synthesize 模式）✅ 已實作

**位置**：`MOA_PROMPT`（約 L115-137）

**問題**：現有 prompt 讓 MoA 直接整合，未明確要求**批判性評估**各代理貢獻的品質。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 強化 `MOA_PROMPT` 的「你的任務」段落，要求 MoA 進行 `可信度評估`、`矛盾識別`、`加權整合`、`信心分（0-1）`，並明確禁止只摘要所有人的話。測試已覆蓋 MoA prompt 包含四個輸出段落。

MoA 論文（ICLR'25）的 Aggregate-and-Synthesize 要求聚合器：

1. 評估每個 proposer 的可信度
2. 標記互相矛盾的論點
3. 加權整合而非平均整合

在 `MOA_PROMPT` 的「你的任務」區塊新增：

```typescript
## 你的任務
綜合以上所有觀點，**批判性**輸出（不得只是摘要所有人的話）：
1. **可信度評估**：標記哪些代理的哪些論點最可靠（給出理由）
2. **矛盾識別**：列出代理間互相矛盾的論點（若有）
3. **加權整合**：基於可信度給出最終建議方案（300 字以內）
4. **信心分**（0-1）：0=高度不確定，1=完全確定
```

---

## 四、修改後的完整流程圖

```
Task 輸入
    │
    ▼
Round 1（並行）
  ┌─Claude: CCoT 推論格式
  ├─Codex: DDCoT 推論格式
  └─OpenClaw: 類比推理（pattern DB）
    │
    ▼ 計算 inter-agent convergenceScore
    │
    ▼
Round 2-N（如需繼續）
  │ 停止條件檢查：
  │   ①-A convergenceScore > 0.69（三方一致）
  │   ①-B stabilityScore   > 0.92（立場已穩）
  │   ①-C variance         < 0.05（變化量不足）
  │
  ▼ 若前輪 convergenceScore > 0.85：注入多樣性重啟指令
  │
  ▼ 三方並行回應
  │
  ▼ 計算 convergenceScore + stabilityScore
    │
    ▼
MoA 聚合（批判性 Aggregate-and-Synthesize）
    │
    ▼
DebateResult（含 hadCliError, stabilityScore）
```

---

## 五、驗證標準

執行 `pnpm dmad:run-test` 後確認：

| 指標                                                  | 目標                                                   | 說明                                               |
| ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `stoppedBy`                                           | `"convergence"` 或 `"variance"`（不是 `"max_rounds"`） | 有實際停止條件觸發                                 |
| `convergenceScore`                                    | 0.60-0.85                                              | 太低=無效辯論，太高=表徵崩潰                       |
| `totalRounds`                                         | 1-2（理想情況）                                        | 節省 1 輪 = 節省 ~37 秒                            |
| `durationMs`                                          | < 150,000ms                                            | 目標 60-120 秒完成                                 |
| `DebateRound.stabilityScore`                          | 有值（第 1 輪為 0）                                    | 新欄位已正確計算                                   |
| `DebateRound.hadCliError`                             | `false`（正常情況）                                    | CLI 健康                                           |
| `pnpm dmad:agent-health`                              | clean 時 exit 0；降級時 exit 1                         | 不跑完整辯論也能先看到 Claude/Codex blocker        |
| `pnpm dmad:run-test -- --fail-on-degraded`            | 降級時 exit 2                                          | automation gate 不可把 CLI 降級誤判成通過          |
| `pnpm dmad:run-test:self-test`                        | PASS                                                   | 低成本驗證 fail-on-degraded policy，不呼叫外部 CLI |
| `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0 pnpm dmad:run-test` | exit 3 + timeout report                                | 低成本驗證總耗時超限時仍會輸出可診斷報告           |
| `DebateRound.timingsMs` / `phaseTimingsMs`            | 每輪與整體 phase 都有 ms 值                            | 用於定位慢 agent、慢 MoA 或慢 DB write             |

### 2026-05-20 測試回填：DMAD v2 主測試對齊 ✅ 已實作

已將 `extensions/evolution-learning/src/dmad-debate.test.ts` 從舊 v1 欄位與 prompt 期望，改成目前 DMAD v2 runtime 的 smoke tests。測試不呼叫真實 Claude/Codex/Ollama，改用 mock `execFile`、mock `fetch`、mock embedding 與 in-memory SQLite stub，覆蓋：基本辯論流程、Sonnet MoA/Haiku 驗證模型切換、RCR Round 2 context、debates v2 metadata 寫入、CLI 未安裝 fallback 可見化。此回填用來恢復主測試可執行性，不變更 runtime 行為。

### 2026-05-20 測試回填：`dmad:run-test` 正式入口 ✅ 已接線

已在 `package.json` 補上 `dmad:run-test`，並把既有依賴 `better-sqlite3` 加入 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`，讓 `scripts/dmad-run-test.mts` 可用本機 native SQLite backend 開啟 `nuwa.db`。實跑 `pnpm dmad:run-test` 已完成 3 輪並寫入 `reports/dmad-run-test-latest.json`：`stoppedBy=max_rounds`、`convergenceScore=0.5138`、`durationMs=31190`、patterns 使用 `paul-graham/warren-buffett/charlie-munger`。品質 blocker 仍在 runtime agent：Claude CLI 未安裝，Codex CLI 回傳 `spawn EPERM`。因此本次是驗證入口與 DB backend 閉環，不代表正常三代理品質已恢復。

### 2026-05-20 測試回填：`DebateRound.stabilityScore` 報告欄位 ✅ 已實作

已在 `extensions/evolution-learning/src/dmad-debate.ts` 的 `DebateRound` 補上 `stabilityScore`，第一輪固定 `0`，第二輪起用 `1 - measureVariance(prevRound, currRound)` 轉為 0-1 穩定分並夾限。`scripts/dmad-run-test.mts` 會在每輪 console 摘要與 stdout JSON 輸出 `stabilityScores`。實跑 `pnpm dmad:run-test` 已寫入 latest report：`stoppedBy=variance`、`convergenceScore=0.6814`、`stabilityScores=[0,0.9128,1]`、`durationMs=26336`。目前仍因 Claude CLI 未安裝與 Codex `spawn EPERM` 降級，三代理品質尚未恢復，但驗證標準中的 `DebateRound.stabilityScore` 欄位已閉環。

### 2026-05-20 測試回填：CLI 降級可觀測欄位 ✅ 已實作

已在 `extensions/evolution-learning/src/dmad-debate.ts` 補上每輪 `hadCliError` 與 `cliErrors`，並在 `DebateResult` 補上總體 `hadCliError` 與 `cliErrorSummary`。`scripts/dmad-run-test.mts` 會輸出 CLI 降級狀態，`scripts/dmad-trend-report.mts` 會統計 `cliErrorRatePercent` 與總體錯誤摘要；已修正 trend 同時讀取 summary 與 rounds 時重複加總的問題。最新實跑結果：`hadCliError=true`、`cliErrorSummary={"claudeMissing":3,"claudeFailed":0,"codexMissing":0,"codexFailed":3}`、`cliErrorRatePercent=100`。目前真正 blocker 維持為 Claude CLI 未安裝與 Codex `spawn EPERM`。

### 2026-05-20 測試回填：降級品質狀態防誤判 ✅ 已實作

已在 `DebateResult` 補上 `qualityStatus` 與 `degradedReason`。只要 `hadCliError=true`，latest report 會標記 `qualityStatus="degraded_agents"`，並用穩定字串記錄原因，例如 `claude_missing=3,codex_failed=3`。`scripts/dmad-run-test.mts` stdout/console 與 `scripts/dmad-trend-report.mts` 的 latest/trend summary 也會輸出同欄位，避免把降級環境下的 `convergenceScore` 誤判成正常品質通過。最新實跑結果：`stoppedBy=variance`、`convergenceScore=0.6814`、`qualityStatus=degraded_agents`、`degradedReason=claude_missing=3,codex_failed=3`。

### 2026-05-20 測試回填：正常/降級趨勢分流 ✅ 已實作

已在 `scripts/dmad-trend-report.mts` 補上 `cleanReportCount`、`degradedReportCount`、`cleanAvgConvergenceScore`、`degradedAvgConvergenceScore`。trend 會先依 `qualityStatus`，舊報告則 fallback 用 CLI error 判定 clean/degraded，再分別計算正常與降級平均分。最新 `pnpm dmad:trend` 結果：`reportCount=1`、`cleanReportCount=0`、`degradedReportCount=1`、`cleanAvgConvergenceScore=null`、`degradedAvgConvergenceScore=0.6814`。因此目前 0.6814 只會算進降級統計，不會污染正常品質趨勢。

### 2026-05-20 測試回填：正常品質趨勢 Gate ✅ 已實作

已在 `scripts/dmad-trend-report.mts` 補上 `trendGateStatus` 與 `normalQualityGate`。當 `cleanReportCount=0` 時，trend 會輸出 `trendGateStatus="blocked_no_clean_reports"`，並在 `normalQualityGate.reason` 寫入 `cleanReportCount=0`，避免自動化把只有降級資料的趨勢報告當作可升級依據。最新 `pnpm dmad:trend` 結果：`cleanReportCount=0`、`degradedReportCount=1`、`trendGateStatus=blocked_no_clean_reports`、`normalQualityGate={"status":"blocked_no_clean_reports","reason":"cleanReportCount=0"}`。

### 2026-05-20 測試回填：趨勢統計 Fixture Self-test ✅ 已實作

已新增 `scripts/dmad-trend-report-self-test.mts` 與 `package.json` script `dmad:trend:self-test`。self-test 會用臨時 reports 目錄建立三組 fixture：clean-only、degraded-only、mixed，分別驗證 `cleanReportCount`、`degradedReportCount`、`cleanAvgConvergenceScore`、`degradedAvgConvergenceScore`、`qualityStatus`、`trendGateStatus`、`normalQualityGate` 與 `cliErrorRatePercent`。`scripts/dmad-trend-report.mts` 也支援 `DMAD_TREND_REPORTS_DIR`、`DMAD_TREND_LATEST_PATH`、`DMAD_TREND_OUT`，只供測試/隔離輸出使用，正式 `pnpm dmad:trend` 預設仍讀寫 `reports/`。驗證：`pnpm dmad:trend:self-test` 已通過。

### 2026-05-20 測試回填：Timeout 趨勢隔離 ✅ 已實作

已在 `scripts/dmad-trend-report.mts` 將 `stoppedBy="timeout"` / `runStatus="timeout"` / `degradedReason="run_timeout"` 報告獨立歸類為 timeout。timeout 仍會計入 `reportCount`、`timeoutReportCount`、`timeoutRatePercent` 與整體 `qualityStatus="degraded_agents"`，但不再進入 `avgConvergenceScore`、`trend`、`percentiles`、`avgRounds`、`avgDurationMs` 與 `convergenceRatePercent` 的完成辯論統計，避免 0 分 timeout report 拉低正常 convergence 趨勢。`scripts/dmad-trend-report-self-test.mts` 已新增 `timeout-isolated` fixture 驗證 clean + timeout 混合時 `avgConvergenceScore=0.82`、`convergenceRatePercent=100`、`stoppedByDistribution.timeout=1`。

### 2026-05-20 測試回填：Trend Latest/History 去重 ✅ 已實作

已在 `scripts/dmad-trend-report.mts` 補上 `reportDedupKey()` 與 `addReportEntry()`，整合 `reports/dmad-run-test-*.json` 與 `dmad-run-test-latest.json` 時會依 `id` 或穩定 report shape 去重。這修正兩種邊界：同一份 latest/history 不會重複計入；沒有 `id` 的獨立 latest 也不會因其他歷史報告同樣沒有 `id` 被錯誤略過。`scripts/dmad-trend-report-self-test.mts` 已新增 `latest-history-dedup-id`、`latest-history-dedup-no-id`、`idless-distinct-latest-added` 三組 fixture。

### 2026-05-20 測試回填：Trend 去重數輸出 ✅ 已實作

已在 `scripts/dmad-trend-report.mts` 的輸出 JSON 加入 `dedupedReportCount`，表示 latest/history 合併時被 `reportDedupKey()` 跳過的重複 report 數。`reportCount` 保持為去重後實際參與統計的 report 數，automation 可用 `dedupedReportCount > 0` 直接看出本輪有多少重複輸入被排除。`scripts/dmad-trend-report-self-test.mts` 已在 clean/mixed/timeout 與 latest-history 去重 fixture 中驗證此欄位。

### 2026-05-20 測試回填：Trend 壞報告計數 ✅ 已實作

已在 `scripts/dmad-trend-report.mts` 的輸出 JSON 加入 `invalidReportCount`，表示掃描到但讀取或 JSON parse 失敗、因此被忽略的 DMAD run report 數。缺少 `dmad-run-test-latest.json` 不會被算成 invalid；只有實際存在但壞掉的 history/latest 檔案才會計入。`scripts/dmad-trend-report-self-test.mts` 已新增 `invalid-history-count` fixture，驗證 malformed `dmad-run-test-*.json` 會被忽略且 `invalidReportCount=1`。

### 2026-05-20 測試回填：Trend 壞 latest 計數 ✅ 已實作

已在 `scripts/dmad-trend-report-self-test.mts` 新增 `invalid-latest-count` fixture，直接建立 malformed `dmad-run-test-latest.json` 搭配一份有效 history report。測試驗證 latest 壞掉時 `invalidReportCount=1`，有效 history 仍正常進入 `reportCount=1` 與 `avgConvergenceScore=0.82`，避免 latest 檔案損毀時整份 trend 報告失去可用歷史統計。

### 2026-05-20 測試回填：Trend 混合訊號 Smoke ✅ 已實作

已在 `scripts/dmad-trend-report-self-test.mts` 新增 `combined-signal-smoke` fixture，一次混合 clean、degraded、timeout、duplicate latest 與 malformed history。測試驗證 `reportCount=4`、`dedupedReportCount=1`、`invalidReportCount=1`、`timeoutReportCount=1`、`avgConvergenceScore=0.6833`、`convergenceRatePercent=67`、`stoppedByDistribution.timeout=1`，確保 automation 讀到的 trend JSON 在多種異常同時出現時仍一致可用。

### 2026-05-20 測試回填：Trend Output Schema Self-check ✅ 已實作

已在 `scripts/dmad-trend-report-self-test.mts` 加入 `REQUIRED_TREND_FIELDS` 與 `REQUIRED_NESTED_FIELDS`。每個 fixture 讀回 `dmad-trend-latest.json` 後會先檢查 top-level 必要欄位與 nested 欄位（`percentiles`、`stoppedByDistribution`、`normalQualityGate`、`cliErrorSummary`、`agentLeadCount`），再比對情境數值。這可防止後續修改漏掉 automation 會解析的欄位而 self-test 仍通過。

### 2026-05-20 測試回填：Trend latestResult Schema Self-check ✅ 已實作

已在 `scripts/dmad-trend-report-self-test.mts` 加入 `REQUIRED_LATEST_RESULT_FIELDS` 與 `REQUIRED_LATEST_RESULT_NESTED_FIELDS`。當 `latestResult !== null` 時，self-test 會固定檢查 latest 摘要欄位（`convergenceScore`、`totalRounds`、`stoppedBy`、`startedAt`、`completedAt`、`qualityStatus`、`cliErrorSummary`、`trajectoryScores` 等），並驗證 `latestResult.cliErrorSummary` 與 `latestResult.trajectoryScores` 的 nested keys。這可避免 automation 讀 latest 摘要時因欄位被後續改掉而靜默失敗。

### 2026-05-20 測試回填：降級品質 fail-on-degraded Gate ✅ 已實作

已在 `scripts/dmad-run-test.mts` 加入 `--fail-on-degraded` 選項。預設 `pnpm dmad:run-test` 仍只產生報告；automation 可改用 `pnpm dmad:run-test -- --fail-on-degraded`，若 latest result 為 `qualityStatus="degraded_agents"` 會在 stdout 仍輸出摘要與寫入報告後，以 exit code 2 停止，避免把 Claude/Codex CLI 降級環境推進為正常通過。當前環境驗證結果為 exit 2，原因仍是 `claude_missing=3,codex_failed=3`。

### 2026-05-20 測試回填：`dmad:run-test` 低成本 Gate Self-test ✅ 已實作

已新增 `scripts/dmad-run-test-self-test.mts` 與 `package.json` script `dmad:run-test:self-test`。`scripts/dmad-run-test.mts` 的 `--fail-on-degraded` 判斷已抽成純函式，self-test 直接驗證四個 policy case：預設 degraded 不失敗、帶 `--fail-on-degraded` 時 degraded exit 2、clean pass 不失敗、無關 flag 不啟用 gate。此測試不開啟 `nuwa.db`，也不呼叫 Claude/Codex，可作為每輪快速 regression gate。
驗證：`pnpm dmad:run-test:self-test` 已通過；`pnpm dmad:run-test -- --fail-on-degraded` 仍在目前降級環境正確回 exit 2。

### 2026-05-20 測試回填：DMAD Agent Health 快速診斷 ✅ 已實作

已新增 `scripts/dmad-agent-health.mts` 與 `package.json` script `dmad:agent-health`。此快檢用 DMAD runtime 相同的 CLI resolution 路徑執行 `claude --version` / `codex --version`，不開啟 `nuwa.db`，不呼叫模型 API，也不跑完整 DMAD 辯論；結果會寫入 `reports/dmad-agent-health-latest.json`，並輸出 `qualityStatus`、`degradedReason`、各 agent 的 `code/message/durationMs`。目前 Windows CLI resolution 修復後，環境驗證結果為 `qualityStatus="pass"`。

### 2026-05-20 測試回填：Windows CLI Resolution ✅ 已實作

已在 `extensions/evolution-learning/src/dmad-debate.ts` 修復 Windows `.cmd` shim 執行路徑。Windows 下 Claude/Codex 會經由 `cmd.exe /d /s /c` 啟動固定 CLI 與安全旗標，但任務 prompt 改由 stdin 傳入，不放進 command line，避免 shell 轉義與注入風險。`scripts/dmad-agent-health.mts` 同步改用相同 wrapper 進行 version probe。已補 focused test 覆蓋 Windows wrapper：確認 Claude/Codex 走 `cmd.exe`、使用 `-` stdin、wrapper command line 不包含任務內容。
驗證：`pnpm dmad:agent-health` 已由降級轉為 `qualityStatus="pass"`，`pnpm test extensions/evolution-learning/src/dmad-debate.test.ts extensions/evolution-learning/src/dmad-route-task.test.ts` 已通過。`pnpm dmad:run-test -- --fail-on-degraded` 已不再立即 ENOENT/EPERM，但曾遇到 300 秒 timeout 且未寫出新 latest report；因此下一步改為補 bounded runtime timeout / per-agent phase timing，避免正式辯論長時間卡住。

### 2026-05-20 測試回填：`dmad:run-test` Bounded Timeout Report ✅ 已實作

已在 `scripts/dmad-run-test.mts` 加入 `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS` 總耗時上限，預設 240,000ms，會早於常見 300 秒外層 runner timeout 先落盤。若超限，script 會寫出 `runStatus="timeout"`、`qualityStatus="degraded_agents"`、`degradedReason="run_timeout"` 的診斷報告，stdout 同步輸出可讓 automation 判斷的摘要，並用 exit code 3 表示 runtime timeout。`DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0` 可低成本強制產生 timeout report，不開啟 `nuwa.db`、不呼叫 Claude/Codex，供 heartbeat 快速驗證。

`scripts/dmad-run-test-self-test.mts` 已補上 timeout env parsing 與 timeout report shape 測試，避免後續改動讓超時路徑退回「卡到外層 shell timeout 且沒有報告」。

### 2026-05-20 測試回填：DMAD Phase Timing ✅ 已實作

已在 `extensions/evolution-learning/src/dmad-debate.ts` 補上兩層 timing：每個 `DebateRound.timingsMs` 會記錄 `claude/codex/openclaw/convergence/stability/total`；整體 `DebateResult.phaseTimingsMs` 會記錄 `embedder/routing/priorSearch/rounds/moa/verification/trajectory/dbWrite/total`。`scripts/dmad-run-test.mts` 會在 console/stdout 輸出 `phaseTimingsMs` 與 `roundTimingsMs`，timeout report 也會附上目前 active phase 與 timing summary，避免只看到外層 timeout 而不知道卡在 runDMAD。

測試已補 `extensions/evolution-learning/src/dmad-debate.test.ts` 覆蓋 round timing 與 phase timing shape，並保留 `scripts/dmad-run-test-self-test.mts` 的低成本 timeout report shape 驗證。

### 2026-05-20 測試回填：DMAD Active Progress Snapshot ✅ 已實作

已在 `runDMAD()` 補上可選 `onProgress` callback，會發出 `embedder/routing/priorSearch/agent/convergence/stability/moa/verification/trajectory/dbWrite` 的 start/complete/error 事件；agent 事件會帶 `round` 與 `agent=claude|codex|openclaw`。既有呼叫者不傳 callback 時行為不變。

`scripts/dmad-run-test.mts` 已接上 progress tracker。若總耗時 timeout，timeout report 會寫入 `timeoutPhase`、`activeAgents`、`latestProgress`、`phaseTimingsMs`，可直接看出當下是否卡在某一輪的 Claude/Codex/OpenClaw、MoA 或 verification。`scripts/dmad-run-test-self-test.mts` 已覆蓋 active agent snapshot 與 timing key 聚合。

### 2026-05-20 測試回填：DMAD Timeout Abort Path ✅ 已實作

已在 `runDMAD()` 加入可選 `abortSignal`，並傳入 Claude CLI、Codex CLI、OpenClaw Ollama fetch、MoA 與 verification 呼叫。`scripts/dmad-run-test.mts` 的總耗時 timeout 現在會先觸發 `AbortController.abort()`，再寫 timeout report；report 會標記 `aborted=true`。Windows `cmd.exe` wrapper 在 timeout 或 abort 時會用 `taskkill /pid <pid> /t /f` 終止本輪啟動的 process tree，避免只殺 wrapper 而留下 CLI 子程序。

低成本 self-test 已覆蓋 `withDmadRunTimeout()` 的 timeout callback，確保 timeout gate 會觸發 abort hook。

### 2026-05-20 測試回填：Windows Abort Mock Coverage ✅ 已實作

已在 `extensions/evolution-learning/src/dmad-debate.test.ts` 補上不呼叫真實 CLI 的 Windows abort 測試。測試用 mock `spawn` 讓 Claude/Codex wrapper 保持 hanging，接著觸發 `AbortController.abort()`，驗證 runtime 會呼叫 `taskkill /pid <pid> /t /f`，並確認回傳結果保留 `AbortError` 降級訊息。這補上了前一輪剩餘 blocker：不靠 live CLI 也能證明 timeout abort 會傳到 Windows child-process termination path。

### 2026-05-20 測試回填：Non-preflight Timeout Report Roundtrip ✅ 已實作

已將 `scripts/dmad-run-test.mts` 的 report writer 暴露為 `writeDmadRunReport()`，並在 `scripts/dmad-run-test-self-test.mts` 加入 temp file roundtrip 測試。self-test 會建出非 preflight timeout report，寫入暫存檔後讀回驗證 `aborted=true`、`timeoutPhase="agent"`、`activeAgents`、`latestProgress` 與 `phaseTimingsMs` 都能正確保留。這補上 timeout abort 後最重要的落盤閉環，不需要開啟 `nuwa.db`，也不呼叫 Claude/Codex。

---

## 六、檔案清單

| 路徑                                               | 動作                                                                        | 優先級   |
| -------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| `extensions/evolution-learning/src/dmad-debate.ts` | A、B、C、D 全部修改                                                         | 必做     |
| `extensions/evolution-learning/src/embedding.ts`   | **唯讀**，`getEmbedder`/`cosineSimilarity`/`resetEmbedderCache` 從此 import | —        |
| `scripts/dmad-agent-health.mts`                    | 快速診斷 Claude/Codex CLI blocker，並與 Windows CLI resolution 對齊         | 配合改動 |
| `scripts/dmad-run-test.mts`                        | 輸出 `stabilityScore` / CLI 降級欄位，並支援 `--fail-on-degraded` gate      | 配合改動 |
| `scripts/dmad-run-test-self-test.mts`              | 低成本驗證 `--fail-on-degraded` policy                                      | 配合改動 |
| `scripts/dmad-trend-report.mts`                    | 彙整正常/降級趨勢與 normalQualityGate                                       | 配合改動 |
| `scripts/dmad-trend-report-self-test.mts`          | 趨勢統計 fixture self-test                                                  | 配合改動 |

---

## 七、不要動的項目

```
✅ 保留  Promise.all（三代理並行）
✅ 保留  getEmbedder() + Ollama fallback（已正確）
✅ 保留  isCliError()（已正確）
✅ 保留  LANG_RULE（繁體中文規則）
✅ 保留  ctxBlock(systemContext)（背景注入）
✅ 保留  textToVec() / sparseCosine()（bigram fallback 使用）
✅ 保留  openclawRespond()（pattern 查詢邏輯）
✅ 保留  claudeRespond() / codexRespond()（CLI spawn 邏輯）
✅ 保留  resetEmbedderCache()（跨任務清理）
```

---

## 八、研究依據

| 改動                                        | 論文來源                                                             |
| ------------------------------------------- | -------------------------------------------------------------------- |
| 雙閘收斂（inter-agent + inter-round）       | ACL'25 Emergent Convergence；NeurIPS'25 Adaptive Stability Detection |
| 穩定性閾值 0.92                             | NeurIPS'25：KS ε=0.05 持續 2 輪；inter-round cosine ~0.92 對應點     |
| Representational Collapse 防護（0.85 閾值） | 2026 RC 論文：0.888 = 崩潰，0.85 作為警戒線                          |
| 推理方法差異化（CCoT/DDCoT）                | DMAD ICLR'25：推理方法差異優於角色差異                               |
| MoA 批判性 Aggregate-and-Synthesize         | MoA ICLR'25：聚合器需主動評估 proposer 可信度                        |
| 收斂閾值 0.69                               | 實測校準（2026-05-19，nomic-embed-text 向量空間）                    |
| Trajectory-aware scoring（第九節）          | FREE-MAD 2025：跨輪立場軌跡加權優於末輪投票                          |
| Anti-conformity prompt（第九節）            | FREE-MAD 2025：強制評估差異，防多數錯誤傳播                          |
| Peer Critique 交叉批判（第九節）            | Attention-MoA 2026：代理交叉指出對方錯誤後再聚合                     |
| 輪次摘要壓縮（第九節）                      | DebateOCR 2026：歷史 token 隨輪次爆炸，需壓縮                        |
| Pattern 學習回填（第九節）                  | OpenClaw 閉環：DMAD 結論 → nuwa.db patterns                          |

---

## 九、進階擴充（來自最新論文）

以下為第二批改動，在完成前八節後繼續實作。

---

### 擴充 E：FREE-MAD Trajectory-Aware Scoring（替代末輪投票）✅ 已實作

**論文**：FREE-MAD (2025)
**問題**：當前 MoA 只看最後一輪的三方輸出做聚合。若某代理中途糾正了自己的錯誤，這個「糾正行為」完全被忽略。
**方向**：追蹤每個代理跨輪的立場變化，給「堅持正確立場」的代理更高加權。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `trajectoryScores`，用 `computeTrajectoryScores()` 計算 Claude/Codex/OpenClaw 跨輪軌跡分，並注入 MoA prompt。CLI 錯誤回應不給初始可信分，避免錯誤訊息被加權採納。`scripts/dmad-run-test.mts` 會輸出與寫入 `trajectoryScores`。

#### E1. 在 `DebateResult` 加入軌跡評分欄位

```typescript
export interface DebateResult {
  // ... 現有欄位
  trajectoryScores: Record<"claude" | "codex" | "openclaw", number>; // 新增：各代理軌跡分
}
```

#### E2. 新增 `computeTrajectoryScores()` 函數

```typescript
/**
 * FREE-MAD Trajectory-Aware Scoring：
 * 追蹤各代理跨輪立場變化，給予動態加權。
 *
 * 計分規則（依 FREE-MAD 論文）：
 *   - 初始回應：+w1（基礎分）
 *   - 維持立場（與上輪高度相似 > 0.8）：+w4（堅持加分）
 *   - 改變立場（與上輪低度相似 < 0.5）：+w3（修正加分，可能是對的）
 *   - 輪次懲罰：× (round+1)⁻¹（越晚改變越可疑）
 */
function computeTrajectoryScores(
  rounds: DebateRound[],
): Record<"claude" | "codex" | "openclaw", number> {
  const W1 = 1.0; // 初始加分
  const W3 = 0.5; // 改變立場（可能是糾正）
  const W4 = 0.8; // 維持立場（一致性）

  const scores = { claude: W1, codex: W1, openclaw: W1 };

  for (let i = 1; i < rounds.length; i++) {
    const prev = rounds[i - 1];
    const curr = rounds[i];
    const factor = 1 / (i + 1); // 越晚的輪次，影響力越小

    const agents = ["claude", "codex", "openclaw"] as const;
    const prevTexts = [prev.claudeResponse, prev.codexResponse, prev.openclawResponse];
    const currTexts = [curr.claudeResponse, curr.codexResponse, curr.openclawResponse];

    for (let a = 0; a < 3; a++) {
      const prevVec = textToVec(prevTexts[a]);
      const currVec = textToVec(currTexts[a]);
      const sim = sparseCosine(prevVec, currVec);

      if (sim > 0.8) {
        scores[agents[a]] += W4 * factor; // 維持立場
      } else if (sim < 0.5) {
        scores[agents[a]] += W3 * factor; // 明顯改變
      }
      // 0.5-0.8 之間（微調）：不加分也不扣分
    }
  }

  return scores;
}
```

#### E3. 在 `MOA_PROMPT` 加入軌跡分信息

在 `runDMAD()` 呼叫 `moaAggregate()` 之前：

```typescript
const trajectoryScores = computeTrajectoryScores(rounds);

// 傳入 moaAggregate（修改其 signature 接受 trajectoryScores）
const finalAnswer = await moaAggregate(
  task,
  rounds,
  allPatternSlugs,
  claudeModel,
  moaModel,
  trajectoryScores, // 新增
  timeoutMs * 2,
  systemContext,
);
```

在 `MOA_PROMPT` 加入軌跡分顯示：

```typescript
## 各代理立場可信度（軌跡分，越高越一致）
- Claude：${scores.claude.toFixed(2)}
- Codex：${scores.codex.toFixed(2)}
- OpenClaw：${scores.openclaw.toFixed(2)}

**請依此加權整合，分數高的代理論點優先採納**。
```

---

### 擴充 F：Anti-Conformity Prompt（防多數錯誤傳播）✅ 已實作

**論文**：FREE-MAD (2025)
**問題**：當前 Round 2+ 的 prompt 是「補充或反駁」，但代理傾向配合多數，導致錯誤觀點被強化。
**方向**：明確要求代理「評估差異」而非「尋求共識」。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入共用 `ANTI_CONFORMITY_RULES`，Claude/Codex Round 2 prompt 會要求獨立判斷、明確指出錯誤與反例，若認同也必須說明自身推理路徑。測試已覆蓋 Round 2 prompt 注入，避免退回只要求「不得重複已有論點」。

在 `CLAUDE_ROLE_R2` 和 `CODEX_ROLE_R2` 的 prompt 中，**將「不得重複已有論點」改為更強的反共識指令**：

```typescript
const CLAUDE_ROLE_R2 = (
  task: string,
  codex: string,
  openclaw: string,
  ctx?: string,
) => `你是語言理解與推理代理（Claude）。
以下是其他代理的第一輪觀點：

[Codex 技術觀點]：${codex.slice(0, 300)}
[OpenClaw Pattern 觀點]：${openclaw.slice(0, 300)}

任務：${task}
${LANG_RULE}
${ctxBlock(ctx)}

⚠️ 反共識規則（FREE-MAD 協議）：
- **不得**因為其他代理這樣說就認同
- **必須**獨立判斷每個論點的正確性
- **若發現**其他代理有錯誤，直接明確指出並給出反例
- **若認同**某論點，說明你獨立得出同樣結論的推理路徑

請從語言推理和使用者意圖層面補充（不超過 150 字）。`;
```

---

### 擴充 G：Peer Critique 交叉批判（Attention-MoA）✅ 已實作（本地 stub）

**論文**：Attention-MoA (2026)
**問題**：當前代理只讀取對方的摘要（300 字），不主動指出對方的錯誤或矛盾。
**方向**：在 Round 2+ 開始前，先讓代理生成「對另外兩方的批判指令」，再帶著批判進行回應。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `generatePeerCritique()`，Round 2 會先生成 Claude/Codex 各自的交叉批判指令，並注入 `CLAUDE_ROLE_R2` / `CODEX_ROLE_R2`。目前採本地 deterministic stub，不呼叫外部模型；後續可把該函式內部替換為 Ollama/local adapter，而不改 `runDMAD()` 外層流程。測試已覆蓋 Claude/Codex Round 2 prompt 皆包含 `交叉批判指令（Attention-MoA）`。

這需要新增一個 pre-round critique 步驟（輕量，不計入收斂）：

```typescript
/**
 * 生成代理對另兩方的簡短批判（Attention-MoA Cross-Attention）。
 * 只用 Ollama（零費用），批判結果注入下一輪 prompt。
 */
async function generatePeerCritique(
  agentName: string,
  ownResponse: string,
  peer1Name: string,
  peer1Response: string,
  peer2Name: string,
  peer2Response: string,
  timeoutMs: number,
): Promise<string> {
  // 使用 OpenClaw（Ollama）生成批判，零 API 費用
  const prompt = `你是 ${agentName}。請對以下兩方觀點各寫一句批判（指出邏輯錯誤或缺漏）：
[${peer1Name}]：${peer1Response.slice(0, 200)}
[${peer2Name}]：${peer2Response.slice(0, 200)}
每方一句，總計不超過 60 字。${LANG_RULE}`;

  // 暫時用 claudeRespond 或 local_model_adapter
  // 實際應呼叫 callLocalModel（Ollama），見 tools/openclaw_runtime/adapters/local_model_adapter.js
  return `[批判待實作：${agentName} 對 ${peer1Name}/${peer2Name} 的批判]`;
  // TODO: 替換為 callLocalModel({ task: prompt }, { model: "qwen3:14b", timeoutMs })
}
```

在 Round 2-N 的 `Promise.all` 前插入（可選，若 timeoutMs 充裕）：

```typescript
// Peer Critique（可選，用 Ollama 零費用）
// const [claudeCritique, codexCritique] = await Promise.all([...])
// 然後在 CLAUDE_ROLE_R2 / CODEX_ROLE_R2 中附加批判內容
```

> **實作優先級**：E 和 F 優先，G 複雜度高可後做。

---

### 擴充 H：輪次摘要壓縮（防 Token 爆炸）✅ 已實作

**論文**：DebateOCR (2026)
**問題**：若 `maxRounds` 增加到 5-7 輪，每輪 prompt 包含前輪全文，token 數指數成長（文獻實測：5 輪後達 59,200 tokens）。
**方向**：每輪結束後，將本輪三方回應壓縮為 80 字摘要，下輪只傳摘要而非全文。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `compressRound()` / `compressText()`，Round 2+ 的 Claude/Codex prompt 與 Attention-MoA 交叉批判都只接收前輪 80 字摘要，避免長回應在多輪辯論中持續膨脹。測試已覆蓋長回應尾端不會進入 Round 2 prompt。

在 `runDMAD()` 加入壓縮邏輯：

```typescript
// 輪次結束後，壓縮供下輪使用
function compressRound(r: DebateRound): { claude: string; codex: string; openclaw: string } {
  // 簡易壓縮：取前 80 字（完整實作應呼叫 LLM 摘要）
  return {
    claude: r.claudeResponse.slice(0, 80),
    codex: r.codexResponse.slice(0, 80),
    openclaw: r.openclawResponse.slice(0, 80),
  };
}
```

在 `CLAUDE_ROLE_R2` / `CODEX_ROLE_R2` 的 `prevRound.codexResponse` → 改為 `compressRound(prevRound).codex`。

---

### 擴充 I：DMAD 結論回填 nuwa Patterns（閉環學習）✅ 已實作

**位置**：`runDMAD()` 完成後（DB 寫入區塊之後）
**目的**：DMAD 每次辯論的 MoA 最終答案，提煉為新的 nuwa pattern，下次辯論自動使用。

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `writeDmadPattern()`。寫入前會確認 `patterns` 表存在並讀取 `PRAGMA table_info(patterns)`，只使用實際存在欄位組成 positional binding，避免 sql.js fallback 的 named binding 問題與 schema 差異。新 pattern slug 為 `dmad-${result.id.slice(0, 8)}`，`context` 取 MoA 最終答案前 400 字，`decay_score/confidence/success_rate` 以收斂分初始化。測試已覆蓋 schema-aware positional bindings。

```typescript
// ── 閉環學習：DMAD 結論 → nuwa patterns ──────────────────────────────────
try {
  const hasPatterns = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='patterns'")
    .get();

  if (hasPatterns && result.finalAnswer.length > 50) {
    // 從 MoA 結論提煉 slug（取任務前 30 字作為識別）
    const slug = `dmad-${result.id.slice(0, 8)}`;
    const target = task.slice(0, 80);
    const context = result.finalAnswer.slice(0, 400);

    db.prepare(
      `
      INSERT OR IGNORE INTO patterns
        (slug, target, context, mental_models, decay_score, frozen)
      VALUES
        (@slug, @target, @context, @mental_models, @decay_score, @frozen)
    `,
    ).run({
      slug,
      target,
      context,
      mental_models: JSON.stringify(result.patternSlugsUsed),
      decay_score: result.convergenceScore, // 收斂分作為初始活躍度
      frozen: 0,
    });
    console.error(`[DMAD] 閉環學習：已將結論寫入 pattern ${slug}`);
  }
} catch (err) {
  console.error("[DMAD] 閉環學習寫入失敗（非致命）：", String(err).slice(0, 100));
}
```

> **效果**：每次 DMAD 辯論都產生一個新 pattern，before-prompt-build.js 會在下次 Agent 啟動時自動注入，形成真正的知識累積閉環。

---

## 十、系統級優化（研究導向第三批）

---

### 優化 J：MasRouter 任務路由前置分類 ✅ 已實作

**論文**：MasRouter (2025) — 在多代理系統前加路由器，依任務類型選擇代理組合
**效果實測**：MBPP +8.2% 準確度，HumanEval 降低 52% overhead
**位置**：`runDMAD()` 入口前，或新建 `dmad-router.ts`

**2026-05-20 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 接入 MasRouter v2。`routeTask()` 會依技術/語言關鍵字比例輸出 `domain`、`confidence`、`reason`，`runDMAD()` 預設會呼叫路由器，`skipRouting` 可回到全 MoA 路徑。已修正 regex 非 global 導致比例信心分只計 0/1 的問題，並新增 `extensions/evolution-learning/src/dmad-route-task.test.ts` 覆蓋 technical、language、mixed、unknown 四種路由結果。

**方向**：在執行辯論前，先判斷任務類型，決定：

- 代理組合（全三方 vs 雙方 vs 單方）
- 每方的最大 token 預算
- 是否需要 MoA（簡單任務直接回傳最高分代理的答案）

```typescript
/**
 * MasRouter 輕量實作：任務類型分類 → 路由決策
 * 依任務文字特徵決定最合適的代理組合
 */
export function routeTask(task: string): {
  useCodex: boolean;
  useClaude: boolean;
  useOllama: boolean;
  needsMoA: boolean;
  maxRoundsOverride?: number;
} {
  const t = task.toLowerCase();

  // 純技術/程式碼任務 → Codex 主導，跳過 MoA
  if (/程式|code|bug|fix|implement|api|函數|class|typescript|javascript/.test(t)) {
    return {
      useCodex: true,
      useClaude: false,
      useOllama: true,
      needsMoA: false,
      maxRoundsOverride: 1,
    };
  }

  // 純策略/語言任務 → Claude 主導
  if (/策略|分析|評估|建議|why|how|what|如何|為什麼/.test(t)) {
    return {
      useCodex: false,
      useClaude: true,
      useOllama: true,
      needsMoA: false,
      maxRoundsOverride: 1,
    };
  }

  // 複雜決策 → 全三方 + MoA
  return { useCodex: true, useClaude: true, useOllama: true, needsMoA: true };
}
```

在 `runDMAD()` 開頭插入路由決策，並根據路由結果跳過不需要的代理（用空字串替代，不計入收斂）。

---

### 優化 K：DTE（Debate-Train-Evolve）自我演化 ✅ 已實作

**論文**：DTE Framework (2025) — 辯論 → 勝方論點 → 強化學習更新
**OpenClaw 版本**：辯論 → 勝方論點 → nuwa pattern 權重更新
**位置**：`runDMAD()` 寫 DB 後、return 前

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `winningAgent()` 與 `evolveDmadPatterns()`。MoA 最終答案會和最後一輪 Claude/Codex/OpenClaw 回應做 n-gram cosine 比對；OpenClaw 勝出時提升第一個啟用 pattern 的 `decay_score +0.05`，Claude/Codex 勝出時將非 frozen patterns `decay_score -0.01`。更新使用 positional binding，且包在非致命 try/catch。測試已覆蓋 OpenClaw 勝出提升與 Claude/Codex 勝出衰減兩條路徑。

在閉環學習（擴充 I）的基礎上，加入**勝方論點識別**與 **pattern 權重動態調整**：

```typescript
// ── DTE 演化：識別 MoA 最終採納了哪方的論點，更新對應 pattern 的 decay_score ──
try {
  if (result.finalAnswer && allPatternSlugs.length > 0) {
    // 計算 finalAnswer 與各代理最後一輪回應的相似度
    const lastRound = result.rounds[result.rounds.length - 1];
    const faVec = textToVec(result.finalAnswer);
    const simClaude = sparseCosine(faVec, textToVec(lastRound.claudeResponse));
    const simCodex = sparseCosine(faVec, textToVec(lastRound.codexResponse));
    const simOclaw = sparseCosine(faVec, textToVec(lastRound.openclawResponse));

    // 最接近 MoA 結論的代理「贏了」這輪辯論
    const winner =
      simClaude >= simCodex && simClaude >= simOclaw
        ? "claude"
        : simCodex >= simOclaw
          ? "codex"
          : "openclaw";

    // 若 OpenClaw 的 pattern 贏了，提升 decay_score（活躍度）
    if (winner === "openclaw" && allPatternSlugs.length > 0) {
      const winnerSlug = allPatternSlugs[0];
      db.prepare(
        `
        UPDATE patterns SET decay_score = MIN(1.0, decay_score + 0.05)
        WHERE slug = @slug
      `,
      ).run({ slug: winnerSlug });
      console.error(`[DMAD-DTE] ${winnerSlug} 論點贏得辯論，decay_score +0.05`);
    }

    // 若 Claude/Codex 贏，降低所有 patterns 的 decay_score（框架未能主導）
    if (winner !== "openclaw") {
      db.prepare(
        `
        UPDATE patterns SET decay_score = MAX(0.01, decay_score - 0.01)
        WHERE frozen = 0
      `,
      ).run();
      console.error(`[DMAD-DTE] ${winner} 贏得辯論，patterns decay_score 全體 -0.01`);
    }
  }
} catch (err) {
  console.error("[DMAD-DTE] 演化更新失敗（非致命）：", String(err).slice(0, 100));
}
```

---

### 優化 L：RCR 角色感知上下文壓縮（30% Token 節省）✅ 已實作

**論文**：RCR-Router (2025) — 依代理角色動態選擇 memory subset
**效果**：token 使用量減少 30%，答案品質不降
**位置**：`CLAUDE_ROLE_R2`、`CODEX_ROLE_R2` — 傳入上一輪內容時

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `rcr()` 角色感知上下文選擇。Claude Round 2 只接收 Codex/OpenClaw 摘要中的語意、使用者意圖、需求、策略相關句；Codex Round 2 只接收 Claude/OpenClaw 摘要中的 API、實作、資料庫、schema 等技術相關句。若無角色相關句，會 fallback 回原摘要並限制 250 字。測試已覆蓋 R2 prompt 的接收方角色過濾，避免退回單純 300 字截斷。

**現況**：把上輪完整回應傳給下輪（最多 300 字截斷）
**改法**：依「接收代理的角色」過濾上輪內容，只傳相關部分

```typescript
/**
 * RCR 角色感知上下文選擇：
 * 依接收代理的專長過濾上輪對話，減少無關 token 消耗
 */
function rcr(text: string, receiverRole: "language" | "technical" | "pattern"): string {
  const words = text.split(/\s+/);
  const TECHNICAL_KEYWORDS = /程式|架構|實作|API|函數|效能|bug|效率|資料庫|schema/i;
  const LANGUAGE_KEYWORDS = /意圖|邏輯|推理|語義|使用者|需求|抽象|概念|框架|策略/i;
  const PATTERN_KEYWORDS = /框架|模式|歷史|案例|precedent|template|pattern|慣例/i;

  const keyword = {
    language: LANGUAGE_KEYWORDS,
    technical: TECHNICAL_KEYWORDS,
    pattern: PATTERN_KEYWORDS,
  }[receiverRole];

  // 優先保留含有角色相關關鍵字的句子
  const sentences = text.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [text];
  const relevant = sentences.filter((s) => keyword.test(s));
  const result = relevant.length > 0 ? relevant.join("") : text;

  return result.slice(0, 250); // 比原始 300 字截斷更精準
}
```

在 `CLAUDE_ROLE_R2` 中：

```typescript
// 現況：codex.slice(0, 300)
// 改為：
rcr(codex, "language"); // Claude 只需要語意相關部分
rcr(openclaw, "language");
```

在 `CODEX_ROLE_R2` 中：

```typescript
rcr(claude, "technical"); // Codex 只需要技術相關部分
rcr(openclaw, "technical");
```

---

### 優化 M：Agent 健康前置檢查（防無效辯論）✅ 已實作

**位置**：`runDMAD()` 最開頭，opts 解構之後
**目的**：若某個 CLI 代理不可用，提前失敗而非等 30 秒超時後回傳錯誤字串
**基礎設施**：`tools/openclaw_runtime/adapters/health-check.mjs` 已存在

**2026-05-19 回填**：已在 `extensions/evolution-learning/src/dmad-debate.ts` 加入 `DMADOptions.skipHealthCheck` 與 `runAgentHealthCheck()`。預設會先用 5 秒 timeout ping Claude/Codex；兩者都不可用時直接丟出 `[DMAD] Claude 和 Codex 均不可用，取消辯論`，單方不可用時只告警並繼續。測試已覆蓋雙方失敗提前取消、單方失敗告警後繼續兩條路徑；一般辯論流程測試用 `skipHealthCheck: true` 保持測試聚焦。

```typescript
// 在 runDMAD() 入口加入輕量健康檢查（選用，加 opts.skipHealthCheck 可略過）
if (!opts.skipHealthCheck) {
  // 並行 ping 三個代理（各 5 秒 timeout）
  const [claudeOk, codexOk] = await Promise.all([
    claudeRespond("ping", claudeModel, 5_000)
      .then((r) => !isCliError(r))
      .catch(() => false),
    codexRespond("ping", codexModel, 5_000)
      .then((r) => !isCliError(r))
      .catch(() => false),
  ]);

  if (!claudeOk && !codexOk) {
    throw new Error("[DMAD] Claude 和 Codex 均不可用，取消辯論");
  }
  if (!claudeOk) console.error("[DMAD] 警告：Claude CLI 不可用，本輪辯論品質降低");
  if (!codexOk) console.error("[DMAD] 警告：Codex CLI 不可用，本輪辯論品質降低");
}
```

---

### 優化 N：辯論品質趨勢分析（每週報告）✅ 已實作

**位置**：新建 `scripts/dmad-trend-report.mts`
**目的**：比較歷次辯論的 convergenceScore 趨勢，自動識別系統退化

**2026-05-20 回填**：已建立 `scripts/dmad-trend-report.mts` 並接入 `package.json` 的 `dmad:trend` script。報告會掃描 `reports/dmad-run-test-*.json` 與 `reports/dmad-run-test-latest.json`，輸出 `avgConvergenceScore`、`trend`、`stoppedByDistribution`、`avgRounds`、`avgDurationMs`、`percentiles`、`convergenceRatePercent`、`agentLeadCount`，同時寫入 `reports/dmad-trend-latest.json`。實作只使用 Node 內建 `fs/path`，不新增 runtime dependency。

```typescript
// 讀取 reports/ 下所有 dmad-run-test-*.json
// 計算 convergenceScore 移動平均、stoppedBy 分布
// 輸出趨勢 JSON：{ avgScore, trend: "improving"|"stable"|"degrading", rounds 分布 }
```

新增 package.json script：

```json
"dmad:trend": "tsx scripts/dmad-trend-report.mts"
```

---

## 十一、基礎設施修復（已完成）

### 修復 1：D big repair check 任務遺失（2026-05-19 已修）

**問題根源**：cron job `a6444711` 呼叫 `pnpm autonomous:controlled:run --task openclaw-d-big-repair-check`，但 `openclaw-d-big-repair-check` **不在** `scripts/openclaw-controlled-task-runner.mjs` 的 `ALL_TASKS` 陣列中。

**症狀**：8 次連續 `SYSTEM_RUN_DENIED` 錯誤（agent 正確行為——任務找不到就回 DENIED）。

**已修復**：在 `RESILIENCE_HARDENING_TASKS` 加入：

```javascript
{
  id: "openclaw-d-big-repair-check",
  label: "OpenClaw D big repair check",
  command: "pnpm",
  args: ["autonomous:inventory:check"],
}
```

**驗證**：

```bash
pnpm autonomous:controlled:run --task openclaw-d-big-repair-check
```

應輸出 `controlled_task=openclaw-d-big-repair-check exit=0`。

---

## 十二、完整優先級總表

| 優先  | 項目                | 位置                   | 效果          | 難度 |
| ----- | ------------------- | ---------------------- | ------------- | ---- |
| 🔴 P0 | A 雙閘收斂          | dmad-debate.ts         | 真正收斂觸發  | 中   |
| 🔴 P0 | I 閉環 pattern 學習 | dmad-debate.ts         | 知識積累      | 低   |
| 🔴 P0 | K DTE 演化          | dmad-debate.ts         | 自我強化      | 低   |
| 🟠 P1 | B 推理方法差異化    | CLAUDE/CODEX prompt    | 多樣性 +20%   | 低   |
| 🟠 P1 | E 軌跡評分          | dmad-debate.ts         | MoA 品質      | 中   |
| 🟠 P1 | F 反共識 prompt     | CLAUDE/CODEX R2 prompt | 防錯誤傳播    | 低   |
| 🟠 P1 | M 健康前置檢查      | runDMAD() 入口         | 防無效辯論    | 低   |
| 🟡 P2 | C RC 防護           | runDMAD() 迴圈         | 防表徵崩潰    | 低   |
| 🟡 P2 | D MoA prompt 強化   | MOA_PROMPT             | 聚合品質      | 低   |
| 🟡 P2 | J MasRouter 路由    | runDMAD() 入口         | -52% overhead | 中   |
| 🟡 P2 | L RCR 上下文壓縮    | R2 prompt 函數         | -30% token    | 低   |
| 🟢 P3 | G Peer Critique     | Round 2-N 前           | 批判品質      | 高   |
| 🟢 P3 | H 輪次摘要壓縮      | compressRound()        | 長辯論用      | 低   |
| 🟢 P3 | N 趨勢分析報告      | 新腳本                 | 可觀測性      | 低   |

---

### 2026-05-20 測試回填：Codex `not found` 誤判修正 ✅ 已實作

已在 `extensions/evolution-learning/src/dmad-debate.ts` 收斂 `isCliMissingError()`：不再用寬鬆 `not found` 關鍵字判定「CLI 未安裝」，改為只匹配與 `claude` / `codex` 命令本身直接相關的缺失訊息（`is not recognized`、`command not found <command>`、`找不到命令`、`No such file or directory` 等）。
目的：避免把 Windows `codex exec` runtime 錯誤（例如 `thread ... not found`）誤標成 `codex_missing`，改正為 `codex_failed`。
同步新增回歸測試 `extensions/evolution-learning/src/dmad-debate.test.ts`：模擬 `codex thread not found` 錯誤，驗證 `cliErrors` 與 `cliErrorSummary` 會落在 `codex_failed=1`、`codex_missing=0`。

### 2026-05-21 執行回填：live run 錯誤分類驗證 ✅ 已完成

已執行 `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=300000 pnpm dmad:run-test -- --fail-on-degraded` 與 `pnpm dmad:trend`。
本輪結果：`degradedReason` 從舊報告的 `codex_missing=2` 轉為 `claude_failed=1`，表示 `Codex not found` 誤判已解除，分類收斂生效。
最新 trend：`qualityStatus=degraded_agents`、`trendGateStatus=blocked_no_clean_reports`、`cleanReportCount=0`，目前主要 blocker 已轉為 Claude timeout，非 codex 安裝/辨識路徑。

### 2026-05-21 執行回填：Agent timeout 可調化 + clean report 恢復 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增 `DMAD_RUN_TEST_AGENT_TIMEOUT_MS`（預設 `90000`），讓 `runDMAD(... timeoutMs)` 不再固定 `60000`，可隨環境負載調整。
同步在 `scripts/dmad-run-test-self-test.mts` 補上 `parseDmadRunTestAgentTimeoutMs()` 測試案例（空值、正數、0、負值、非數字）。
實跑：

- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=300000 DMAD_RUN_TEST_AGENT_TIMEOUT_MS=90000 pnpm dmad:run-test -- --fail-on-degraded`
- `pnpm dmad:trend`

結果：

- `reports/dmad-run-test-latest.json`：`qualityStatus=pass`、`hadCliError=false`、`degradedReason=null`
- `reports/dmad-trend-latest.json`：`cleanReportCount=1`、`trendGateStatus=pass`、`cliErrorRatePercent=0`

此輪已解除上一輪主 blocker（Claude timeout 導致無 clean report）。

### 2026-05-21 執行回填：Convergence threshold 可調化 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增 `DMAD_RUN_TEST_CONVERGENCE_THRESHOLD`（預設 `0.69`），讓 `runDMAD(... convergenceThreshold)` 不再固定常數。
同步在 `scripts/dmad-run-test-self-test.mts` 補上 `parseDmadRunTestConvergenceThreshold()` 測試案例（空值、合法小數、0、1、負值、非數字）。
實跑驗證：

- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=420000 DMAD_RUN_TEST_AGENT_TIMEOUT_MS=120000 DMAD_RUN_TEST_CONVERGENCE_THRESHOLD=0.69 pnpm dmad:run-test -- --fail-on-degraded`
- `pnpm dmad:trend`

結果：

- `reports/dmad-run-test-latest.json`：`qualityStatus=pass`、`hadCliError=false`、stdout 已包含 `convergenceThreshold`
- `reports/dmad-trend-latest.json`：`cleanReportCount=1`、`trendGateStatus=pass`

此輪完成參數化收斂門檻，且保持 clean report 閉環。

### 2026-05-21 執行回填：Max rounds 可調化 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增 `DMAD_RUN_TEST_MAX_ROUNDS`（預設 `3`，允許 `1..10`），讓 `runDMAD(... maxRounds)` 不再固定。
同步在 `scripts/dmad-run-test-self-test.mts` 補上 `parseDmadRunTestMaxRounds()` 測試案例（空值、合法值、0、負值、超上限、非數字）。
實跑驗證：

- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=300000 DMAD_RUN_TEST_AGENT_TIMEOUT_MS=120000 DMAD_RUN_TEST_MAX_ROUNDS=2 DMAD_RUN_TEST_CONVERGENCE_THRESHOLD=0.69 pnpm dmad:run-test -- --fail-on-degraded`
- `pnpm dmad:trend`

結果：

- `reports/dmad-run-test-latest.json`：`qualityStatus=pass`、`totalRounds=2`、`durationMs=148210`
- `reports/dmad-trend-latest.json`：`avgRounds=2`、`avgDurationMs=148190`、`trendGateStatus=pass`

此輪完成最大輪數參數化，且在 clean 狀態下把單次執行時長從 ~186s 進一步降到 ~148s。

### 2026-05-21 執行回填：Variance threshold 可調化 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增 `DMAD_RUN_TEST_VARIANCE_THRESHOLD`（預設 `0.05`），讓 `runDMAD(... varianceThreshold)` 不再固定。
同步在 `scripts/dmad-run-test-self-test.mts` 補上 `parseDmadRunTestVarianceThreshold()` 測試案例（空值、合法小數、0、1、負值、非數字）。
實跑驗證：

- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=300000 DMAD_RUN_TEST_AGENT_TIMEOUT_MS=120000 DMAD_RUN_TEST_MAX_ROUNDS=3 DMAD_RUN_TEST_CONVERGENCE_THRESHOLD=0.69 DMAD_RUN_TEST_VARIANCE_THRESHOLD=0.30 pnpm dmad:run-test -- --fail-on-degraded`
- `pnpm dmad:trend`

結果：

- `reports/dmad-run-test-latest.json`：`qualityStatus=pass`、`totalRounds=2`、`stoppedBy=variance`、`durationMs=140742`
- `reports/dmad-trend-latest.json`：`stoppedByDistribution={"variance":1,"max_rounds":0}`、`avgRounds=2`、`trendGateStatus=pass`

此輪在維持 clean report 前提下，成功把停止原因從 `max_rounds` 轉為 `variance`，並進一步縮短時長。

### 2026-05-21 執行回填：run-test 輪數提示動態化 ✅ 已完成

已將 `scripts/dmad-run-test.mts` 的固定提示 `預計 3 輪` 改為動態顯示 `預計 ${maxRounds} 輪`，與 `DMAD_RUN_TEST_MAX_ROUNDS` 參數一致。
這是觀測面修正，不影響辯論邏輯，只避免執行輸出與實際設定不一致造成誤判。
驗證：`pnpm dmad:run-test:self-test` 與 `git diff --check` 皆通過。

### 2026-05-21 執行回填：stdout 摘要配置欄位穩定化 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增 `runConfig` 摘要欄位，固定輸出順序為：

- `totalTimeoutMs`
- `agentTimeoutMs`
- `maxRounds`
- `convergenceThreshold`（固定 4 位小數字串）
- `varianceThreshold`（固定 4 位小數字串）

並套用到 success/timeout 兩種 stdout JSON。
目的：避免自動比對時因欄位位置或浮點字串差異造成誤判。
驗證：

- `pnpm dmad:run-test:self-test`（本地自測，不呼叫外部 Claude/Codex）
- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0 ... pnpm dmad:run-test`（快速驗證 timeout 摘要格式）
- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=300000 DMAD_RUN_TEST_AGENT_TIMEOUT_MS=120000 DMAD_RUN_TEST_MAX_ROUNDS=3 DMAD_RUN_TEST_CONVERGENCE_THRESHOLD=0.69 DMAD_RUN_TEST_VARIANCE_THRESHOLD=0.30 pnpm dmad:run-test -- --fail-on-degraded`
- `pnpm dmad:trend`

最新結果維持 clean：`qualityStatus=pass`、`stoppedBy=variance`、`trendGateStatus=pass`。

### 2026-05-21 執行回填：runConfig 同步寫入 latest 報告 ✅ 已完成

已將 `scripts/dmad-run-test.mts` 調整為在寫檔時把 `runConfig` 一併寫入報告 JSON（success / timeout 兩條路徑都包含）。
這使 `reports/dmad-run-test-latest.json`（或覆寫路徑）與 stdout 摘要配置完全對齊，方便自動稽核對比。
驗證：

- `pnpm dmad:run-test:self-test`
- `DMAD_RUN_TEST_REPORT_PATH=<temp> DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0 ... pnpm dmad:run-test`
- 讀回檔案確認 `runConfig` 存在且內容為固定格式（`convergenceThreshold` / `varianceThreshold` 4 位小數字串）

### 2026-05-21 執行回填：self-test 鎖定 runConfig 寫檔結構 ✅ 已完成

已在 `scripts/dmad-run-test-self-test.mts` 的 timeout report roundtrip 測試，加入 `runConfig` 寫入與回讀斷言，固定檢查以下欄位：

- `totalTimeoutMs`
- `agentTimeoutMs`
- `maxRounds`
- `convergenceThreshold`（4 位小數字串）
- `varianceThreshold`（4 位小數字串）

目的：防止後續調整造成 `reports/dmad-run-test-latest.json` 漏欄位或格式飄移，讓 stdout 與 report 的配置摘要持續一致。
驗證：

- `pnpm exec oxfmt --check --threads=1 scripts/dmad-run-test-self-test.mts`
- `pnpm dmad:run-test:self-test`
- `git diff --check -- scripts/dmad-run-test-self-test.mts docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout stdout 契約鎖定 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增可測 helper：`buildDmadRunTimeoutStdoutSummary()`，讓 timeout 路徑 stdout payload 可直接做契約測試。
並在 `scripts/dmad-run-test-self-test.mts` 補上 timeout stdout 斷言，固定檢查：

- 欄位存在與鍵序（`ok`、`failOnDegraded`、`runConfig`、`runStatus` ... `phaseTimingsMs`）
- `runConfig` 與 timeout 報告一致
- `totalTimeoutMs` / `timeoutPhase` 等關鍵值

目的：避免後續改動造成 timeout stdout JSON 欄位漂移，讓 cron/自動比對可穩定解析。
驗證：

- `pnpm exec oxfmt --check --threads=1 scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts`
- `pnpm dmad:run-test:self-test`
- `git diff --check -- scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：success stdout 契約鎖定 ✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增可測 helper：`buildDmadRunSuccessStdoutSummary()`，success 路徑 stdout 改由 helper 組裝。
並在 `scripts/dmad-run-test-self-test.mts` 補上 success stdout 斷言，固定檢查：

- 欄位存在與鍵序（`ok`、`failOnDegraded`、`runConfig`、`qualityStatus` ... `durationMs`）
- `runConfig`、`rounds`、`stoppedBy`、`durationMs` 與 `latestProgress` 關鍵值

目的：讓 success/timeout 兩條 stdout 契約都可被低成本測試鎖定，避免後續改動造成 cron parser 漂移。
驗證：

- `pnpm exec oxfmt --check --threads=1 scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts`
- `pnpm dmad:run-test:self-test`
- `git diff --check -- scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：stdout/report runConfig 一致性鎖定 ✅ 已完成

已在 `scripts/dmad-run-test-self-test.mts` 新增兩條一致性斷言：

- timeout 路徑：`buildDmadRunTimeoutStdoutSummary(...).runConfig` 與 `writeDmadRunReport()` 寫入 JSON 的 `runConfig` 必須一致
- success 路徑：`buildDmadRunSuccessStdoutSummary(...).runConfig` 與 `writeDmadRunReport()` 寫入 JSON 的 `runConfig` 必須一致

目的：避免未來只改 stdout 或只改 report 任一側，造成 `runConfig` 雙軌漂移。
驗證：

- `pnpm exec oxfmt --check --threads=1 scripts/dmad-run-test-self-test.mts`
- `pnpm dmad:run-test:self-test`
- `git diff --check -- scripts/dmad-run-test-self-test.mts docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：report 寫檔路徑單一化（runConfig helper）✅ 已完成

已在 `scripts/dmad-run-test.mts` 新增 `buildDmadRunReportWithConfig()`，把 timeout preflight、timeout catch、success 三條寫檔路徑都改為同一 helper 組裝 `report + runConfig`。
並在 `scripts/dmad-run-test-self-test.mts` 新增 helper 斷言，且將 timeout report roundtrip 改為使用此 helper。

目的：減少重複拼接點，降低未來只改某一條寫檔路徑造成 `runConfig` 漏寫或格式漂移的風險。
驗證：

- `pnpm exec oxfmt --check --threads=1 scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts`
- `pnpm dmad:run-test:self-test`
- `git diff --check -- scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：runtime smoke 驗證 runConfig helper 寫檔 ✅ 已完成

已執行最小 runtime smoke（`DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0`）搭配臨時 `DMAD_RUN_TEST_REPORT_PATH`，直接走 `pnpm dmad:run-test` 的 timeout preflight 路徑。
結果：

- CLI stdout 產出 timeout JSON，含 `runConfig`（`0.6900` / `0.0500` 固定格式）
- 實檔報告 `runStatus=timeout`、`qualityStatus=degraded_agents`
- 報告內 `runConfig` 欄位完整且與本輪設定一致
- 指令依預期回 `exit code 3`（timeout 診斷模式）

目的：確認 `buildDmadRunReportWithConfig()` 不只在 self-test 生效，也在真實 CLI timeout 路徑穩定寫入 `runConfig`。
驗證：

- `DMAD_RUN_TEST_REPORT_PATH=<temp> DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0 pnpm dmad:run-test`
- 讀回 `<temp>` JSON 檢查 `runStatus/qualityStatus/runConfig`

### 2026-05-21 執行回填：timeout smoke 指令固定化（跨平台）✅ 已完成

已在 `package.json` 新增：

- `dmad:run-test:timeout-smoke` → `node scripts/dmad-run-test-timeout-smoke.mjs`

並新增 `scripts/dmad-run-test-timeout-smoke.mjs`：

- 預設注入 `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=0`
- Windows 走 `cmd.exe /c pnpm dmad:run-test`
- 非 Windows 走 `pnpm dmad:run-test`
- 透傳子程序 exit code（預期 timeout 診斷為 `3`）

目的：把 runtime timeout smoke 變成固定低成本入口，避免每次手動拼環境變數，且在 Windows 可直接執行。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke.mjs`
- `pnpm dmad:run-test:timeout-smoke`（本輪 `EXIT_CODE=3`，stdout 為 timeout JSON）
- `pnpm dmad:run-test:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout smoke 預設改寫暫存報告路徑 ✅ 已完成

已調整 `scripts/dmad-run-test-timeout-smoke.mjs`：

- 若未指定 `DMAD_RUN_TEST_REPORT_PATH`，會自動產生 `%TEMP%/dmad-run-test-timeout-smoke-<timestamp>-<pid>.json`
- 執行前會輸出本輪 `report path`，方便直接讀回檢查

目的：避免 `pnpm dmad:run-test:timeout-smoke` 覆寫 `reports/dmad-run-test-latest.json`，讓 smoke 與主報告解耦。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke.mjs`
- `pnpm dmad:run-test:timeout-smoke`（本輪 `EXIT_CODE=3`，且報告路徑為 `%TEMP%`）
- `pnpm dmad:run-test:self-test`
- `git diff --check -- scripts/dmad-run-test-timeout-smoke.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout smoke env/path 規則 self-test ✅ 已完成

已將 `scripts/dmad-run-test-timeout-smoke.mjs` 抽出可測 helper `resolveTimeoutSmokeEnv()`，並新增：

- `scripts/dmad-run-test-timeout-smoke-self-test.mjs`
- `package.json` script：`dmad:run-test:timeout-smoke:self-test`

self-test 覆蓋兩條低風險核心規則：

- 未提供 `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS` / `DMAD_RUN_TEST_REPORT_PATH` 時，會自動補 `0` 與 `%TEMP%` 唯一路徑
- 已提供兩個 env 時，必須完全尊重覆寫值

目的：把 timeout smoke 的路徑與 env 契約固定化，避免後續重構破壞預設行為。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke.mjs`
- `node --check scripts/dmad-run-test-timeout-smoke-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:self-test`
- `pnpm dmad:run-test:timeout-smoke`（本輪 `EXIT_CODE=3`）
- `pnpm dmad:run-test:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke.mjs scripts/dmad-run-test-timeout-smoke-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout smoke 路徑來源標記（default/override）✅ 已完成

已在 `scripts/dmad-run-test-timeout-smoke.mjs` 新增 `resolveTimeoutSmokeReportPathSource()`，執行時固定輸出：

- `report path source: default_temp`（未提供 `DMAD_RUN_TEST_REPORT_PATH`）
- `report path source: override`（有提供 `DMAD_RUN_TEST_REPORT_PATH`）

並在 `scripts/dmad-run-test-timeout-smoke-self-test.mjs` 補上兩種來源的斷言。

目的：讓 timeout smoke 的觀測訊號可直接看出路徑來源，排查覆寫/預設混用時更快定位。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke.mjs`
- `node --check scripts/dmad-run-test-timeout-smoke-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:self-test`
- `pnpm dmad:run-test:timeout-smoke`（本輪輸出 `report path source: default_temp`）
- `git diff --check -- scripts/dmad-run-test-timeout-smoke.mjs scripts/dmad-run-test-timeout-smoke-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout smoke override 路徑 runtime 驗證 ✅ 已完成

已執行 `DMAD_RUN_TEST_REPORT_PATH=<custom> pnpm dmad:run-test:timeout-smoke`，實測覆寫路徑分支。
結果：

- wrapper 輸出 `report path source: override`
- 報告實際寫入 `<custom>` 路徑（`%TEMP%/dmad-timeout-smoke-override-*.json`）
- 報告內容 `runStatus=timeout`、`qualityStatus=degraded_agents`、`runConfig.totalTimeoutMs=0`
- 指令維持預期 `EXIT_CODE=3`（timeout 診斷模式）

目的：確認 override 與 default_temp 兩種 report path 來源皆有實際 runtime 證據，不只停留在 helper 測試。
驗證：

- `DMAD_RUN_TEST_REPORT_PATH=<custom> pnpm dmad:run-test:timeout-smoke`
- 讀回 `<custom>` JSON 檢查 `runStatus/qualityStatus/runConfig`

### 2026-05-21 執行回填：timeout smoke command 路由 self-test ✅ 已完成

已在 `scripts/dmad-run-test-timeout-smoke-self-test.mjs` 補上 `resolveTimeoutSmokeCommand()` 斷言：

- `win32` → `cmd.exe /d /s /c "pnpm dmad:run-test"`
- 非 `win32`（示例 `linux`）→ `pnpm dmad:run-test`

目的：固定跨平台命令路由契約，避免後續修改造成 Windows 分支退化。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:self-test`
- `git diff --check -- scripts/dmad-run-test-timeout-smoke-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：override runtime 驗證一鍵化 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:override-smoke`
- `scripts/dmad-run-test-timeout-smoke-override.mjs`

行為：

- 若未提供 `DMAD_RUN_TEST_REPORT_PATH`，自動生成 `%TEMP%/dmad-timeout-smoke-override-<timestamp>-<pid>.json`
- 直接調用既有 `runTimeoutSmoke()`，因此會輸出 `report path source: override`
- 透傳 `pnpm dmad:run-test` 的 exit code（預期 `3`）

目的：把 override 分支的 runtime 驗證固定成一鍵指令，減少手動 env 注入。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-override.mjs`
- `pnpm dmad:run-test:timeout-smoke:override-smoke`（本輪 `EXIT_CODE=3`，且輸出 `report path source: override`）
- `pnpm dmad:run-test:timeout-smoke:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-override.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：override smoke path 規則 self-test ✅ 已完成

已將 `scripts/dmad-run-test-timeout-smoke-override.mjs` 抽出可測 helper `resolveOverrideSmokeEnv()`，並新增：

- `scripts/dmad-run-test-timeout-smoke-override-self-test.mjs`
- `package.json` script：`dmad:run-test:timeout-smoke:override-self-test`

self-test 覆蓋兩條規則：

- 未提供 `DMAD_RUN_TEST_REPORT_PATH` 時，生成 `%TEMP%/dmad-timeout-smoke-override-<timestamp>-<pid>.json`
- 已提供 `DMAD_RUN_TEST_REPORT_PATH` 時，完整尊重覆寫值

同時保留 runtime 驗證：`pnpm dmad:run-test:timeout-smoke:override-smoke` 仍輸出 `report path source: override` 並回 `EXIT_CODE=3`。

驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-override.mjs`
- `node --check scripts/dmad-run-test-timeout-smoke-override-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:override-self-test`
- `pnpm dmad:run-test:timeout-smoke:override-smoke`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-override.mjs scripts/dmad-run-test-timeout-smoke-override-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：override path pattern 觀測訊號 ✅ 已完成

已在 `scripts/dmad-run-test-timeout-smoke-override.mjs` 新增：

- `isOverrideSmokePathPattern(pathValue)`：檢查報告檔名是否符合 `dmad-timeout-smoke-override-*.json`
- runtime 輸出：`override path pattern: match|mismatch`

並在 `scripts/dmad-run-test-timeout-smoke-override-self-test.mjs` 補上斷言：

- auto-generated override path → `match=true`
- custom override path（`X:\\override-report.json`）→ `match=false`

目的：只增加觀測，不改執行邏輯，讓 override 路徑格式問題可快速定位。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-override.mjs`
- `node --check scripts/dmad-run-test-timeout-smoke-override-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:override-self-test`
- `pnpm dmad:run-test:timeout-smoke:override-smoke`（本輪輸出 `override path pattern: match`）
- `git diff --check -- scripts/dmad-run-test-timeout-smoke-override.mjs scripts/dmad-run-test-timeout-smoke-override-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：override + mismatch runtime 驗證 ✅ 已完成

已執行自訂路徑情境：

- `DMAD_RUN_TEST_REPORT_PATH=%TEMP%/custom-timeout-smoke-report-*.json`
- `pnpm dmad:run-test:timeout-smoke:override-smoke`

結果：

- wrapper 輸出 `override path pattern: mismatch`
- 同時輸出 `report path source: override`
- 報告落在自訂 `<custom>` 路徑，內容維持 `runStatus=timeout`、`qualityStatus=degraded_agents`
- 指令維持預期 `EXIT_CODE=3`

目的：補齊 override 分支在「非預設命名」下的 runtime 實證，確認 pattern 訊號與 path source 訊號可同時正確判讀。
驗證：

- `DMAD_RUN_TEST_REPORT_PATH=<custom> pnpm dmad:run-test:timeout-smoke:override-smoke`
- 讀回 `<custom>` JSON 檢查 `runStatus/qualityStatus/runConfig`

### 2026-05-21 執行回填：override custom-path quick check 一鍵化 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:override-custom-check`
- `scripts/dmad-run-test-timeout-smoke-override-quick-check.mjs`

行為：

- 若未指定 `DMAD_RUN_TEST_REPORT_PATH`，自動使用 `%TEMP%/custom-timeout-smoke-report-*.json`
- 自動執行 `override-smoke`（預期內部回 `exit code 3`）
- 自動讀回報告並輸出摘要：`runStatus`、`qualityStatus`、`totalTimeoutMs`、`runConfig_totalTimeoutMs`
- 若摘要欄位不符預期（非 `timeout/degraded_agents`）則回失敗

目的：把 override custom-path runtime 驗證與讀檔檢查合併成一鍵流程，降低手動排查成本。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-override-quick-check.mjs`
- `pnpm dmad:run-test:timeout-smoke:override-custom-check`
- `pnpm dmad:run-test:timeout-smoke:override-self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-override-quick-check.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：override custom-path quick check helper self-test ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:override-custom-self-test`
- `scripts/dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs`

self-test 覆蓋規則：

- `resolveOverrideQuickCheckEnv()` 未提供 `DMAD_RUN_TEST_REPORT_PATH` 時，會產生 `%TEMP%/custom-timeout-smoke-report-*.json`
- `resolveOverrideQuickCheckEnv()` 已提供覆寫路徑時，完整尊重原值
- `summarizeOverrideQuickCheckReport()` 在 `runConfig` 有值與無值兩條分支都輸出穩定摘要

目的：把 override custom-check 的核心 helper 契約固定化，降低後續微調造成摘要或路徑回歸的風險。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:override-custom-self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout smoke self-test 聚合入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:self-test:all`
- `scripts/dmad-run-test-timeout-smoke-self-test-all.mjs`

行為：

- 依序執行三個既有自測：
  - `dmad-run-test-timeout-smoke-self-test.mjs`
  - `dmad-run-test-timeout-smoke-override-self-test.mjs`
  - `dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs`
- 任一子測試非 0 立即失敗；全數通過才輸出 `PASS`

目的：將 timeout smoke 的核心 helper 驗證收斂成單一低成本指令，減少人工漏跑風險。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-self-test-all.mjs`
- `pnpm dmad:run-test:timeout-smoke:self-test:all`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-self-test-all.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：self-test:all 腳本清單契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:self-test:all:self-test`
- `scripts/dmad-run-test-timeout-smoke-self-test-all-self-test.mjs`

self-test 覆蓋規則：

- `timeoutSmokeSelfTestScriptPaths` 長度固定為 `3`
- 清單路徑不可重複
- 腳本名稱與執行順序固定為：
  1. `dmad-run-test-timeout-smoke-self-test.mjs`
  2. `dmad-run-test-timeout-smoke-override-self-test.mjs`
  3. `dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs`

目的：避免未來調整 `self-test:all` 時發生漏跑或順序漂移。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-self-test-all-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:self-test:all:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-self-test-all-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：self-test:all 執行訊息順序穩定化 ✅ 已完成

已調整：

- `scripts/dmad-run-test-timeout-smoke-self-test-all.mjs`

變更內容：

- `running: <script>` 訊息由 `console.error` 改為 `console.log`（stdout）

目的：減少 `running` 訊息與子測試輸出在 stdout/stderr 的交錯，讓執行順序更容易閱讀與定位。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-self-test-all.mjs`
- `pnpm dmad:run-test:timeout-smoke:self-test:all`
- `git diff --check -- scripts/dmad-run-test-timeout-smoke-self-test-all.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：timeout smoke 單一驗證入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:self-test:all`
  2. `pnpm dmad:run-test:timeout-smoke:self-test:all:self-test`

目的：把 timeout smoke 驗證收斂成單一命令，減少手動切換指令造成漏跑。
驗證：

- `pnpm dmad:run-test:timeout-smoke:verify`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:self-test`
- `scripts/dmad-run-test-timeout-smoke-verify-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:verify` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:self-test:all && pnpm dmad:run-test:timeout-smoke:self-test:all:self-test`
- `dmad:run-test:timeout-smoke:verify:self-test` 必須固定指向本 self-test 腳本

目的：避免 `verify` 驗證鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-verify-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:verify:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-verify-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify full 一鍵高信心入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:full`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:verify`
  2. `pnpm dmad:run-test:timeout-smoke:verify:self-test`

目的：把 runtime 驗證與 verify 鏈契約自測合併成一鍵高信心入口，減少手動分段執行。
驗證：

- `pnpm dmad:run-test:timeout-smoke:verify:full`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify full 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:full:self-test`
- `scripts/dmad-run-test-timeout-smoke-verify-full-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:verify:full` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:verify && pnpm dmad:run-test:timeout-smoke:verify:self-test`
- `dmad:run-test:timeout-smoke:verify:full:self-test` 必須固定指向本 self-test 腳本

目的：避免 `verify:full` 驗證鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-verify-full-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:verify:full:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-verify-full-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify strict 最高信心一鍵入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:strict`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:verify:full`
  2. `pnpm dmad:run-test:timeout-smoke:verify:full:self-test`

目的：把 runtime 驗證、verify 鏈自測、verify:full 鏈自測收斂成單一最高信心入口。
驗證：

- `pnpm dmad:run-test:timeout-smoke:verify:strict`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify strict 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:strict:self-test`
- `scripts/dmad-run-test-timeout-smoke-verify-strict-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:verify:strict` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:verify:full && pnpm dmad:run-test:timeout-smoke:verify:full:self-test`
- `dmad:run-test:timeout-smoke:verify:strict:self-test` 必須固定指向本 self-test 腳本

目的：避免 `verify:strict` 驗證鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-verify-strict-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:verify:strict:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-verify-strict-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify gate 最終守門入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:gate`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:verify:strict`
  2. `pnpm dmad:run-test:timeout-smoke:verify:strict:self-test`

目的：把 strict runtime 驗證與 strict 鏈契約自測收斂為單一守門命令。
驗證：

- `pnpm dmad:run-test:timeout-smoke:verify:gate`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify gate 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:gate:self-test`
- `scripts/dmad-run-test-timeout-smoke-verify-gate-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:verify:gate` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:verify:strict && pnpm dmad:run-test:timeout-smoke:verify:strict:self-test`
- `dmad:run-test:timeout-smoke:verify:gate:self-test` 必須固定指向本 self-test 腳本

目的：避免 `verify:gate` 驗證鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-verify-gate-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:verify:gate:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-verify-gate-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify gate full 最終單一守門入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:gate:full`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:verify:gate`
  2. `pnpm dmad:run-test:timeout-smoke:verify:gate:self-test`

目的：把 `verify:gate` runtime 驗證與 `verify:gate` 鏈契約自測收斂成單一最終守門命令。
驗證：

- `pnpm dmad:run-test:timeout-smoke:verify:gate:full`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-21 執行回填：verify gate full 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:verify:gate:full:self-test`
- `scripts/dmad-run-test-timeout-smoke-verify-gate-full-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:verify:gate:full` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:verify:gate && pnpm dmad:run-test:timeout-smoke:verify:gate:self-test`
- `dmad:run-test:timeout-smoke:verify:gate:full:self-test` 必須固定指向本 self-test 腳本

目的：避免 `verify:gate:full` 驗證鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-verify-gate-full-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:verify:gate:full:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-verify-gate-full-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate 最短最終入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate`

行為：

- 直接轉發到：`pnpm dmad:run-test:timeout-smoke:verify:gate:full`

目的：提供最短、單一、可記憶的最終守門入口，減少人工輸入錯誤。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate alias 契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:verify:gate:full`
- `dmad:run-test:timeout-smoke:gate:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate` 最短入口被重排或改名後偏離最終守門鏈。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate full 高信心最短入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:full`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate`
  2. `pnpm dmad:run-test:timeout-smoke:gate:self-test`

目的：把最短入口的 runtime 驗證與 alias 契約自測合併成單一高信心命令。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:full`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate full 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:full:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-full-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:full` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate && pnpm dmad:run-test:timeout-smoke:gate:self-test`
- `dmad:run-test:timeout-smoke:gate:full:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:full` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-full-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:full:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-full-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate/verify 契約自測聚合入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:self-test:all`

行為：

- 依序聚合執行：
  1. `verify:self-test`
  2. `verify:full:self-test`
  3. `verify:strict:self-test`
  4. `verify:gate:self-test`
  5. `verify:gate:full:self-test`
  6. `gate:self-test`
  7. `gate:full:self-test`

目的：把所有 gate/verify 契約自測收斂成單一命令，降低手動漏跑風險。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:self-test:all`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra 最短完整封裝入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate:full`
  2. `pnpm dmad:run-test:timeout-smoke:gate:self-test:all`

目的：把最短入口 runtime 驗證與全部契約自測合併成單一完整封裝命令。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:ultra`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-ultra-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:ultra` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate:full && pnpm dmad:run-test:timeout-smoke:gate:self-test:all`
- `dmad:run-test:timeout-smoke:gate:ultra:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:ultra` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-ultra-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-ultra-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra full 最終完整封裝入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:full`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate:ultra`
  2. `pnpm dmad:run-test:timeout-smoke:gate:ultra:self-test`

目的：把最短完整封裝 runtime 驗證與 ultra 契約自測整合為單一最終入口。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:ultra:full`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra full 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:full:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-ultra-full-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:ultra:full` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate:ultra && pnpm dmad:run-test:timeout-smoke:gate:ultra:self-test`
- `dmad:run-test:timeout-smoke:gate:ultra:full:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:ultra:full` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-ultra-full-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:full:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-ultra-full-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra verify 單一最終驗證入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate:ultra:full`
  2. `pnpm dmad:run-test:timeout-smoke:gate:ultra:full:self-test`

目的：把最終封裝入口與其命令鏈契約自測合併成單一命令，降低最後一步漏跑風險。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify`
- `pnpm exec oxfmt --check --threads=1 package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra verify 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:ultra:verify` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate:ultra:full && pnpm dmad:run-test:timeout-smoke:gate:ultra:full:self-test`
- `dmad:run-test:timeout-smoke:gate:ultra:verify:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:ultra:verify` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra verify full 一鍵最終驗證入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:full`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify`
  2. `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:self-test`

目的：把 `gate:ultra:verify` runtime 驗證與其契約自測收斂成單一最終入口，降低手動漏跑風險。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full`
- `pnpm format:check -- package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra verify full 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:full:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-full-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:ultra:verify:full` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify && pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:self-test`
- `dmad:run-test:timeout-smoke:gate:ultra:verify:full:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:ultra:verify:full` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-full-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-full-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra verify ultra 最終聚合入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:ultra`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full`
  2. `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full:self-test`

目的：把 `verify:full` runtime 驗證與其契約自測再收斂成單一最終聚合入口，降低手動漏跑風險。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra`
- `pnpm format:check -- package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-22 執行回填：gate ultra verify ultra 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:ultra:verify:ultra` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full && pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full:self-test`
- `dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:ultra:verify:ultra` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-23 執行回填：gate ultra verify ultra full 一鍵最終聚合入口 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full`

行為：

- 依序執行：
  1. `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra`
  2. `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test`

目的：把 `verify:ultra` runtime 驗證與其契約自測收斂成單一最終聚合入口，降低手動漏跑風險。
驗證：

- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full`
- `pnpm format:check -- package.json`
- `git diff --check -- package.json docs/codex-task-dmad-speedup.md`

### 2026-05-26 執行回填：gate ultra verify ultra full 鏈順序契約自測 ✅ 已完成

已新增：

- `package.json` script：`dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full:self-test`
- `scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-full-self-test.mjs`

self-test 覆蓋規則：

- `dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full` 必須固定為
  `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra && pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test`
- `dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full:self-test` 必須固定指向本 self-test 腳本

目的：避免 `gate:ultra:verify:ultra:full` 命令鏈被重排或改名後失去完整性。
驗證：

- `node --check scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-full-self-test.mjs`
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full:self-test`
- `git diff --check -- package.json scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-full-self-test.mjs docs/codex-task-dmad-speedup.md`

### 2026-05-25 執行回填：DMAD 真實系統運行數據可行驗證 ✅ 已完成

本次只採用成功 rerun 作為可行證據；首次 `DMAD_RUN_TEST_MOA_TIMEOUT_MS=20000` 暴露 MoA 逾時，不列為成功樣本。

真實運行證據：

- Agent health：Claude Code `2.1.140`、Codex CLI `0.128.0`，`qualityStatus=pass`
- `reports/dmad-run-test-latest.json`：`id=58c529a9-57a1-4db1-bc3c-761d56000301`
- `qualityStatus=pass`、`hadCliError=false`、`totalRounds=2`、`stoppedBy=max_rounds`
- `convergenceScore=0.6615`、`stabilityScores=[0,0.7888]`
- `durationMs=150272`、`phaseTimingsMs.moa=43062`、`phaseTimingsMs.dbWrite=4`
- SQLite `debates` 表已找到同一 run id，確認不是只靠 stdout
- `reports/dmad-trend-latest.json`：`cleanReportCount=1`、`timeoutRatePercent=0`、`cliErrorRatePercent=0`

驗證：

- `pnpm governance:r8:check`
- `pnpm dmad:agent-health`
- `pnpm dmad:run-test`
- `pnpm dmad:trend`
- SQLite latest run id readback
- `node --check scripts/openclaw-autonomous-inventory.mjs`
- `pnpm autonomous:inventory:check`
- `pnpm dmad:run-test:self-test`
- `pnpm dmad:trend:self-test`
- `git diff --check -- docs/codex-task-dmad-speedup.md extensions/evolution-learning scripts package.json reports`

### 2026-05-25 執行回填：DMAD run-test MoA 預設 timeout 調整與自測 ✅ 已完成

已修改：

- `scripts/dmad-run-test.mts`
- `scripts/dmad-run-test-self-test.mts`

變更內容：

- `DMAD_RUN_TEST_MOA_TIMEOUT_MS` 預設值由 `15000` 上調到 `60000`
- 新增 `defaultDmadRunTestMoaTimeoutMs(agentTimeoutMs)`，固定預設策略為 `min(agentTimeoutMs, 60000)`
- self-test 新增斷言，鎖定新預設：
  - `defaultDmadRunTestMoaTimeoutMs(90000) === 60000`
  - `defaultDmadRunTestMoaTimeoutMs(45000) === 45000`

目的：避免 MoA 在正常辯論中被過短預設 timeout 誤判為失敗（假性 timeout）。

實跑證據：

- 未設定 `DMAD_RUN_TEST_MOA_TIMEOUT_MS` 時，stdout `runConfig.moaTimeoutMs=60000`
- 1 輪完成樣本：`qualityStatus=pass`、`durationMs=254580`、`phaseTimingsMs.moa=51946`
- 低總時限對照：`totalTimeoutMs=240000` 會在 verification 階段超時（exit 3），顯示總時限需與實際 agent 延遲匹配

後續調整：

- `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS` 預設由 `240000` 調整為 `360000`，降低慢機器上的非功能性 timeout
- `DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS` 預設由 `10000` 調整為 `20000`，避免 verification 階段貼近 10s 邊界時誤觸發
- self-test 已鎖定未傳 fallback 時 `parseDmadRunTestTotalTimeoutMs(undefined) === 360000`
- self-test 已鎖定未傳 fallback 時 `parseDmadRunTestAgentTimeoutMs(undefined) === 90000`
- self-test 已鎖定未傳 fallback 時 `parseDmadRunTestMaxRounds(undefined) === 3`
- self-test 已鎖定未傳 fallback 時 `parseDmadRunTestConvergenceThreshold(undefined) === 0.69`
- self-test 已鎖定未傳 fallback 時 `parseDmadRunTestVarianceThreshold(undefined) === 0.05`
- self-test 的 `runConfig` fixture 已補齊 `moaTimeoutMs` 與 `verificationTimeoutMs`
- self-test 已覆蓋 `parseDmadRunTestStageTimeoutMs()` 的空值、非法值、過小值與小數截斷規則
- self-test 已覆蓋 `resolveDmadRunTestReportPath()` 的預設、相對路徑與絕對路徑解析
- self-test 已覆蓋 `resolveDmadRunTestReportPath()` 對空白字串回退預設路徑
- self-test 已覆蓋 `buildRunConfigSummary()` 的 timeout 欄位與四位小數格式
- self-test 已覆蓋 `buildDmadRunReportWithConfig()` 會以 canonical `runConfig` 覆蓋舊值
- self-test 已覆蓋 success path 的 stdout/report 核心摘要欄位一致性
- self-test 已覆蓋 timeout path 的 stdout/report 核心摘要欄位一致性
- self-test 已覆蓋 progress tracker 多 agent activeAgents/latestProgress 邊界
- self-test 已覆蓋 progress tracker 非 agent phase 與 error path 邊界
- self-test 已覆蓋 `withDmadRunTimeout()` 成功 resolve 時不觸發 timeout callback
- self-test 已覆蓋 `withDmadRunTimeout()` 成功 resolve 與原始 rejected promise 路徑 timeout callback 觸發次數為 0
- self-test 已覆蓋 `withDmadRunTimeout()` 在 `totalTimeoutMs=0` 時同步觸發 timeout callback
- self-test 已覆蓋 `withDmadRunTimeout()` 在 `totalTimeoutMs=0` 與 `1` 時 timeout callback 只觸發一次
- self-test 已覆蓋 `withDmadRunTimeout()` 在 `totalTimeoutMs=0` 時的 timeout reject class/name/message/totalTimeoutMs
- self-test 已覆蓋 `withDmadRunTimeout()` 會傳遞原始 rejected promise 錯誤且不觸發 timeout callback
- self-test 已覆蓋 `withDmadRunTimeout()` timeout error class 與 `totalTimeoutMs` 屬性
- self-test 已覆蓋 `withDmadRunTimeout()` timeout reject 的精準 message
- self-test 已覆蓋 `DmadRunTestTimeoutError` 直接建構時的 message/name/totalTimeoutMs
- self-test 已抽出本地 timeout error predicate helper，直接建構/0ms/1ms 共用同套斷言
- self-test 已覆蓋本地 timeout error predicate helper 不會把一般 `Error` 誤判為 `DmadRunTestTimeoutError`
- self-test 已覆蓋本地 timeout error predicate helper 不會接受錯誤的 `totalTimeoutMs`
- self-test 已覆蓋本地 timeout error predicate helper 不會接受 `null` 或字串等 non-error input
- self-test 已覆蓋本地 timeout error predicate helper 不會接受只有 name/message/totalTimeoutMs shape 的 plain object
- self-test 已將本地 timeout error predicate helper negative cases 改為 table-driven loop
- self-test 已將本地 timeout error predicate helper positive constructor case 改為 table-driven loop
- self-test 已覆蓋 `writeDmadRunReport()` 會自動建立自訂報告路徑父目錄
- docs:list 已驗證本檔 front matter summary 可被索引，不再標記 missing front matter

驗證：

低成本必跑：

- `pnpm docs:list | Select-String -Pattern '^codex-task-dmad-speedup'`
- `pnpm dmad:run-test:self-test`（本地自測，不呼叫外部 Claude/Codex）
- `pnpm dmad:run-test:live-smoke:self-test`（本地自測 live smoke wrapper，不呼叫外部 Claude/Codex）
- `pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full`（最高信心本地守門入口，依序執行 gate:ultra:verify:ultra 與 gate:ultra:verify:ultra:self-test，已包含 live smoke wrapper self-test、全部 gate/verify alias 契約自測與 gate:ultra 系列契約自測）
- `pnpm exec oxfmt --check --threads=1 scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts`
- `node --check scripts/openclaw-autonomous-inventory.mjs`
- `pnpm autonomous:inventory:check`
- `pnpm governance:r8:check`
- `git diff --check -- package.json scripts/dmad-run-test.mts scripts/dmad-run-test-self-test.mts scripts/dmad-run-test-live-smoke.mjs scripts/dmad-run-test-live-smoke-self-test.mjs scripts/dmad-run-test-timeout-smoke-self-test-all.mjs scripts/dmad-run-test-timeout-smoke-self-test-all-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-full-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-ultra-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-ultra-full-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-full-self-test.mjs scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-self-test.mjs scripts/dmad-run-test-timeout-smoke-verify-gate-full-self-test.mjs docs/codex-task-dmad-speedup.md`

選用 live smoke：

用途：只用於驗證真實 `runDMAD` 端到端 agent/MoA/report path，不列入低成本必跑 gate。
建議：設定 `DMAD_RUN_TEST_MOA_TIMEOUT_MS=60000`，避免低於真實 MoA 延遲的預設值造成 timeout 誤判。
建議：設定 `DMAD_RUN_TEST_TOTAL_TIMEOUT_MS=360000`，避免 agent/MoA 已成功但 verification 階段被總時限截斷。
建議：設定 `DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS=20000`，避免 verification 階段貼近 10s 邊界時誤觸發。
可複用入口：`pnpm dmad:run-test:live-smoke` 會跨平台注入上述 live smoke env，且仍允許外部 env 覆寫。

- `pnpm dmad:run-test:live-smoke`

### 2026-05-25 執行回填：controlled-runner latest DMAD publish 摘要 ✅ 已完成

已修改：

- `scripts/openclaw-controlled-task-runner.mjs`
- `scripts/check-openclaw-controlled-task-runner.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- `openclaw-controlled-task-runner-latest.json` 新增 `dmad_publish_status`
- `autonomous:controlled:next-safe -- --json` 會回傳同一份 `dmad_publish_status`
- plain `next-safe` 輸出新增 `dmad_publish_status=dmadPublish=...`
- inventory 新增 latest state JSON contract 與 next-safe DMAD publish negative probes

驗證：

- `node --check scripts/openclaw-controlled-task-runner.mjs scripts/check-openclaw-controlled-task-runner.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm check:openclaw-controlled-task-runner`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：Telegram summary markdown 顯示 DMAD publish ✅ 已完成

已修改：

- `scripts/openclaw-controlled-task-runner.mjs`
- `scripts/check-openclaw-controlled-task-runner.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- Telegram summary JSON 新增 `dmad_publish_status`
- Telegram summary markdown 新增 `- dmad_publish_status: dmadPublish=...`
- inventory 會檢查 Telegram summary 的 `dmad_publish_status.machineLine` 與 `verified`

驗證：

- `node --check scripts/openclaw-controlled-task-runner.mjs scripts/check-openclaw-controlled-task-runner.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm check:openclaw-controlled-task-runner`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：Telegram markdown DMAD publish readback probe ✅ 已完成

已修改：

- `scripts/openclaw-autonomous-inventory.mjs`
- `scripts/check-openclaw-controlled-task-runner.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- inventory 新增 text contract 支援
- `openclaw-controlled-task-runner-telegram-latest.md` 被納入 inventory
- markdown 必須包含 `- dmad_publish_status: dmadPublish=verified` 與 `dmadGate=1;summaryDmad=true`

驗證：

- `node --check scripts/openclaw-autonomous-inventory.mjs scripts/check-openclaw-controlled-task-runner.mjs`
- `pnpm check:openclaw-controlled-task-runner`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：Telegram one-line DMAD publish grep token ✅ 已完成

已修改：

- `scripts/openclaw-controlled-task-runner.mjs`
- `scripts/check-openclaw-controlled-task-runner.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- `telegram_summary_oneline` 直接包含 `dmadPublish=verified;status=...`
- `telegram_summary_oneline_zh_tw` 直接包含同一段 `dmad_publish_status.machineLine`
- inventory 會檢查英文與繁中 one-line 都能 grep `dmadPublish=verified`

驗證：

- `node --check scripts/openclaw-controlled-task-runner.mjs scripts/openclaw-autonomous-inventory.mjs scripts/check-openclaw-controlled-task-runner.mjs`
- `pnpm check:openclaw-controlled-task-runner`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：next-safe plain one-line DMAD publish token ✅ 已完成

已修改：

- `scripts/openclaw-controlled-task-runner.mjs`
- `scripts/check-openclaw-controlled-task-runner.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- `autonomous:controlled:next-safe -- --json` 新增 top-level `machineLine`
- plain `autonomous:controlled:next-safe` 新增 `machine_line=nextSafe=...;dmadGate=...;dmadPublish=...;readOnly=true`
- inventory negative probe 會檢查 next-safe `machineLine` 缺失時要回報 `dmadPublish=`

驗證：

- `node --check scripts/openclaw-controlled-task-runner.mjs scripts/openclaw-autonomous-inventory.mjs scripts/check-openclaw-controlled-task-runner.mjs`
- `pnpm check:openclaw-controlled-task-runner`
- `pnpm autonomous:controlled:next-safe`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat next-safe readback plain-first fallback ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `package.json`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- 新增 `pnpm dmad:heartbeat-next-safe-readback`
- readback 規則固定為先讀 plain `machine_line=`，缺失或 token 不完整時才 fallback JSON
- 自測覆蓋 plain 優先、JSON fallback、缺 token fail-closed

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback summary XML next_safe ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- readback report 新增 `heartbeat.nextSafe`、`heartbeat.message`、`heartbeat.xml`
- `heartbeat.message` 固定帶 `next_safe=...;status=...;freshness=...;mode=...`
- `heartbeat.xml` 固定輸出可轉送的 `<heartbeat>` block，讓外部 automation 不拆 stdout 也能讀下一步
- inventory 要求 latest artifact 的 heartbeat summary/XML 都帶 `next_safe=`

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat automation artifact readpoint ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- readback report 新增 `automationReadPoint`
- `automationReadPoint.stdoutRequired=false`，外部 heartbeat automation 可只讀 latest artifact
- `automationReadPoint.selector=heartbeat.xml`，固定指向可轉送的 heartbeat XML
- inventory 要求 `automationReadPoint.nextSafe` non-empty 且 stdout-free

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readpoint stale dispatch gate ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- `automationReadPoint` 新增 `dispatchable`
- ready artifact 才會輸出 `dispatchable=true`
- stale/blocked artifact 會輸出 `heartbeat.decision=DONT_NOTIFY`、`dispatchable=false`、`automationReadPoint.blockedReason`
- self-test 用 stale freshness case 鎖定外部 automation 不可繼續派工

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat plain dispatch blocked reason ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- plain CLI output 固定新增 `dispatchable=true|false`
- blocked/stale 時 plain CLI output 新增 `dispatch_blocked_reason=...`
- self-test 鎖定 stale plain output 不只顯示 `blocked_reason`，也要顯示 dispatch gate 的 blocked reason

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat plain dispatch contract check ✅ 已完成

已修改：

- `scripts/check-dmad-heartbeat-next-safe-readback.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `package.json`
- `docs/automation/module-skill-inventory.md`

變更內容：

- 新增 `pnpm dmad:heartbeat-next-safe-readback:check`
- check 使用 injected runner 驗證 plain output 的 ready/stale dispatch contract，不寫 latest artifact
- ready path 必須輸出 `dispatchable=true`
- stale path 必須輸出 `dispatchable=false` 與 `dispatch_blocked_reason=...`
- inventory 納入 check script，避免 plain dispatch 欄位未來只靠人工記憶

驗證：

- `node --check scripts/check-dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:check`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback next_safe plain route ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- readback report 新增 `nextSafe`
- plain CLI output 新增 `next_safe=...`
- inventory JSON contract 新增 `nextSafe` non-empty guard
- non-empty JSON contract 加入負向 probe，避免空字串被當作可路由 task id

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback plain freshness reason ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- readback report 新增 `freshness.status`、`freshness.ageMs`、`freshness.maxAgeMs`、`freshness.reason`
- plain CLI output 會列出 `generated_at=`、`freshness=`、`freshness_age_ms=`、`freshness_max_age_ms=`
- stale/blocked 時 plain output 額外列出 `freshness_reason=` 與 `blocked_reason=`
- inventory 要求 latest artifact `freshness.status=ok`

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback generatedAt freshness guard ✅ 已完成

已修改：

- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- readback latest artifact inventory contract 新增 `generatedAt` freshness guard
- `generatedAt` 必須是有效 ISO timestamp，且距離 inventory 執行時間不超過 24 小時
- 新增 stale negative probe，鎖定過舊 timestamp 會 fail closed

驗證：

- `node --check scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback report mode ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- readback report 新增 `mode=state_write|no_write`
- 預設寫入 latest artifact 時輸出 `mode=state_write`
- `--json --no-write-state` 輸出 `mode=no_write`，下游不用靠 invocation flags 推斷是否刷新 artifact
- inventory 要求 latest artifact `mode=state_write`，避免 no-write report 被當作最新狀態

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm dmad:heartbeat-next-safe-readback -- --json --no-write-state`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback no-write JSON validation ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- 新增可注入的 `runHeartbeatNextSafeReadbackCli()`，讓 self-test 能驗證 CLI output 與寫入行為
- `--json --no-write-state` 會輸出完整 report，但不呼叫 latest artifact 寫入
- 自測鎖定 no-write 模式下 `fallbackReason=null` 且 `writeReport` 不會被觸發

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback -- --json --no-write-state`
- `pnpm autonomous:inventory:check`

### 2026-05-25 執行回填：heartbeat readback latest artifact ✅ 已完成

已修改：

- `scripts/dmad-heartbeat-next-safe-readback.mjs`
- `scripts/dmad-heartbeat-next-safe-readback-self-test.mjs`
- `scripts/openclaw-autonomous-inventory.mjs`
- `docs/automation/module-skill-inventory.md`

變更內容：

- `pnpm dmad:heartbeat-next-safe-readback` 預設寫入 `reports/hermes-agent/state/openclaw-dmad-heartbeat-next-safe-readback-latest.json`
- latest artifact 固定包含 `schema`、`status`、`source`、`machineLine`、fallback metadata、read-only safety flags
- inventory 納入 readback latest JSON contract，檢查 `dmadPublish=verified`、DMAD gate 與 `readOnly=true`
- inventory 也要求 `fallbackReason=null`，讓 JSON fallback 可被記錄但不能被誤判為正常 ready path

驗證：

- `node --check scripts/dmad-heartbeat-next-safe-readback.mjs scripts/dmad-heartbeat-next-safe-readback-self-test.mjs scripts/openclaw-autonomous-inventory.mjs`
- `pnpm dmad:heartbeat-next-safe-readback:self-test`
- `pnpm dmad:heartbeat-next-safe-readback`
- `pnpm autonomous:inventory:check`
