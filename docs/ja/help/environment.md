---
summary: 「OpenClaw が環境変数を読み込む場所と、その優先順位」
read_when:
  - どの環境変数が読み込まれ、どの順序で適用されるかを知る必要がある場合
  - Gateway で API キーが見つからない問題をデバッグしている場合
  - プロバイダー認証やデプロイ環境をドキュメント化している場合
title: 「環境変数」
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:01Z
---

# 環境変数

OpenClaw は複数のソースから環境変数を取得します。ルールは **既存の値を決して上書きしない** ことです。

## 優先順位（高い → 低い）

1. **プロセス環境**（Gateway プロセスが親のシェル／デーモンからすでに受け取っているもの）。
2. **現在の作業ディレクトリにある `.env`**（dotenv のデフォルト。上書きしません）。
3. **`~/.openclaw/.env` にあるグローバル `.env`**（別名 `$OPENCLAW_STATE_DIR/.env`。上書きしません）。
4. **`~/.openclaw/openclaw.json` 内の Config `env` ブロック**（欠落している場合にのみ適用）。
5. **任意のログインシェルからのインポート**（`env.shellEnv.enabled` または `OPENCLAW_LOAD_SHELL_ENV=1`）。期待されるキーが欠けている場合にのみ適用。

Config ファイルが完全に存在しない場合は、手順 4 はスキップされます。シェルインポートは、有効化されていれば引き続き実行されます。

## Config `env` ブロック

インラインで環境変数を設定する同等の方法が 2 つあります（いずれも上書きしません）：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## シェルの環境変数インポート

`env.shellEnv` はログインシェルを実行し、**欠落している** 期待されるキーのみをインポートします：

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

環境変数の同等設定：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Config 内での環境変数置換

`${VAR_NAME}` 構文を使用して、Config の文字列値内で環境変数を直接参照できます：

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

詳細は「[Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config)」を参照してください。

## 関連

- [Gateway 設定](/gateway/configuration)
- [FAQ: env vars と .env の読み込み](/help/faq#env-vars-and-env-loading)
- [モデル概要](/concepts/models)
