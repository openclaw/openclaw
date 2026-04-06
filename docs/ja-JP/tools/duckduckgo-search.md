---
read_when:
    - APIキーが不要なWeb検索プロバイダーを使用したい場合
    - DuckDuckGoをweb_searchに使用したい場合
    - 設定不要の検索フォールバックが必要な場合
summary: DuckDuckGo Web検索 -- APIキー不要のフォールバックプロバイダー（実験的、HTMLベース）
title: DuckDuckGo検索
x-i18n:
    generated_at: "2026-04-02T09:01:08Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4170a499f44ab411493619632e8f7982bcad3331176aaecacdaa817ba426c85a
    source_path: tools/duckduckgo-search.md
    workflow: 15
---

# DuckDuckGo検索

OpenClawは、**APIキー不要**の`web_search`プロバイダーとしてDuckDuckGoをサポートしています。APIキーやアカウントは必要ありません。

<Warning>
  DuckDuckGoは、DuckDuckGoの非JavaScriptの検索ページから結果を取得する**実験的で非公式な**インテグレーションであり、公式APIではありません。ボットチャレンジページやHTMLの変更により、時折動作が不安定になることがあります。
</Warning>

## セットアップ

APIキーは不要です — DuckDuckGoをプロバイダーとして設定するだけです：

<Steps>
  <Step title="設定">
    ```bash
    openclaw configure --section web
    # プロバイダーとして「duckduckgo」を選択
    ```
  </Step>
</Steps>

## 設定

```json5
{
  tools: {
    web: {
      search: {
        provider: "duckduckgo",
      },
    },
  },
}
```

リージョンとSafeSearchのオプションのプラグインレベル設定：

```json5
{
  plugins: {
    entries: {
      duckduckgo: {
        config: {
          webSearch: {
            region: "us-en", // DuckDuckGoリージョンコード
            safeSearch: "moderate", // "strict"、"moderate"、または"off"
          },
        },
      },
    },
  },
}
```

## ツールパラメータ

| パラメータ    | 説明                                                        |
| ------------ | ---------------------------------------------------------- |
| `query`      | 検索クエリ（必須）                                           |
| `count`      | 返す結果数（1-10、デフォルト：5）                              |
| `region`     | DuckDuckGoリージョンコード（例：`us-en`、`uk-en`、`de-de`）    |
| `safeSearch` | SafeSearchレベル：`strict`、`moderate`（デフォルト）、または`off` |

リージョンとSafeSearchはプラグイン設定でも設定できます（上記参照）— ツールパラメータはクエリごとに設定値を上書きします。

## 注意事項

- **APIキー不要** — 設定なしですぐに動作します
- **実験的** — 公式APIやSDKではなく、DuckDuckGoの非JavaScriptのHTML検索ページから結果を収集します
- **ボットチャレンジのリスク** — 大量または自動化された使用では、DuckDuckGoがCAPTCHAを表示したりリクエストをブロックする場合があります
- **HTMLパース** — 結果はページ構造に依存しており、予告なく変更される可能性があります
- **自動検出順序** — DuckDuckGoは自動検出で最後（順序100）にチェックされるため、キーを持つAPIベースのプロバイダーが優先されます
- **SafeSearchは未設定の場合moderateがデフォルト**です

<Tip>
  本番環境での使用には、[Brave検索](/tools/brave-search)（無料枠あり）または他のAPIベースのプロバイダーを検討してください。
</Tip>

## 関連

- [Web検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Brave検索](/tools/brave-search) -- 無料枠付きの構造化された結果
- [Exa検索](/tools/exa-search) -- コンテンツ抽出付きのニューラル検索
