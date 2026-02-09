---
summary: "高いシグナルを持つ PR を提出する方法"
title: "PR の提出"
---

良いPRは簡単に見直すことができます:査読者はすぐに意図を知っている必要があります, 行動を検証し、安全に土地変更. このガイドでは、人とLLMのレビューに対する簡潔で高信号の提出について説明します。

## 良い PR とは

- [ ] 問題、その重要性、変更内容を説明する。
- [ ] 変更をフォーカスし続けます。 変更範囲を絞る。広範なリファクタリングは避ける。
- [ ] ユーザーに見える変更／設定／デフォルトの変更を要約する。
- [ ] テストのカバレッジ、スキップ内容、その理由を列挙する。
- [ ] 証拠を追加する: ログ、スクリーンショット、または録画（UI/UX）。
- [ ] 合言葉: このガイドを読んだ場合、PR の説明に「lobster-biscuit」を入れる。
- [ ] PR 作成前に関連する `pnpm` コマンドを実行し、失敗を修正する。
- [ ] 関連する機能／Issue／修正について、コードベースと GitHub を検索する。
- [ ] 主張は証拠または観察に基づかせる。
- [ ] 良いタイトル: 動詞 + スコープ + 成果（例: `Docs: add PR and issue templates`）。

簡潔さを重視してください。文法よりも簡潔なレビューが重要です。該当しないセクションは省略してください。 該当しないセクションを省略します。

### ベースライン検証コマンド（変更に対して実行し、失敗を修正）

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- プロトコル変更: `pnpm protocol:check`

## プログレッシブ・ディスクロージャー

- トップ: 概要/目的
- 次: 変更内容／リスク
- 次: テスト／検証
- 最後: 実装／証拠

## 一般的な PR タイプ別のポイント

- [ ] 修正: 再現手順、根本原因、検証を追加する。
- [ ] 機能: ユースケース、振る舞い／デモ／スクリーンショット（UI）を追加する。
- [ ] リファクタリング: 「振る舞いの変更なし」と明記し、移動／簡素化した点を列挙する。
- [ ] Chore: なぜ(例えば、ビルド時間、CI、依存関係など)の状態です。
- [ ] ドキュメント: Before/After の文脈、更新ページへのリンク、`pnpm format` の実行。
- [ ] テスト: どのギャップをカバーするか、どのようにリグレッションを防ぐか。
- [ ] パフォーマンス: Before/After のメトリクスと測定方法を追加する。
- [ ] UX/UI: スクリーンショット／動画、アクセシビリティへの影響を記載する。
- [ ] インフラ／ビルド: 環境／検証内容。
- [ ] セキュリティ: リスク、再現、検証を要約し、機密データは含めない。根拠のある主張のみ。 受け取った要求のみ。

## チェックリスト

- [ ] 問題／意図が明確
- [ ] スコープが適切
- [ ] 振る舞いの変更を列挙
- [ ] テスト内容と結果を列挙
- [ ] 手動テスト手順（該当する場合）
- [ ] 秘密情報／個人データなし
- [ ] 証拠に基づく内容

## 一般 PR テンプレート

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

## PR タイプ別テンプレート（該当するタイプに置き換え）

### 修正

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

### 機能

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

### リファクタリング

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

### 雑務／メンテナンス

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

### ドキュメント

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

### テスト

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

### Perf

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

### インフラ／ビルド

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

### セキュリティ

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
