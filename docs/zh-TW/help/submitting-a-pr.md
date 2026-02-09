---
summary: "如何提交高訊號的 PR"
title: "提交 PR"
---

好的 PR 容易審查：審查者應能快速理解意圖、驗證行為，並安全地合併變更。 本指南涵蓋適合人類與 LLM 審查的精簡、高訊號提交。

## 什麼樣的 PR 算好

- [ ] 說明問題、為何重要，以及所做的變更。
- [ ] 保持變更聚焦。避免大範圍重構。 避免大規模重構。
- [ ] 摘要使用者可見／設定／預設值的變更。
- [ ] 列出測試涵蓋、跳過項目與原因。
- [ ] 附上證據：日誌、截圖或錄影（UI/UX）。
- [ ] 口令：如果你閱讀了本指南，請在 PR 描述中放入「lobster-biscuit」。
- [ ] 建立 PR 前，請執行並修正相關的 `pnpm` 指令。
- [ ] 在程式碼庫與 GitHub 搜尋相關功能／議題／修正。
- [ ] 以證據或觀察為基礎提出主張。
- [ ] 好的標題：動詞 + 範圍 + 成果（例如，`Docs: add PR and issue templates`）。

請保持精簡；精簡的審查 > 文法。省略任何不適用的區段。 省略任何不適用的章節。

### 基準驗證指令（針對你的變更執行／修正失敗項）

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 協定變更：`pnpm protocol:check`

## 漸進式揭露

- 最上方：摘要／意圖
- 接著：變更／風險
- 接著：測試／驗證
- 最後：實作／證據

## 常見 PR 類型：重點說明

- [ ] 修正（Fix）：加入重現步驟、根因、驗證。
- [ ] 功能（Feature）：加入使用情境、行為／示範／截圖（UI）。
- [ ] 重構（Refactor）：聲明「無行為變更」，列出移動／簡化的項目。
- [ ] 例行（Chore）：說明原因（例如，建置時間、 CI、相依性）。
- [ ] 文件（Docs）：提供前後對照、連結更新頁面，執行 `pnpm format`。
- [ ] 測試：涵蓋了什麼缺口；如何防止回歸。
- [ ] 效能（Perf）：加入前後指標，以及量測方式。
- [ ] UX/UI：截圖／影片，註明無障礙影響。
- [ ] Infra/Build：環境／驗證。
- [ ] 安全性：摘要風險、重現方式、驗證結果，不包含敏感資料。 僅提出有依據的主張。

## 檢查清單

- [ ] 清楚的問題／意圖
- [ ] 聚焦的範圍
- [ ] 列出行為變更
- [ ] 列出測試與結果
- [ ] 手動測試步驟（適用時）
- [ ] 無機密／私人資料
- [ ] 以證據為基礎

## 一般 PR 範本

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR 類型範本（以你的類型取代）

### 修正（Fix）

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 功能（Feature）

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 重構（Refactor）

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 例行／維護（Chore/Maintenance）

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 文件（Docs）

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 測試（Test）

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 效能

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 基礎設施／建置（Infra/Build）

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 安全性（Security）

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
