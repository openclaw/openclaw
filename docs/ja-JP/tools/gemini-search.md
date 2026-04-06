---
read_when:
    - Gemini を web_search に使用したい場合
    - GEMINI_API_KEY が必要な場合
    - Google Search グラウンディングを使用したい場合
summary: Google Search グラウンディングによる Gemini ウェブ検索
title: Gemini Search
x-i18n:
    generated_at: "2026-04-02T07:55:45Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9c685ae976b7e6c376d779b8b3910e3a990b2638cd34b7d805435b14c838d994
    source_path: tools/gemini-search.md
    workflow: 15
---

# Gemini Search

OpenClaw は、ライブの Google Search 結果に基づく引用付きの AI 合成回答を返す、組み込みの
[Google Search グラウンディング](https://ai.google.dev/gemini-api/docs/grounding)を備えた
Gemini モデルをサポートしている。

## API キーの取得

<Steps>
  <Step title="キーの作成">
    [Google AI Studio](https://aistudio.google.com/apikey) にアクセスして
    API キーを作成する。
  </Step>
  <Step title="キーの保存">
    Gateway ゲートウェイの環境変数に `GEMINI_API_KEY` を設定するか、以下のコマンドで設定する：

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
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // GEMINI_API_KEY が設定されている場合は省略可能
            model: "gemini-2.5-flash", // デフォルト
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "gemini",
      },
    },
  },
}
```

**環境変数による代替方法:** Gateway ゲートウェイの環境変数に `GEMINI_API_KEY` を設定する。
Gateway ゲートウェイインストールの場合は、`~/.openclaw/.env` に記述する。

## 仕組み

リンクとスニペットのリストを返す従来の検索プロバイダーとは異なり、
Gemini は Google Search グラウンディングを使用して、インライン引用付きの
AI 合成回答を生成する。結果には合成された回答とソース URL の両方が含まれる。

- Gemini グラウンディングからの引用 URL は、Google リダイレクト URL から直接 URL へ自動的に解決される。
- リダイレクト解決は、最終的な引用 URL を返す前に SSRF ガードパス（HEAD + リダイレクトチェック + http/https バリデーション）を使用する。
- リダイレクト解決は厳格な SSRF デフォルトを使用するため、プライベート/内部ターゲットへのリダイレクトはブロックされる。

## サポートされるパラメータ

Gemini 検索は標準の `query` および `count` パラメータをサポートしている。
`country`、`language`、`freshness`、`domain_filter` などのプロバイダー固有のフィルターはサポートされていない。

## モデル選択

デフォルトのモデルは `gemini-2.5-flash`（高速でコスト効率が高い）である。グラウンディングをサポートする任意の Gemini
モデルを `plugins.entries.google.config.webSearch.model` で指定して使用できる。

## 関連項目

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Brave Search](/tools/brave-search) -- スニペット付きの構造化された結果
- [Perplexity Search](/tools/perplexity-search) -- 構造化された結果 + コンテンツ抽出
