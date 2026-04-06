---
read_when:
    - Exaをweb_searchに使用したい場合
    - EXA_API_KEYが必要な場合
    - ニューラル検索やコンテンツ抽出を使用したい場合
summary: Exa AI検索 -- コンテンツ抽出付きのニューラル検索とキーワード検索
title: Exa検索
x-i18n:
    generated_at: "2026-04-02T09:01:28Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 307b727b4fb88756cac51c17ffd73468ca695c4481692e03d0b4a9969982a2a8
    source_path: tools/exa-search.md
    workflow: 15
---

# Exa検索

OpenClawは、`web_search`プロバイダーとして[Exa AI](https://exa.ai/)をサポートしています。Exaは、組み込みのコンテンツ抽出（ハイライト、テキスト、要約）を備えたニューラル、キーワード、ハイブリッド検索モードを提供します。

## APIキーの取得

<Steps>
  <Step title="アカウントの作成">
    [exa.ai](https://exa.ai/)でサインアップし、ダッシュボードからAPIキーを生成してください。
  </Step>
  <Step title="キーの保存">
    Gateway ゲートウェイの環境変数に`EXA_API_KEY`を設定するか、以下のコマンドで設定してください：

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
      exa: {
        config: {
          webSearch: {
            apiKey: "exa-...", // EXA_API_KEYが設定済みの場合は省略可能
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "exa",
      },
    },
  },
}
```

**環境変数による代替方法：** Gateway ゲートウェイの環境変数に`EXA_API_KEY`を設定してください。
Gateway ゲートウェイをインストールしている場合は、`~/.openclaw/.env`に記述してください。

## ツールパラメータ

| パラメータ     | 説明                                                                           |
| ------------- | ----------------------------------------------------------------------------- |
| `query`       | 検索クエリ（必須）                                                               |
| `count`       | 返す結果数（1-100）                                                              |
| `type`        | 検索モード：`auto`、`neural`、`fast`、`deep`、`deep-reasoning`、または`instant`     |
| `freshness`   | 時間フィルター：`day`、`week`、`month`、または`year`                                |
| `date_after`  | この日付以降の結果（YYYY-MM-DD）                                                  |
| `date_before` | この日付以前の結果（YYYY-MM-DD）                                                  |
| `contents`    | コンテンツ抽出オプション（下記参照）                                                 |

### コンテンツ抽出

Exaは検索結果と合わせて抽出されたコンテンツを返すことができます。有効にするには`contents`オブジェクトを渡してください：

```javascript
await web_search({
  query: "transformer architecture explained",
  type: "neural",
  contents: {
    text: true, // ページ全文
    highlights: { numSentences: 3 }, // 重要な文
    summary: true, // AI要約
  },
});
```

| contentsオプション | 型                                                                     | 説明                    |
| ----------------- | --------------------------------------------------------------------- | ---------------------- |
| `text`            | `boolean \| { maxCharacters }`                                        | ページ全文を抽出         |
| `highlights`      | `boolean \| { maxCharacters, query, numSentences, highlightsPerUrl }` | 重要な文を抽出           |
| `summary`         | `boolean \| { query }`                                                | AIによる要約を生成       |

### 検索モード

| モード            | 説明                                |
| ---------------- | ----------------------------------- |
| `auto`           | Exaが最適なモードを選択（デフォルト）   |
| `neural`         | セマンティック/意味ベースの検索         |
| `fast`           | 高速キーワード検索                     |
| `deep`           | 徹底的な深層検索                       |
| `deep-reasoning` | 推論付き深層検索                       |
| `instant`        | 最速の結果                            |

## 注意事項

- `contents`オプションが指定されていない場合、Exaはデフォルトで`{ highlights: true }`を使用し、結果に重要な文の抜粋が含まれます
- 結果にはExa APIレスポンスから利用可能な場合、`highlightScores`と`summary`フィールドが保持されます
- 結果の説明は、ハイライト、要約、全文の順に、利用可能なものから解決されます
- `freshness`と`date_after`/`date_before`は併用できません — いずれか一方の時間フィルターモードを使用してください
- クエリごとに最大100件の結果を返すことができます（Exaの検索タイプの制限に従います）
- 結果はデフォルトで15分間キャッシュされます（`cacheTtlMinutes`で設定可能）
- Exaは構造化されたJSONレスポンスを返す公式APIインテグレーションです

## 関連

- [Web検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Brave検索](/tools/brave-search) -- 国/言語フィルター付きの構造化された結果
- [Perplexity検索](/tools/perplexity-search) -- ドメインフィルタリング付きの構造化された結果
