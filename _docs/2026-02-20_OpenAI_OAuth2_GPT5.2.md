# 2026-02-20 OpenAI Codex OAuth2 設定 (GPT-5.2)

## 概要

OpenAI Codex GPT-5.2 のメインAI接続を、APIキー方式からOAuth2方式に変更した。

## 変更内容

### `src/commands/openai-codex-model-default.ts`

```diff
-export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.3-codex";
+export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.2";
```

### `.env` (ローカルのみ、gitignore対象)

```diff
-OPENAI_API_KEY=sk-your-openai-api-key-here
+OPENAI_AUTH_MODE=oauth

-DEFAULT_AI_PROVIDER=openai
-PRIMARY_MODEL=openai/codex-5.2
+DEFAULT_AI_PROVIDER=openai-codex
+PRIMARY_MODEL=openai-codex/gpt-5.2
+CODEX_MODEL=gpt-5.2
```

## OAuth2 認証フロー

既存の `loginOpenAICodexOAuth()` → `loginOpenAICodex()` (`@mariozechner/pi-ai`) を使用：

```
node openclaw.mjs configure
→ "OpenAI Codex (OAuth)" を選択
→ ブラウザが開きOpenAI認証
→ 認証完了後、OAuthトークンが ~/.openclaw/agents/<id>/credentials.json に保存
→ provider: "openai-codex", mode: "oauth" でプロファイル設定
```

## モデル構成

| 役割                | プロバイダー            | モデル                                  |
| ------------------- | ----------------------- | --------------------------------------- |
| メイン中枢          | `openai-codex` (OAuth2) | `gpt-5.2`                               |
| サブ/フォールバック | `ollama` (GGUF)         | `rnj-1-instruct`, `aegis-phi3.5-jpv2.5` |

## 型チェック

`pnpm tsgo` → **エラー0** ✅
