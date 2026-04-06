---
read_when:
    - Kimi を web_search に使用したい場合
    - KIMI_API_KEY または MOONSHOT_API_KEY が必要な場合
summary: Moonshot ウェブ検索による Kimi ウェブ検索
title: Kimi Search
x-i18n:
    generated_at: "2026-04-02T07:55:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: dd0f9128f3b9ab6ce22521d4b30ef58a7fe8e9ff26afacf7f7cf23f0f1f47e84
    source_path: tools/kimi-search.md
    workflow: 15
---

# Kimi Search

OpenClaw は Kimi を `web_search` プロバイダーとしてサポートしており、Moonshot ウェブ検索を使用して引用付きの AI 合成回答を生成します。

## API キーの取得

<Steps>
  <Step title="キーを作成する">
    [Moonshot AI](https://platform.moonshot.cn/) から API キーを取得します。
  </Step>
  <Step title="キーを保存する">
    Gateway ゲートウェイの環境に `KIMI_API_KEY` または `MOONSHOT_API_KEY` を設定するか、以下のコマンドで設定します：

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## 設定

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // KIMI_API_KEY または MOONSHOT_API_KEY が設定されている場合は省略可能
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

**環境変数による代替方法:** Gateway ゲートウェイの環境に `KIMI_API_KEY` または `MOONSHOT_API_KEY` を設定します。Gateway ゲートウェイのインストール環境では、`~/.openclaw/.env` に記述してください。

## 仕組み

Kimi は Moonshot ウェブ検索を使用して、インライン引用付きの回答を合成します。これは Gemini や Grok のグラウンデッドレスポンスのアプローチと同様です。

## サポートされるパラメータ

Kimi 検索は標準の `query` および `count` パラメータをサポートしています。プロバイダー固有のフィルターは現在サポートされていません。

## 関連

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Gemini Search](/tools/gemini-search) -- Google グラウンディングによる AI 合成回答
- [Grok Search](/tools/grok-search) -- xAI グラウンディングによる AI 合成回答
