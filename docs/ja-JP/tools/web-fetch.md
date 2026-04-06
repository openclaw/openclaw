---
read_when:
    - URLをフェッチして読みやすいコンテンツを抽出したい場合
    - web_fetchまたはFirecrawlフォールバックの設定が必要な場合
    - web_fetchの制限とキャッシュについて理解したい場合
sidebarTitle: Web Fetch
summary: web_fetchツール -- 読みやすいコンテンツ抽出付きHTTPフェッチ
title: Web Fetch
x-i18n:
    generated_at: "2026-04-02T07:57:46Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: cfedb24604d6a8b24683bdbd6f5f0ab0f8aa2225c67fe974d2dc5c66aa914e88
    source_path: tools/web-fetch.md
    workflow: 15
---

# Web Fetch

`web_fetch` ツールはプレーンなHTTP GETを実行し、読みやすいコンテンツ
（HTMLからMarkdownまたはテキスト）を抽出します。JavaScriptは**実行しません**。

JS多用サイトやログイン保護されたページには、代わりに
[Webブラウザ](/tools/browser)を使用してください。

## クイックスタート

`web_fetch` は**デフォルトで有効**です -- 設定は不要です。エージェントは
すぐに呼び出すことができます:

```javascript
await web_fetch({ url: "https://example.com/article" });
```

## ツールパラメーター

| パラメーター  | 型       | 説明                                     |
| ------------- | -------- | ---------------------------------------- |
| `url`         | `string` | フェッチするURL（必須、http/httpsのみ）  |
| `extractMode` | `string` | `"markdown"`（デフォルト）または `"text"` |
| `maxChars`    | `number` | 出力をこの文字数で切り詰める             |

## 動作の仕組み

<Steps>
  <Step title="フェッチ">
    Chrome風のUser-Agentと `Accept-Language` ヘッダーでHTTP GETを送信します。プライベート/内部ホスト名をブロックし、リダイレクトを再チェックします。
  </Step>
  <Step title="抽出">
    HTMLレスポンスに対してReadability（メインコンテンツ抽出）を実行します。
  </Step>
  <Step title="フォールバック（オプション）">
    Readabilityが失敗し、Firecrawlが設定されている場合、ボット回避モードでFirecrawl APIを通じてリトライします。
  </Step>
  <Step title="キャッシュ">
    同じURLへの繰り返しフェッチを減らすため、結果は15分間（設定可能）キャッシュされます。
  </Step>
</Steps>

## 設定

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true, // デフォルト: true
        maxChars: 50000, // 最大出力文字数
        maxCharsCap: 50000, // maxCharsパラメーターのハードキャップ
        maxResponseBytes: 2000000, // 切り詰め前の最大ダウンロードサイズ
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        readability: true, // Readability抽出を使用
        userAgent: "Mozilla/5.0 ...", // User-Agentをオーバーライド
      },
    },
  },
}
```

## Firecrawlフォールバック

Readability抽出が失敗した場合、`web_fetch` はボット回避とより良い抽出のために
[Firecrawl](/tools/firecrawl)にフォールバックできます:

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          enabled: true,
          apiKey: "fc-...", // FIRECRAWL_API_KEYが設定されている場合はオプション
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // キャッシュ期間（1日）
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

`tools.web.fetch.firecrawl.apiKey` はSecretRefオブジェクトをサポートしています。

<Note>
  Firecrawlが有効でSecretRefが未解決かつ `FIRECRAWL_API_KEY` 環境変数のフォールバックもない場合、Gateway ゲートウェイの起動は即座に失敗します。
</Note>

## 制限と安全性

- `maxChars` は `tools.web.fetch.maxCharsCap` でクランプされます
- レスポンスボディはパース前に `maxResponseBytes` で制限されます。超過したレスポンスは警告付きで切り詰められます
- プライベート/内部ホスト名はブロックされます
- リダイレクトはチェックされ、`maxRedirects` で制限されます
- `web_fetch` はベストエフォートです -- 一部のサイトでは[Webブラウザ](/tools/browser)が必要です

## ツールプロファイル

ツールプロファイルまたは許可リストを使用する場合は、`web_fetch` または `group:web` を追加してください:

```json5
{
  tools: {
    allow: ["web_fetch"],
    // または: allow: ["group:web"]  （web_fetchとweb_searchの両方を含む）
  },
}
```

## 関連

- [Web Search](/tools/web) -- 複数のプロバイダーでWeb検索
- [Webブラウザ](/tools/browser) -- JS多用サイト向けのフルブラウザ自動化
- [Firecrawl](/tools/firecrawl) -- Firecrawl検索およびスクレイプツール
