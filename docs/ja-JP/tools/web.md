---
summary: "Web 検索・取得ツール（Brave Search API、Perplexity direct/OpenRouter、Gemini Google Search グラウンディング）"
read_when:
  - web_search または web_fetch を有効化したい場合
  - Brave Search API キーのセットアップが必要な場合
  - Web 検索に Perplexity Sonar を使用したい場合
  - Google Search グラウンディングで Gemini を使用したい場合
title: "Web ツール"
---

# Web ツール

OpenClaw は 2 つの軽量な Web ツールを提供しています:

- `web_search` — Brave Search API（デフォルト）、Perplexity Sonar、または Google Search グラウンディング付きの Gemini 経由でウェブを検索します。
- `web_fetch` — HTTP フェッチ + 読み取り可能なコンテンツ抽出（HTML → markdown/テキスト）。

これらはブラウザオートメーション**ではありません**。JavaScript が多いサイトやログインが必要なサイトには
[ブラウザツール](/tools/browser) を使用してください。

## 仕組み

- `web_search` は設定されたプロバイダーを呼び出して結果を返します。
  - **Brave**（デフォルト）: 構造化された結果（タイトル、URL、スニペット）を返します。
  - **Perplexity**: リアルタイム Web 検索からの引用付きの AI 合成回答を返します。
  - **Gemini**: 引用付きの Google 検索にグラウンドされた AI 合成回答を返します。
- 結果はクエリごとに 15 分間キャッシュされます（設定可能）。
- `web_fetch` はプレーンな HTTP GET を実行し、読み取り可能なコンテンツを抽出します
  （HTML → markdown/テキスト）。JavaScript は**実行しません**。
- `web_fetch` はデフォルトで有効です（明示的に無効化されていない限り）。

## 検索プロバイダーの選択

| プロバイダー            | 長所                                         | 短所                                     | API キー                                      |
| ------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **Brave**（デフォルト） | 高速、構造化された結果、無料ティアあり          | 従来の検索結果                           | `BRAVE_API_KEY`                              |
| **Perplexity**      | AI 合成回答、引用、リアルタイム               | Perplexity または OpenRouter アクセスが必要 | `OPENROUTER_API_KEY` または `PERPLEXITY_API_KEY` |
| **Gemini**          | Google 検索グラウンディング、AI 合成           | Gemini API キーが必要                    | `GEMINI_API_KEY`                             |

プロバイダー固有の詳細については [Brave Search セットアップ](/brave-search) と [Perplexity Sonar](/perplexity) を参照してください。

### 自動検出

`provider` が明示的に設定されていない場合、OpenClaw は利用可能な API キーに基づいて使用するプロバイダーを自動検出します。以下の順序で確認します:

1. **Brave** — `BRAVE_API_KEY` 環境変数または `search.apiKey` 設定
2. **Gemini** — `GEMINI_API_KEY` 環境変数または `search.gemini.apiKey` 設定
3. **Perplexity** — `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` 環境変数または `search.perplexity.apiKey` 設定
4. **Grok** — `XAI_API_KEY` 環境変数または `search.grok.apiKey` 設定

キーが見つからない場合は Brave にフォールバックします（設定を促すキー不足エラーが表示されます）。

### 明示的なプロバイダー

設定でプロバイダーを指定します:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // または "perplexity" または "gemini"
      },
    },
  },
}
```

例: Perplexity Sonar（直接 API）に切り替え:

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Brave API キーの取得

1. [https://brave.com/search/api/](https://brave.com/search/api/) で Brave Search API アカウントを作成します。
2. ダッシュボードで **Data for Search** プラン（「Data for AI」ではない）を選択し、API キーを生成します。
3. `openclaw configure --section web` を実行してキーを設定に保存するか（推奨）、環境に `BRAVE_API_KEY` を設定します。

Brave は無料ティアと有料プランを提供しています。現在の制限と価格については Brave API ポータルを確認してください。

### キーの設定場所（推奨）

**推奨:** `openclaw configure --section web` を実行します。`tools.web.search.apiKey` の下の
`~/.openclaw/openclaw.json` にキーが保存されます。

**環境変数の代替:** Gateway プロセスの環境に `BRAVE_API_KEY` を設定します。gateway インストールの場合は、`~/.openclaw/.env`（またはサービス環境）に記述してください。[環境変数](/help/faq#how-does-openclaw-load-environment-variables) を参照してください。

## Perplexity の使用（直接または OpenRouter 経由）

Perplexity Sonar モデルには Web 検索機能が組み込まれており、引用付きの AI 合成回答を返します。OpenRouter 経由で使用できます（クレジットカード不要 - 暗号通貨・プリペイドをサポート）。

### OpenRouter API キーの取得

1. [https://openrouter.ai/](https://openrouter.ai/) でアカウントを作成します。
2. クレジットを追加します（暗号通貨、プリペイド、クレジットカードをサポート）。
3. アカウント設定で API キーを生成します。

### Perplexity 検索のセットアップ

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API キー（OPENROUTER_API_KEY または PERPLEXITY_API_KEY が設定されている場合はオプション）
          apiKey: "sk-or-v1-...",
          // ベース URL（省略した場合はキーに応じたデフォルト）
          baseUrl: "https://openrouter.ai/api/v1",
          // モデル（デフォルトは perplexity/sonar-pro）
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**環境変数の代替:** Gateway 環境に `OPENROUTER_API_KEY` または `PERPLEXITY_API_KEY` を設定します。gateway インストールの場合は `~/.openclaw/.env` に記述してください。

ベース URL が設定されていない場合、OpenClaw は API キーのソースに基づいてデフォルトを選択します:

- `PERPLEXITY_API_KEY` または `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` または `sk-or-...` → `https://openrouter.ai/api/v1`
- 不明なキー形式 → OpenRouter（安全なフォールバック）

### 利用可能な Perplexity モデル

| モデル                            | 説明                                 | 最適な用途          |
| -------------------------------- | ------------------------------------ | ----------------- |
| `perplexity/sonar`               | Web 検索付き高速 Q&A                  | クイック検索        |
| `perplexity/sonar-pro`（デフォルト）| Web 検索付きマルチステップ推論        | 複雑な質問         |
| `perplexity/sonar-reasoning-pro` | 連鎖思考分析                          | 詳細なリサーチ      |

## Gemini の使用（Google Search グラウンディング）

Gemini モデルは組み込みの [Google Search グラウンディング](https://ai.google.dev/gemini-api/docs/grounding) をサポートしており、
引用付きのライブ Google 検索結果に裏付けられた AI 合成回答を返します。

### Gemini API キーの取得

1. [Google AI Studio](https://aistudio.google.com/apikey) にアクセスします。
2. API キーを作成します。
3. Gateway 環境に `GEMINI_API_KEY` を設定するか、`tools.web.search.gemini.apiKey` を設定します。

### Gemini 検索のセットアップ

```json5
{
  tools: {
    web: {
      search: {
        provider: "gemini",
        gemini: {
          // API キー（GEMINI_API_KEY が設定されている場合はオプション）
          apiKey: "AIza...",
          // モデル（デフォルトは "gemini-2.5-flash"）
          model: "gemini-2.5-flash",
        },
      },
    },
  },
}
```

**環境変数の代替:** Gateway 環境に `GEMINI_API_KEY` を設定します。
gateway インストールの場合は `~/.openclaw/.env` に記述してください。

### 注意事項

- Gemini グラウンディングからの引用 URL は Google のリダイレクト URL から直接 URL に自動的に解決されます。
- リダイレクト解決は最終的な引用 URL を返す前に SSRF ガードパス（HEAD + リダイレクトチェック + http/https 検証）を使用します。
- このリダイレクトリゾルバーは、Gateway オペレーターの信頼前提に合わせて信頼ネットワークモデル（プライベート・内部ネットワークはデフォルトで許可）に従います。
- デフォルトモデル（`gemini-2.5-flash`）は高速でコスト効率が高いです。
  グラウンディングをサポートする任意の Gemini モデルが使用できます。

## web_search

設定されたプロバイダーを使用してウェブを検索します。

### 要件

- `tools.web.search.enabled` が `false` でないこと（デフォルト: 有効）
- 選択したプロバイダーの API キー:
  - **Brave**: `BRAVE_API_KEY` または `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`、`PERPLEXITY_API_KEY`、または `tools.web.search.perplexity.apiKey`

### 設定

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // BRAVE_API_KEY が設定されている場合はオプション
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### ツールパラメーター

- `query`（必須）
- `count`（1〜10; デフォルトは設定から）
- `country`（オプション）: 地域固有の結果のための 2 文字の国コード（例: "DE"、"US"、"ALL"）。省略した場合、Brave はデフォルトの地域を選択します。
- `search_lang`（オプション）: 検索結果の ISO 言語コード（例: "de"、"en"、"fr"）
- `ui_lang`（オプション）: UI 要素の ISO 言語コード
- `freshness`（オプション）: 検出時間でフィルタリング
  - Brave: `pd`、`pw`、`pm`、`py`、または `YYYY-MM-DDtoYYYY-MM-DD`
  - Perplexity: `pd`、`pw`、`pm`、`py`

**例:**

```javascript
// ドイツ向け検索
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// フランス語 UI でのフランス語検索
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// 最近の結果（過去 1 週間）
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

URL を取得して読み取り可能なコンテンツを抽出します。

### web_fetch の要件

- `tools.web.fetch.enabled` が `false` でないこと（デフォルト: 有効）
- オプションの Firecrawl フォールバック: `tools.web.fetch.firecrawl.apiKey` または `FIRECRAWL_API_KEY` を設定。

### web_fetch の設定

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        maxResponseBytes: 2000000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // FIRECRAWL_API_KEY が設定されている場合はオプション
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ミリ秒（1 日）
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch ツールパラメーター

- `url`（必須、http/https のみ）
- `extractMode`（`markdown` | `text`）
- `maxChars`（長いページを切り詰める）

注意事項:

- `web_fetch` は最初に Readability（メインコンテンツ抽出）を使用し、次に Firecrawl（設定されている場合）を使用します。両方が失敗した場合、ツールはエラーを返します。
- Firecrawl リクエストはボット回避モードを使用し、デフォルトで結果をキャッシュします。
- `web_fetch` はデフォルトで Chrome のような User-Agent と `Accept-Language` を送信します; 必要に応じて `userAgent` を上書きしてください。
- `web_fetch` はプライベート・内部ホスト名をブロックし、リダイレクトを再確認します（`maxRedirects` で制限）。
- `maxChars` は `tools.web.fetch.maxCharsCap` にクランプされます。
- `web_fetch` はダウンロードされたレスポンスボディのサイズを解析前に `tools.web.fetch.maxResponseBytes` に制限します; サイズ超過のレスポンスは切り詰められ、警告が含まれます。
- `web_fetch` はベストエフォートの抽出です; 一部のサイトにはブラウザツールが必要です。
- キーのセットアップとサービスの詳細については [Firecrawl](/tools/firecrawl) を参照してください。
- 繰り返しのフェッチを減らすためにレスポンスはキャッシュされます（デフォルト 15 分）。
- ツールプロファイル・アローリストを使用する場合は、`web_search`/`web_fetch` または `group:web` を追加してください。
- Brave キーが不足している場合、`web_search` はドキュメントリンク付きの短いセットアップヒントを返します。
