---
read_when:
    - Zaloの機能やWebhookに関する作業をする場合
summary: Zaloボットの対応状況、機能、および設定
title: Zalo
x-i18n:
    generated_at: "2026-04-02T07:32:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 51d0f43dc7b2c5ea67659d6e41210ee86a16e27223cd51abee62efb48aaffddc
    source_path: channels/zalo.md
    workflow: 15
---

# Zalo（Bot API）

ステータス: 実験的。ダイレクトメッセージに対応しています。以下の[機能](#capabilities)セクションは、現在のMarketplaceボットの動作を反映しています。

## プラグインが必要

Zaloはプラグインとして提供されており、コアインストールにはバンドルされていません。

- CLIでインストール: `openclaw plugins install @openclaw/zalo`
- またはセットアップ中に**Zalo**を選択し、インストールプロンプトを確認
- 詳細: [プラグイン](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Zaloプラグインをインストール:
   - ソースチェックアウトから: `openclaw plugins install ./path/to/local/zalo-plugin`
   - npm（公開済みの場合）から: `openclaw plugins install @openclaw/zalo`
   - またはセットアップで**Zalo**を選択し、インストールプロンプトを確認
2. トークンを設定:
   - 環境変数: `ZALO_BOT_TOKEN=...`
   - または設定: `channels.zalo.accounts.default.botToken: "..."`
3. Gateway ゲートウェイを再起動（またはセットアップを完了）。
4. ダイレクトメッセージのアクセスはデフォルトでペアリングです。最初の連絡時にペアリングコードを承認してください。

最小構成:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          botToken: "12345689:abc-xyz",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

## 概要

Zaloはベトナム向けのメッセージングアプリです。Bot APIにより、Gateway ゲートウェイが1対1の会話用ボットを実行できます。
サポートや通知で、Zaloへの確定的なルーティングが必要な場合に適しています。

このページは、**Zalo Bot Creator / Marketplaceボット**に対する現在のOpenClawの動作を反映しています。
**Zalo Official Account（OA）ボット**は異なるZalo製品であり、動作が異なる場合があります。

- Gateway ゲートウェイが所有するZalo Bot APIチャネル。
- 確定的ルーティング: 返信は常にZaloに戻ります。モデルがチャネルを選択することはありません。
- ダイレクトメッセージはエージェントのメインセッションを共有します。
- 以下の[機能](#capabilities)セクションで、現在のMarketplaceボットの対応状況を確認できます。

## セットアップ（高速パス）

### 1) ボットトークンの作成（Zalo Bot Platform）

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) にアクセスしてサインインします。
2. 新しいボットを作成し、設定を行います。
3. ボットトークン全体（通常 `numeric_id:secret`）をコピーします。Marketplaceボットの場合、使用可能なランタイムトークンは作成後のボットのウェルカムメッセージに表示されることがあります。

### 2) トークンの設定（環境変数または設定）

例:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          botToken: "12345689:abc-xyz",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

後でグループが利用可能なZaloボットに移行する場合は、`groupPolicy` や `groupAllowFrom` などのグループ固有の設定を明示的に追加できます。現在のMarketplaceボットの動作については、[機能](#capabilities)を参照してください。

環境変数オプション: `ZALO_BOT_TOKEN=...`（デフォルトアカウントのみ有効）。

マルチアカウントサポート: `channels.zalo.accounts` にアカウントごとのトークンとオプションの `name` を使用します。

3. Gateway ゲートウェイを再起動します。トークンが解決される（環境変数または設定）とZaloが起動します。
4. ダイレクトメッセージのアクセスはデフォルトでペアリングです。ボットに最初に連絡があった際にコードを承認してください。

## 動作の仕組み

- 受信メッセージは、メディアプレースホルダー付きの共有チャネルエンベロープに正規化されます。
- 返信は常に同じZaloチャットにルーティングされます。
- デフォルトはロングポーリングです。`channels.zalo.webhookUrl` を設定するとWebhookモードが利用可能です。

## 制限事項

- 送信テキストは2000文字（Zalo APIの制限）で分割されます。
- メディアのダウンロード/アップロードは `channels.zalo.mediaMaxMb`（デフォルト5）で制限されます。
- 2000文字の制限によりストリーミングの有用性が低いため、ストリーミングはデフォルトでブロックされています。

## アクセス制御（ダイレクトメッセージ）

### ダイレクトメッセージのアクセス

- デフォルト: `channels.zalo.dmPolicy = "pairing"`。不明な送信者にはペアリングコードが送られ、承認されるまでメッセージは無視されます（コードは1時間で期限切れ）。
- 承認方法:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- ペアリングはデフォルトのトークン交換です。詳細: [ペアリング](/channels/pairing)
- `channels.zalo.allowFrom` は数値ユーザーIDを受け付けます（ユーザー名の検索は利用できません）。

## アクセス制御（グループ）

**Zalo Bot Creator / Marketplaceボット**では、ボットをグループに追加できなかったため、実際にはグループサポートは利用できませんでした。

つまり、以下のグループ関連の設定キーはスキーマに存在しますが、Marketplaceボットでは使用できませんでした:

- `channels.zalo.groupPolicy` はグループの受信処理を制御します: `open | allowlist | disabled`。
- `channels.zalo.groupAllowFrom` はグループ内でボットをトリガーできる送信者IDを制限します。
- `groupAllowFrom` が未設定の場合、Zaloは送信者チェックに `allowFrom` をフォールバックとして使用します。
- ランタイムの注意: `channels.zalo` が完全に存在しない場合でも、安全のためランタイムは `groupPolicy="allowlist"` にフォールバックします。

グループポリシーの値（ボットでグループアクセスが利用可能な場合）は以下の通りです:

- `groupPolicy: "disabled"` — すべてのグループメッセージをブロックします。
- `groupPolicy: "open"` — すべてのグループメンバーを許可します（メンションゲート付き）。
- `groupPolicy: "allowlist"` — フェイルクローズのデフォルト。許可された送信者のみ受け付けます。

別のZaloボット製品を使用しており、グループ動作が正常に動作することを確認した場合は、Marketplaceボットのフローと一致すると仮定せず、別途ドキュメント化してください。

## ロングポーリング vs Webhook

- デフォルト: ロングポーリング（パブリックURLは不要）。
- Webhookモード: `channels.zalo.webhookUrl` と `channels.zalo.webhookSecret` を設定します。
  - Webhookシークレットは8〜256文字である必要があります。
  - Webhook URLはHTTPSを使用する必要があります。
  - Zaloは検証用に `X-Bot-Api-Secret-Token` ヘッダー付きでイベントを送信します。
  - Gateway ゲートウェイのHTTPは `channels.zalo.webhookPath`（デフォルトはWebhook URLのパス）でWebhookリクエストを処理します。
  - リクエストは `Content-Type: application/json`（または `+json` メディアタイプ）を使用する必要があります。
  - 重複イベント（`event_name + message_id`）は短いリプレイウィンドウ内で無視されます。
  - バーストトラフィックはパス/ソースごとにレート制限され、HTTP 429が返される場合があります。

**注意:** getUpdates（ポーリング）とWebhookは、Zalo APIドキュメントによると相互排他的です。

## 対応メッセージタイプ

サポート状況の概要は[機能](#capabilities)を参照してください。以下の注記は、動作に追加のコンテキストが必要な箇所について詳細を示しています。

- **テキストメッセージ**: 2000文字の分割による完全サポート。
- **テキスト内のプレーンURL**: 通常のテキスト入力として動作します。
- **リンクプレビュー / リッチリンクカード**: [機能](#capabilities)のMarketplaceボットのステータスを参照してください。返信が安定してトリガーされませんでした。
- **画像メッセージ**: [機能](#capabilities)のMarketplaceボットのステータスを参照してください。受信画像の処理が不安定でした（タイピングインジケーターは表示されるが最終返信なし）。
- **スタンプ**: [機能](#capabilities)のMarketplaceボットのステータスを参照してください。
- **ボイスメモ / 音声ファイル / 動画 / 汎用ファイル添付**: [機能](#capabilities)のMarketplaceボットのステータスを参照してください。
- **未対応タイプ**: ログに記録されます（例: 保護されたユーザーからのメッセージ）。

## 機能

この表は、OpenClawにおける現在の**Zalo Bot Creator / Marketplaceボット**の動作をまとめたものです。

| 機能                         | ステータス                                |
| --------------------------- | --------------------------------------- |
| ダイレクトメッセージ             | ✅ 対応                                  |
| グループ                      | ❌ Marketplaceボットでは利用不可             |
| メディア（受信画像）             | ⚠️ 制限あり / 環境で要確認                  |
| メディア（送信画像）             | ⚠️ Marketplaceボットでは未再テスト           |
| テキスト内のプレーンURL          | ✅ 対応                                  |
| リンクプレビュー                | ⚠️ Marketplaceボットでは不安定              |
| リアクション                   | ❌ 未対応                                 |
| スタンプ                      | ⚠️ Marketplaceボットではエージェント返信なし   |
| ボイスメモ / 音声 / 動画        | ⚠️ Marketplaceボットではエージェント返信なし   |
| ファイル添付                   | ⚠️ Marketplaceボットではエージェント返信なし   |
| スレッド                      | ❌ 未対応                                 |
| 投票                          | ❌ 未対応                                 |
| ネイティブコマンド              | ❌ 未対応                                 |
| ストリーミング                  | ⚠️ ブロック（2000文字制限）                 |

## 配信ターゲット（CLI/cron）

- チャットIDをターゲットとして使用します。
- 例: `openclaw message send --channel zalo --target 123456789 --message "hi"`

## トラブルシューティング

**ボットが応答しない:**

- トークンが有効か確認: `openclaw channels status --probe`
- 送信者が承認済みか確認（ペアリングまたはallowFrom）
- Gateway ゲートウェイのログを確認: `openclaw logs --follow`

**Webhookがイベントを受信しない:**

- Webhook URLがHTTPSを使用しているか確認
- シークレットトークンが8〜256文字であるか確認
- 設定されたパスでGateway ゲートウェイのHTTPエンドポイントに到達可能か確認
- getUpdatesポーリングが実行されていないか確認（相互排他的です）

## 設定リファレンス（Zalo）

完全な設定: [設定](/gateway/configuration)

フラットなトップレベルキー（`channels.zalo.botToken`、`channels.zalo.dmPolicy` など）は、レガシーの単一アカウント省略形です。新しい設定には `channels.zalo.accounts.<id>.*` を推奨します。スキーマに存在するため、両方の形式をここに記載しています。

プロバイダーオプション:

- `channels.zalo.enabled`: チャネルの起動を有効/無効にします。
- `channels.zalo.botToken`: Zalo Bot Platformのボットトークン。
- `channels.zalo.tokenFile`: 通常のファイルパスからトークンを読み取ります。シンボリックリンクは拒否されます。
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.zalo.allowFrom`: ダイレクトメッセージの許可リスト（ユーザーID）。`open` には `"*"` が必要です。ウィザードは数値IDの入力を求めます。
- `channels.zalo.groupPolicy`: `open | allowlist | disabled`（デフォルト: allowlist）。設定に存在します。現在のMarketplaceボットの動作については[機能](#capabilities)および[アクセス制御（グループ）](#access-control-groups)を参照してください。
- `channels.zalo.groupAllowFrom`: グループの送信者許可リスト（ユーザーID）。未設定の場合は `allowFrom` にフォールバックします。
- `channels.zalo.mediaMaxMb`: 受信/送信メディアの上限（MB、デフォルト5）。
- `channels.zalo.webhookUrl`: Webhookモードを有効にします（HTTPS必須）。
- `channels.zalo.webhookSecret`: Webhookシークレット（8〜256文字）。
- `channels.zalo.webhookPath`: Gateway ゲートウェイHTTPサーバー上のWebhookパス。
- `channels.zalo.proxy`: APIリクエスト用のプロキシURL。

マルチアカウントオプション:

- `channels.zalo.accounts.<id>.botToken`: アカウントごとのトークン。
- `channels.zalo.accounts.<id>.tokenFile`: アカウントごとの通常のトークンファイル。シンボリックリンクは拒否されます。
- `channels.zalo.accounts.<id>.name`: 表示名。
- `channels.zalo.accounts.<id>.enabled`: アカウントの有効/無効。
- `channels.zalo.accounts.<id>.dmPolicy`: アカウントごとのダイレクトメッセージポリシー。
- `channels.zalo.accounts.<id>.allowFrom`: アカウントごとの許可リスト。
- `channels.zalo.accounts.<id>.groupPolicy`: アカウントごとのグループポリシー。設定に存在します。現在のMarketplaceボットの動作については[機能](#capabilities)および[アクセス制御（グループ）](#access-control-groups)を参照してください。
- `channels.zalo.accounts.<id>.groupAllowFrom`: アカウントごとのグループ送信者許可リスト。
- `channels.zalo.accounts.<id>.webhookUrl`: アカウントごとのWebhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`: アカウントごとのWebhookシークレット。
- `channels.zalo.accounts.<id>.webhookPath`: アカウントごとのWebhookパス。
- `channels.zalo.accounts.<id>.proxy`: アカウントごとのプロキシURL。

## 関連

- [チャネル概要](/channels) — 対応チャネル一覧
- [ペアリング](/channels/pairing) — ダイレクトメッセージの認証とペアリングフロー
- [グループ](/channels/groups) — グループチャットの動作とメンションゲート
- [チャネルルーティング](/channels/channel-routing) — メッセージのセッションルーティング
- [セキュリティ](/gateway/security) — アクセスモデルとハードニング
