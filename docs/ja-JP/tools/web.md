---
read_when:
    - web_searchを有効化または設定したい場合
    - x_searchを有効化または設定したい場合
    - 検索プロバイダーを選択する必要がある場合
    - 自動検出とプロバイダーのフォールバックについて理解したい場合
sidebarTitle: Web Search
summary: web_search、x_search、web_fetch -- ウェブ検索、X投稿の検索、ページコンテンツの取得
title: ウェブ検索
x-i18n:
    generated_at: "2026-04-02T08:41:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4b62e635b2afb1b7082c50dc4a65fc6d07d84c207eedb450444115d52f98440e
    source_path: tools/web.md
    workflow: 15
---

# ウェブ検索

`web_search`ツールは、設定されたプロバイダーを使用してウェブを検索し、結果を返します。結果はクエリごとに15分間キャッシュされます（設定可能）。

OpenClawには、X（旧Twitter）の投稿を検索する`x_search`と、軽量なURL取得を行う`web_fetch`も含まれています。現段階では、`web_fetch`はローカルで動作し、`web_search`と`x_search`は内部でxAI Responsesを使用できます。

<Info>
  `web_search`は軽量なHTTPツールであり、ブラウザ自動化ではありません。
  JSを多用するサイトやログインが必要な場合は、[ウェブブラウザ](/tools/browser)を使用してください。特定のURLを取得する場合は、[Web Fetch](/tools/web-fetch)を使用してください。
</Info>

## クイックスタート

<Steps>
  <Step title="APIキーを取得する">
    プロバイダーを選択し、APIキーを取得します。サインアップリンクについては、以下のプロバイダーページを参照してください。
  </Step>
  <Step title="設定する">
    ```bash
    openclaw configure --section web
    ```
    これによりキーが保存され、プロバイダーが設定されます。環境変数（例: `BRAVE_API_KEY`）を設定して、このステップをスキップすることもできます。
  </Step>
  <Step title="使用する">
    エージェントが`web_search`を呼び出せるようになります:

    ```javascript
    await web_search({ query: "OpenClaw plugin SDK" });
    ```

    X投稿の検索には以下を使用します:

    ```javascript
    await x_search({ query: "dinner recipes" });
    ```

  </Step>
</Steps>

## プロバイダーの選択

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    スニペット付きの構造化された結果。`llm-context`モード、国/言語フィルターをサポート。無料プランあり。
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    キー不要のフォールバック。APIキー不要。非公式のHTMLベースの統合。
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    ニューラル＋キーワード検索とコンテンツ抽出（ハイライト、テキスト、要約）。
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    構造化された結果。`firecrawl_search`と`firecrawl_scrape`を組み合わせた深い抽出に最適。
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    Google Search グラウンディングによる引用付きAI合成回答。
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    xAIウェブグラウンディングによる引用付きAI合成回答。
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    Moonshotウェブ検索による引用付きAI合成回答。
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    コンテンツ抽出制御とドメインフィルタリング付きの構造化された結果。
  </Card>
  <Card title="SearXNG" icon="server" href="/tools/searxng-search">
    セルフホスト型メタ検索。APIキー不要。Google、Bing、DuckDuckGoなどを集約。
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    検索深度、トピックフィルタリング、URL抽出用の`tavily_extract`付きの構造化された結果。
  </Card>
</CardGroup>

### プロバイダー比較

| プロバイダー                           | 結果スタイル               | フィルター                                       | APIキー                                     |
| -------------------------------------- | -------------------------- | ------------------------------------------------ | ------------------------------------------- |
| [Brave](/tools/brave-search)           | 構造化スニペット           | 国、言語、時間、`llm-context`モード              | `BRAVE_API_KEY`                             |
| [DuckDuckGo](/tools/duckduckgo-search) | 構造化スニペット           | --                                               | なし（キー不要）                            |
| [Exa](/tools/exa-search)               | 構造化＋抽出               | ニューラル/キーワードモード、日付、コンテンツ抽出 | `EXA_API_KEY`                               |
| [Firecrawl](/tools/firecrawl)          | 構造化スニペット           | `firecrawl_search`ツール経由                     | `FIRECRAWL_API_KEY`                         |
| [Gemini](/tools/gemini-search)         | AI合成＋引用               | --                                               | `GEMINI_API_KEY`                            |
| [Grok](/tools/grok-search)             | AI合成＋引用               | --                                               | `XAI_API_KEY`                               |
| [Kimi](/tools/kimi-search)             | AI合成＋引用               | --                                               | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| [Perplexity](/tools/perplexity-search) | 構造化スニペット           | 国、言語、時間、ドメイン、コンテンツ制限         | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |
| [SearXNG](/tools/searxng-search)       | 構造化スニペット           | カテゴリー、言語                                 | なし（セルフホスト）                        |
| [Tavily](/tools/tavily)                | 構造化スニペット           | `tavily_search`ツール経由                        | `TAVILY_API_KEY`                            |

## 自動検出

## ネイティブCodexウェブ検索

Codex対応モデルは、OpenClawのマネージド`web_search`関数の代わりに、プロバイダーネイティブのResponses `web_search`ツールをオプションで使用できます。

- `tools.web.search.openaiCodex`で設定します
- Codex対応モデル（`openai-codex/*`または`api: "openai-codex-responses"`を使用するプロバイダー）でのみ有効化されます
- 非Codexモデルにはマネージド`web_search`が引き続き適用されます
- `mode: "cached"`がデフォルトであり、推奨設定です
- `tools.web.search.enabled: false`はマネージド検索とネイティブ検索の両方を無効化します

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        openaiCodex: {
          enabled: true,
          mode: "cached",
          allowedDomains: ["example.com"],
          contextSize: "high",
          userLocation: {
            country: "US",
            city: "New York",
            timezone: "America/New_York",
          },
        },
      },
    },
  },
}
```

ネイティブCodex検索が有効化されていても、現在のモデルがCodex対応でない場合、OpenClawは通常のマネージド`web_search`動作を維持します。

## ウェブ検索の設定

ドキュメントやセットアップフローのプロバイダーリストはアルファベット順です。自動検出は別の優先順位を使用します:

`provider`が設定されていない場合、OpenClawはこの順序でAPIキーを確認し、最初に見つかったものを使用します:

1. **Brave** -- `BRAVE_API_KEY`または`plugins.entries.brave.config.webSearch.apiKey`
2. **Gemini** -- `GEMINI_API_KEY`または`plugins.entries.google.config.webSearch.apiKey`
3. **Grok** -- `XAI_API_KEY`または`plugins.entries.xai.config.webSearch.apiKey`
4. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY`または`plugins.entries.moonshot.config.webSearch.apiKey`
5. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY`または`plugins.entries.perplexity.config.webSearch.apiKey`
6. **Firecrawl** -- `FIRECRAWL_API_KEY`または`plugins.entries.firecrawl.config.webSearch.apiKey`
7. **Tavily** -- `TAVILY_API_KEY`または`plugins.entries.tavily.config.webSearch.apiKey`

キー不要のプロバイダーは、APIキーを必要とするプロバイダーの後に確認されます:

8. **DuckDuckGo** -- キー不要（自動検出順序100）
9. **SearXNG** -- `SEARXNG_BASE_URL`または`plugins.entries.searxng.config.webSearch.baseUrl`（自動検出順序200）

プロバイダーが検出されない場合、Braveにフォールバックします（キーが見つからないエラーが表示され、設定を促されます）。

<Note>
  すべてのプロバイダーキーフィールドはSecretRefオブジェクトをサポートしています。自動検出モードでは、
  OpenClawは選択されたプロバイダーのキーのみを解決し、選択されていないSecretRefは
  非アクティブのまま保持されます。
</Note>

## 設定

```json5
{
  tools: {
    web: {
      search: {
        enabled: true, // デフォルト: true
        provider: "brave", // または自動検出の場合は省略
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

プロバイダー固有の設定（APIキー、ベースURL、モード）は
`plugins.entries.<plugin>.config.webSearch.*`の下に配置されます。例については、各プロバイダーページを参照してください。

`x_search`については、`tools.web.x_search.*`で直接設定します。Grokウェブ検索と同じ`XAI_API_KEY`フォールバックを使用します。
`openclaw onboard`または`openclaw configure --section web`でGrokを選択すると、
OpenClawは同じキーを使用してオプションの`x_search`セットアップも提案できます。
これはGrokパス内の別のフォローアップステップであり、独立したトップレベルの
ウェブ検索プロバイダー選択ではありません。別のプロバイダーを選択した場合、OpenClawは
`x_search`プロンプトを表示しません。

### APIキーの保存

<Tabs>
  <Tab title="設定ファイル">
    `openclaw configure --section web`を実行するか、キーを直接設定します:

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "YOUR_KEY", // pragma: allowlist secret
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="環境変数">
    Gateway ゲートウェイプロセスの環境にプロバイダーの環境変数を設定します:

    ```bash
    export BRAVE_API_KEY="YOUR_KEY"
    ```

    Gateway ゲートウェイインストールの場合は、`~/.openclaw/.env`に設定します。
    [環境変数](/help/faq#env-vars-and-env-loading)を参照してください。

  </Tab>
</Tabs>

## ツールパラメーター

| パラメーター          | 説明                                                  |
| --------------------- | ----------------------------------------------------- |
| `query`               | 検索クエリ（必須）                                    |
| `count`               | 返す結果の数（1-10、デフォルト: 5）                   |
| `country`             | 2文字のISO国コード（例: "US"、"DE"）                  |
| `language`            | ISO 639-1言語コード（例: "en"、"de"）                 |
| `freshness`           | 時間フィルター: `day`、`week`、`month`、または`year`  |
| `date_after`          | この日付以降の結果（YYYY-MM-DD）                      |
| `date_before`         | この日付以前の結果（YYYY-MM-DD）                      |
| `ui_lang`             | UI言語コード（Braveのみ）                             |
| `domain_filter`       | ドメイン許可/拒否リスト配列（Perplexityのみ）         |
| `max_tokens`          | コンテンツの合計トークン予算、デフォルト25000（Perplexityのみ） |
| `max_tokens_per_page` | ページごとのトークン制限、デフォルト2048（Perplexityのみ） |

<Warning>
  すべてのパラメーターがすべてのプロバイダーで動作するわけではありません。Braveの`llm-context`モードでは
  `ui_lang`、`freshness`、`date_after`、`date_before`は拒否されます。
  FirecrawlとTavilyは`web_search`では`query`と`count`のみをサポートします
  -- 高度なオプションについては専用ツールを使用してください。
</Warning>

## x_search

`x_search`はxAIを使用してX（旧Twitter）の投稿をクエリし、引用付きのAI合成回答を返します。自然言語クエリとオプションの構造化フィルターを受け付けます。OpenClawは、このツール呼び出しを処理するリクエストでのみ、組み込みのxAI `x_search`ツールを有効化します。

<Note>
  xAIは`x_search`がキーワード検索、セマンティック検索、ユーザー検索、スレッド取得をサポートしていると記載しています。リポスト、リプライ、ブックマーク、閲覧数などの投稿ごとのエンゲージメント統計については、正確な投稿URLまたはステータスIDによるターゲット検索を推奨します。広範なキーワード検索では正しい投稿が見つかる場合がありますが、投稿ごとのメタデータが不完全になることがあります。良いパターンは: まず投稿を特定し、次にその正確な投稿に焦点を当てた2回目の`x_search`クエリを実行することです。
</Note>

### x_search設定

```json5
{
  tools: {
    web: {
      x_search: {
        enabled: true,
        apiKey: "xai-...", // XAI_API_KEYが設定されている場合はオプション
        model: "grok-4-1-fast-non-reasoning",
        inlineCitations: false,
        maxTurns: 2,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### x_searchパラメーター

| パラメーター                 | 説明                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `query`                      | 検索クエリ（必須）                                     |
| `allowed_x_handles`          | 特定のXハンドルに結果を制限する                        |
| `excluded_x_handles`         | 特定のXハンドルを除外する                              |
| `from_date`                  | この日付以降の投稿のみ含める（YYYY-MM-DD）             |
| `to_date`                    | この日付以前の投稿のみ含める（YYYY-MM-DD）             |
| `enable_image_understanding` | xAIがマッチした投稿に添付された画像を検査できるようにする |
| `enable_video_understanding` | xAIがマッチした投稿に添付された動画を検査できるようにする |

### x_searchの例

```javascript
await x_search({
  query: "dinner recipes",
  allowed_x_handles: ["nytfood"],
  from_date: "2026-03-01",
});
```

```javascript
// 投稿ごとの統計: 可能な場合は正確なステータスURLまたはステータスIDを使用
await x_search({
  query: "https://x.com/huntharo/status/1905678901234567890",
});
```

## 使用例

```javascript
// 基本的な検索
await web_search({ query: "OpenClaw plugin SDK" });

// ドイツ向け検索
await web_search({ query: "TV online schauen", country: "DE", language: "de" });

// 最近の結果（過去1週間）
await web_search({ query: "AI developments", freshness: "week" });

// 日付範囲
await web_search({
  query: "climate research",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// ドメインフィルタリング（Perplexityのみ）
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});
```

## ツールプロファイル

ツールプロファイルや許可リストを使用する場合は、`web_search`、`x_search`、または`group:web`を追加します:

```json5
{
  tools: {
    allow: ["web_search", "x_search"],
    // または: allow: ["group:web"]（web_search、x_search、web_fetchを含む）
  },
}
```

## 関連項目

- [Web Fetch](/tools/web-fetch) -- URLを取得して読みやすいコンテンツを抽出する
- [ウェブブラウザ](/tools/browser) -- JSを多用するサイト向けのフルブラウザ自動化
- [Grok Search](/tools/grok-search) -- `web_search`プロバイダーとしてのGrok
