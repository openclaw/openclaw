---
read_when:
    - Grok を web_search に使用したい場合
    - ウェブ検索に XAI_API_KEY が必要な場合
summary: xAI のウェブグラウンデッドレスポンスによる Grok ウェブ検索
title: Grok Search
x-i18n:
    generated_at: "2026-04-02T07:55:47Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4653accf20ac0f3cf4486d184560b01783bbd58a201501870cca9947b358b7cd
    source_path: tools/grok-search.md
    workflow: 15
---

# Grok Search

OpenClaw は Grok を `web_search` プロバイダーとしてサポートしており、xAI のウェブグラウンデッドレスポンスを使用して、引用付きのライブ検索結果に基づいた AI 合成回答を生成します。

同じ `XAI_API_KEY` で、X（旧 Twitter）のポスト検索用の組み込み `x_search` ツールも利用できます。キーを `plugins.entries.xai.config.webSearch.apiKey` に保存すると、OpenClaw はバンドルされた xAI モデルプロバイダーのフォールバックとしても再利用します。

リポスト、リプライ、ブックマーク、閲覧数などのポストレベルの X メトリクスについては、幅広い検索クエリではなく、正確なポスト URL またはステータス ID を指定して `x_search` を使用してください。

## オンボーディングと設定

以下の実行時に **Grok** を選択した場合：

- `openclaw onboard`
- `openclaw configure --section web`

OpenClaw は同じ `XAI_API_KEY` で `x_search` を有効にするための追加のフォローアップステップを表示できます。このフォローアップは：

- `web_search` で Grok を選択した後にのみ表示されます
- 別のトップレベルのウェブ検索プロバイダーの選択肢ではありません
- 同じフロー内でオプションとして `x_search` のモデルを設定できます

スキップした場合は、後から設定で `x_search` を有効化または変更できます。

## API キーの取得

<Steps>
  <Step title="キーを作成する">
    [xAI](https://console.x.ai/) から API キーを取得してください。
  </Step>
  <Step title="キーを保存する">
    Gateway ゲートウェイの環境に `XAI_API_KEY` を設定するか、以下のコマンドで設定してください：

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
      xai: {
        config: {
          webSearch: {
            apiKey: "xai-...", // XAI_API_KEY が設定されている場合は省略可能
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "grok",
      },
    },
  },
}
```

**環境変数による代替方法:** Gateway ゲートウェイの環境に `XAI_API_KEY` を設定してください。Gateway ゲートウェイインストールの場合は、`~/.openclaw/.env` に記述してください。

## 仕組み

Grok は xAI のウェブグラウンデッドレスポンスを使用して、インライン引用付きの回答を合成します。これは Gemini の Google Search グラウンディングアプローチと類似しています。

## サポートされるパラメータ

Grok 検索は標準の `query` および `count` パラメータをサポートしています。プロバイダー固有のフィルターは現在サポートされていません。

## 関連情報

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [ウェブ検索の x_search](/tools/web#x_search) -- xAI によるファーストクラスの X 検索
- [Gemini Search](/tools/gemini-search) -- Google グラウンディングによる AI 合成回答
