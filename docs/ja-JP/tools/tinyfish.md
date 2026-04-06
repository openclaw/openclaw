---
read_when:
    - OpenClawからホスト型ブラウザ自動化を利用したい場合
    - TinyFishプラグインの設定または開発を行う場合
summary: 'TinyFishプラグイン: 公開マルチステップワークフロー向けのホスト型ブラウザ自動化'
title: TinyFish
x-i18n:
    generated_at: "2026-04-02T07:57:24Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 78d9ad16c20fd04e3d8b2b61bc2ca060141aaddb0111811d3e6db7c1d8a6fb17
    source_path: tools/tinyfish.md
    workflow: 15
---

# TinyFish

TinyFishは、複雑な公開Webワークフロー向けのホスト型ブラウザ自動化ツールをOpenClawに追加します。マルチステップナビゲーション、フォーム、JS多用ページ、地域対応プロキシルーティング、構造化データ抽出に対応します。

簡単なメンタルモデル:

- バンドルされたプラグインを有効にする
- `plugins.entries.tinyfish.config` を設定する
- 公開ブラウザワークフローには `tinyfish_automation` ツールを使用する
- TinyFishが提供する場合、`run_id`、`status`、`result`、およびライブの `streaming_url` が返される

## 実行場所

TinyFishプラグインはGateway ゲートウェイプロセス内で実行されますが、トリガーされるブラウザ自動化はTinyFishのホストインフラストラクチャ上で実行されます。

リモートのGateway ゲートウェイを使用している場合は、Gateway ゲートウェイを実行しているマシンでプラグインを有効にして設定してください。

## 有効化

TinyFishはバンドルされたプラグインとして同梱されており、デフォルトでは無効です。

```json5
{
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
      },
    },
  },
}
```

有効化後にGateway ゲートウェイを再起動してください。

## 設定

`plugins.entries.tinyfish.config` で設定を行います:

```json5
{
  plugins: {
    entries: {
      tinyfish: {
        enabled: true,
        config: {
          apiKey: "tf_live_...",
          // オプション。デフォルトは https://agent.tinyfish.ai
          baseUrl: "https://agent.tinyfish.ai",
        },
      },
    },
  },
}
```

APIキーは `TINYFISH_API_KEY` 環境変数でも指定できます。

## ツール

このプラグインは1つのツールを登録します:

### tinyfish_automation

公開Webサイトに対してホスト型ブラウザ自動化を実行します。

| パラメーター      | 必須     | 説明                                                              |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `url`             | はい     | ターゲットの公開WebサイトURL                                      |
| `goal`            | はい     | 達成したいことの自然言語による説明                                |
| `browser_profile` | いいえ   | `lite`（デフォルト）または `stealth`（アンチボットモード）        |
| `proxy_config`    | いいえ   | `enabled`（ブール値）と `country_code`（2文字のISO）を持つオブジェクト |

レスポンスの形式:

| フィールド      | 説明                                                  |
| --------------- | ----------------------------------------------------- |
| `run_id`        | TinyFish実行識別子                                    |
| `status`        | `COMPLETED`、`FAILED`、またはその他の終端ステータス   |
| `result`        | 構造化データ抽出結果（成功時）                        |
| `error`         | エラー詳細（失敗時）                                  |
| `streaming_url` | ライブブラウザセッションURL（TinyFishが提供する場合） |
| `help_url`      | 関連するTinyFishドキュメントへのリンク（エラー時）    |
| `help_message`  | 人間が読めるヘルプヒント（エラー時）                  |

## 適したユースケース

組み込みブラウザが最適でない場合にTinyFishを使用してください:

- 複数ステップの複雑な公開フォーム
- 実際のブラウザレンダリングが必要なJS多用ページ
- 多くのクリックとナビゲーションを伴うマルチステップワークフロー
- プロキシルーティングが有効な地域依存のブラウジング
- ライブブラウザセッションからの構造化データ抽出

以下の場合は他のツールを使用してください:

- シンプルなHTTPフェッチや検索で十分な場合（`web_fetch`、`web_search`）
- 組み込みの[Browser](/tools/browser)でローカルまたはリモートのCDP制御を直接行いたい場合
- 永続的な認証済みブラウザセッションが必要な場合

## 制限事項

- TinyFishは公開Webワークフローを対象としており、永続的な認証済みセッションは対象外です
- CAPTCHA解決はサポートされていません
- ブラウザセッションの状態は実行をまたいで保持されません
- バッチおよび並列実行は初期バンドルプラグインの対象外です

## プロンプトの例

- 「example.com/pricingを開いて、すべてのプラン名と価格をJSONとして抽出してください。」
- 「example.com/contactにアクセスして、公開お問い合わせフォームに記入し、何が起きたかを要約してください。」
- 「example.com/searchにアクセスして、地域をカナダに切り替えて、上位5件の公開リスティングを抽出してください。」
