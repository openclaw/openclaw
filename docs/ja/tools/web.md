---
summary: "Web 検索 + フェッチツール（Brave Search API、Perplexity 直接 / OpenRouter）"
read_when:
  - web_search または web_fetch を有効にしたい場合
  - Brave Search API キーのセットアップが必要な場合
  - Web 検索に Perplexity Sonar を使用したい場合
title: "Web ツール"
---

# Web ツール

OpenClaw には、軽量な Web ツールが 2 つ同梱されています。

- `web_search` — Brave Search API（デフォルト）または Perplexity Sonar（直接または OpenRouter 経由）を使用した Web 検索。
- `web_fetch` — HTTP フェッチ + 可読性抽出（HTML → markdown / text）。

これらは **ブラウザ自動化ではありません**。JS を多用するサイトやログインが必要な場合は、
[Browser tool](/tools/browser) を使用してください。 JS重いサイトやログインには、
[ブラウザツール](/tools/browser)を使用します。

## How it works

- `web_search` は、設定されたプロバイダーを呼び出して結果を返します。
  - **Brave**（デフォルト）: 構造化された結果（タイトル、URL、スニペット）を返します。
  - **Perplexity**: リアルタイム Web 検索に基づく、引用付きの AI 合成回答を返します。
- 結果はクエリごとに 15 分間キャッシュされます（設定可能）。
- `web_fetch` は通常の HTTP GET を行い、可読なコンテンツを抽出します
  （HTML → markdown / text）。JavaScript は **実行しません**。 JavaScriptは実行されません。
- `web_fetch` は、明示的に無効化されない限りデフォルトで有効です。

## 検索プロバイダーの選択

| プロバイダー           | 利点                | Coins                               | API キー                                        |
| ---------------- | ----------------- | ----------------------------------- | --------------------------------------------- |
| **Brave**（デフォルト） | 高速、構造化された結果、無料枠あり | 従来型の検索結果                            | `BRAVE_API_KEY`                               |
| **Perplexity**   | AI 合成回答、引用、リアルタイム | Perplexity または OpenRouter へのアクセスが必要 | `OPENROUTER_API_KEY` または `PERPLEXITY_API_KEY` |

プロバイダー固有の詳細については、[Brave Search setup](/brave-search) および [Perplexity Sonar](/perplexity) を参照してください。

設定でプロバイダを設定:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

例: Perplexity Sonar（直接 API）に切り替える場合:

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
2. ダッシュボードで **Data for Search** プラン（「Data for AI」ではありません）を選択し、API キーを生成します。
3. `openclaw configure --section web` を実行してキーを設定に保存する（推奨）か、環境変数に `BRAVE_API_KEY` を設定します。

Brave には無料枠と有料プランがあります。現在の制限や料金については、
Brave API ポータルを確認してください。

### キーの設定場所（推奨）

**推奨:** `openclaw configure --section web`を実行します。 **推奨:** `openclaw configure --section web` を実行します。キーは
`~/.openclaw/openclaw.json` の `tools.web.search.apiKey` に保存されます。

**環境の代替:** ゲートウェイプロセス
環境に`BRAVE_API_KEY` を設定します。 ゲートウェイをインストールするには、`~/.openclaw/.env` (または
サービス環境)に入れてください。 **環境変数の代替:** Gateway プロセスの環境に `BRAVE_API_KEY` を設定します。
Gateway のインストールでは、`~/.openclaw/.env`（またはサービスの環境）に設定してください。
詳細は [Env vars](/help/faq#how-does-openclaw-load-environment-variables) を参照してください。

## Perplexity の使用（直接または OpenRouter 経由）

Perplexity Sonar モデルには Web 検索機能が組み込まれており、
引用付きの AI 合成回答を返します。OpenRouter 経由でも使用できます
（クレジットカード不要、暗号資産 / プリペイド対応）。 OpenRouter経由で使用できます(クレジットカードは必要ありません。
crypto/prepaidをサポートしています)。

### OpenRouter API キーの取得

1. [https://openrouter.ai/](https://openrouter.ai/) でアカウントを作成します。
2. クレジットを追加します（暗号資産、プリペイド、クレジットカード対応）。
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
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**環境変数の代替:** Gateway 環境に `OPENROUTER_API_KEY` または `PERPLEXITY_API_KEY` を設定します。
Gateway のインストールでは、`~/.openclaw/.env` に設定してください。 ゲートウェイをインストールするには、`~/.openclaw/.env`に入れてください。

ベース URL が設定されていない場合、OpenClaw は API キーの種類に基づいて
デフォルトを自動選択します。

- `PERPLEXITY_API_KEY` または `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` または `sk-or-...` → `https://openrouter.ai/api/v1`
- 不明なキー形式 → OpenRouter（安全なフォールバック）

### 利用可能な Perplexity モデル

| モデル                              | 説明                                  | 最適な用途   |
| -------------------------------- | ----------------------------------- | ------- |
| `perplexity/sonar`               | Web 検索付きの高速 Q&A | クイックな調査 |
| `perplexity/sonar-pro`（デフォルト）    | Web 検索付きのマルチステップ推論                  | 複雑な質問   |
| `perplexity/sonar-reasoning-pro` | 思考連鎖分析                              | 詳細な調査   |

## web_search

設定されたプロバイダーを使用して Web を検索します。

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
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
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
- `count`（1–10、デフォルトは設定から取得）
- `country`（任意）: 地域別結果のための 2 文字の国コード（例: 「DE」「US」「ALL」）。省略時は Brave のデフォルト地域が使用されます。 省略された場合、Braveはデフォルトの領域を選択します。
- `search_lang`（任意）: 検索結果の ISO 言語コード（例: 「de」「en」「fr」）
- `ui_lang`（任意）: UI 要素の ISO 言語コード
- `freshness`（任意、Brave のみ）: 発見時刻によるフィルタ（`pd`、`pw`、`pm`、`py`、または `YYYY-MM-DDtoYYYY-MM-DD`）

**例:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

URL を取得し、可読なコンテンツを抽出します。

### web_fetch の要件

- `tools.web.fetch.enabled` が `false` でないこと（デフォルト: 有効）
- 任意の Firecrawl フォールバック: `tools.web.fetch.firecrawl.apiKey` または `FIRECRAWL_API_KEY` を設定します。

### web_fetch の設定

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch ツールパラメーター

- `url`（必須、http / https のみ）
- `extractMode`（`markdown` | `text`）
- `maxChars`（長いページを切り詰めます）

注記:

- `web_fetch` は、まず Readability（メインコンテンツ抽出）を使用し、次に Firecrawl（設定されている場合）を使用します。両方が失敗した場合、ツールはエラーを返します。 両方とも失敗した場合、ツールはエラーを返します。
- Firecrawl のリクエストはボット回避モードを使用し、デフォルトで結果をキャッシュします。
- `web_fetch` は Chrome 風の User-Agent と `Accept-Language` をデフォルトで送信します。必要に応じて `userAgent` を上書きしてください。
- `web_fetch` はプライベート / 内部ホスト名をブロックし、リダイレクトを再チェックします（`maxRedirects` で制限）。
- `maxChars` は `tools.web.fetch.maxCharsCap` にクランプされます。
- `web_fetch` はベストエフォートの抽出です。一部のサイトでは Browser tool が必要になります。
- キーの設定やサービスの詳細については [Firecrawl](/tools/firecrawl) を参照してください。
- レスポンスは（デフォルト 15 分間）キャッシュされ、繰り返しのフェッチを削減します。
- ツールプロファイル / 許可リストを使用している場合は、`web_search`/`web_fetch` または `group:web` を追加してください。
- Brave キーがない場合、`web_search` はドキュメントへのリンク付きの短いセットアップヒントを返します。
