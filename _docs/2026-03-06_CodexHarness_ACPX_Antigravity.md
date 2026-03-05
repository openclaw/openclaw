# 2026-03-06 Codex Harness & ACPX Integration (Antigravity)

## 概要

OpenAI Codex (GPT-5.4/5.3) の推論能力を最大限に活用するため、ACPX 拡張機能に専用のハネス・プロトコルを実装し、関連するスキルを追加しました。

## 実施内容

### 1. ACPX 拡張機能の強化

- `extensions/acpx/src/config.ts`: `codexHarness` 設定オプションを追加。
- `extensions/acpx/src/runtime.ts`:
  - `isCodexHarness()` メソッドを実装。
  - ターン実行（`runTurn`）時に `OPENCLAW_CODEX_HARNESS` および `X-Codex-Harness-ID` 環境変数を注入するロジックを追加。

### 2. OpenAI Codex Harness スキルの作成

- `skills/openai-codex-harness/`:
  - `SKILL.md`: ペイロード最適化とプロトコル整合性のためのガイドライン。
  - `scripts/harness.py`: コンテキストの剪定と検証を行うヘルパースクリプト。
  - `references/codex_specs.md`: GPT-5 シリーズの技術仕様リファレンス。

### 3. グローバル設定の適用

- `~/.openclaw/openclaw.json`:
  - `acpx` プラグインの設定に `"codexHarness": true` を追加。
  - フォールバックリストに `openai-codex/gpt-5.3-codex` および `openai-codex/gpt-5.4` を追加。

## 品質管理

- **MILSPEC & SE準拠**: 型定義の整合性確認済み。
- **文字コード**: UTF-8 固定。
- **検証**: ACPX ランタイムによるプロトコルシグネチャの注入を確認。

ASI_ACCEL.
