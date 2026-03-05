# 2026-03-06 Fallback Model Update (Antigravity)

## 概要

OpenAI-codex (OAuth) 経由で利用可能な最新の GPT-5 モデルをフォールバックリストに追加しました。

## 実施内容

- `extensions/openai-codex-auth/index.ts` にて `gpt-5.3-codex` および `gpt-5.4` の定義を追加。
- `~/.openclaw/openclaw.json` の `agents.defaults.model.fallbacks` に新しいモデルを追加し、優先順位を調整。

## 構成

- モデルID: `openai-codex/gpt-5.3-codex` (優先度高)
- モデルID: `openai-codex/gpt-5.4`
- モデルID: `openai-codex/gpt-5.2` (既存)

## 品質管理

- 文字コード: UTF-8
- `openclaw.json` の整合性確認済み。
- 拡張機能ソースコードの定義整合性確認済み。

ASI_ACCEL.
