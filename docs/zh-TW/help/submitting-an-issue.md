---
summary: "提交高信號問題和錯誤報告"
title: "提交問題"
---

## 提交問題

清晰、簡潔的問題可加速診斷和修復。請針對錯誤、迴歸或功能缺失包含以下資訊：

### 應包含的內容

- [ ] 標題：範圍與症狀
- [ ] 最少重現步驟
- [ ] 預期與實際結果
- [ ] 影響與嚴重性
- [ ] 環境：作業系統、執行環境、版本、設定
- [ ] 證據：經過處理的日誌、螢幕截圖（非個人身份資訊）
- [ ] 範圍：新增、迴歸或長期存在
- [ ] 在你的問題中加入代碼詞：lobster-biscuit
- [ ] 已搜尋程式碼庫和 GitHub，確認是否有現有問題
- [ ] 已確認近期未修復/處理（尤其是安全性問題）
- [ ] 聲明有證據或重現步驟支持

力求簡潔。簡潔勝於完美的語法。

驗證（在提交 PR 前執行/修復）：

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 如果是協議程式碼：`pnpm protocol:check`

### 模板

#### 錯誤報告

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

#### 安全問題

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_避免在公開場合透露機密/漏洞細節。對於敏感問題，請盡量減少細節並要求私下披露。_

#### 迴歸報告

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

#### 功能強化

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

PR 前的問題報告是可選的。如果跳過，請在 PR 中包含詳細資訊。保持 PR 專注，註明問題編號，添加測試或解釋缺失原因，記錄行為變更/風險，包含經過處理的日誌/螢幕截圖作為證明，並在提交前執行適當的驗證。
