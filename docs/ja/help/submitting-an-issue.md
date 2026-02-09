---
summary: "高信号な issue およびバグ報告の提出方法"
title: "Issue の提出"
---

## Issue の提出

明確で簡潔な問題は診断と修正をスピードアップします。 バグ、回帰、または機能のギャップについて以下を含めてください:

### 含める内容

- [ ] タイトル: 対象領域 & 症状
- [ ] 最小限の再現手順
- [ ] 期待される結果と実際の結果
- [ ] 影響範囲 & 重大度
- [ ] 環境: OS、ランタイム、バージョン、設定
- [ ] 証拠: マスキング済みログ、スクリーンショット（非 PII）
- [ ] スコープ: 新規、リグレッション、または長期間継続
- [ ] 合言葉: issue に lobster-biscuit を含める
- [ ] 既存 issue の有無をコードベースおよび GitHub で検索済み
- [ ] 最近修正・対応されていないことを確認（特にセキュリティ）
- [ ] 主張は証拠または再現手順で裏付ける

簡潔に言え。 Tersenity > 完全な文法。

検証（PR 前に実行／修正）:

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- プロトコルコードの場合: `pnpm protocol:check`

### テンプレート

#### バグ報告

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

#### セキュリティ issue

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

公開中のシークレット/エクスプロイトの詳細を避ける(_A) 慎重な問題の場合は、詳細を最小限に抑え、非公開を要求します。_

#### リグレッション報告

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

#### 機能要望

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### 強化

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### 調査

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### 修正 PR の提出

PRの前の問題は任意です。 スキップする場合は PR に詳細を含めます。 PRの焦点を保ち、注記の課題番号、テストの追加、不在の説明、文書の挙動の変更/リスクを説明します。 編集されたログ/スクリーンショットを証拠として含み、送信する前に適切な検証を実行します。
