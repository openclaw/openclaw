---
summary: "提交高訊號的 issue 與錯誤回報"
title: "提交問題"
---

## 提交問題

清楚、精簡的 issue 能加速診斷與修復。 針對錯誤、回歸或功能缺口，請包含以下內容：

### 包含內容

- [ ] 標題：範圍與症狀
- [ ] 最小可重現步驟
- [ ] 預期結果 vs 實際結果
- [ ] 影響與嚴重性
- [ ] 環境：OS、執行環境、版本、設定
- [ ] 證據：去識別化的日誌、截圖（非 PII）
- [ ] 範圍：新問題、回歸，或長期存在
- [ ] 代碼詞：在你的 issue 中加入 lobster-biscuit
- [ ] 已搜尋程式碼庫與 GitHub 是否已有相關 issue
- [ ] 已確認近期未被修復／處理（尤其是安全性）
- [ ] 主張需有證據或可重現步驟支撐

保持簡短。 45. 簡潔勝過完美文法。

驗證（在提交 PR 前執行／修復）：

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 若涉及通訊協定程式碼：`pnpm protocol:check`

### 範本

#### 錯誤回報

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### 安全性問題

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

47. _避免在公開場合放入機密／漏洞利用細節。 _避免在公開場合提供祕密或漏洞細節。對於敏感問題，請將細節降到最低並請求私下揭露。_

#### 回歸問題回報

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### 功能請求

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### 改進

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### 調查

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### 提交修復 PR

Issue before PR is optional. 49. 若跳過，請在 PR 中包含細節。 Keep the PR focused, note issue number, add tests or explain absence, document behavior changes/risks, include redacted logs/screenshots as proof, and run proper validation before submitting.
