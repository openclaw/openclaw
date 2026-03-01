---
summary: "Zaloボットのサポート状況、機能、設定"
read_when:
  - Zaloの機能やウェブフックを作業するとき
title: "Zalo"
---

# Zalo（Bot API）

ステータス: 実験的。DMがサポートされています。グループ処理は明示的なグループポリシー制御で利用可能です。

## プラグインが必要です

Zaloはプラグインとして提供されており、コアインストールにはバンドルされていません。

- CLI経由でインストール: `openclaw plugins install @openclaw/zalo`
- またはオンボーディング中に**Zalo**を選択し、インストールプロンプトを確認
- 詳細: [プラグイン](/tools/plugin)

## クイックセットアップ（初心者向け）

1. Zaloプラグインをインストールします:
   - ソースチェックアウトから: `openclaw plugins install ./extensions/zalo`
   - npm（公開されている場合）から: `openclaw plugins install @openclaw/zalo`
   - またはオンボーディングで**Zalo**を選択し、インストールプロンプトを確認
2. トークンを設定します:
   - 環境変数: `ZALO_BOT_TOKEN=...`
   - または設定: `channels.zalo.botToken: "..."`
3. Gatewayを再起動します（またはオンボーディングを完了します）。
4. DMアクセスはデフォルトでペアリングです。最初の連絡時にペアリングコードを承認してください。

最小設定:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## 概要

Zaloはベトナム向けのメッセージングアプリです。Bot APIを使用すると、Gatewayで1対1の会話用ボットを実行できます。
サポートや通知など、Zaloへの決定論的ルーティングが必要なユースケースに適しています。

- Gatewayが管理するZalo Bot APIチャンネルです。
- 決定論的ルーティング: 返信はZaloに戻ります。モデルはチャンネルを選択しません。
- DMはエージェントのメインセッションを共有します。
- グループはポリシー制御（`groupPolicy` + `groupAllowFrom`）でサポートされ、デフォルトではフェイルクローズドの許可リスト動作です。

## セットアップ（ファストパス）

### 1) ボットトークンを作成（Zalo Bot Platform）

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com)にアクセスしてサインインします。
2. 新しいボットを作成し、設定を構成します。
3. ボットトークンをコピーします（形式: `12345689:abc-xyz`）。

### 2) トークンを設定（環境変数または設定）

例:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

環境変数オプション: `ZALO_BOT_TOKEN=...`（デフォルトアカウントのみ有効）。

マルチアカウントサポート: `channels.zalo.accounts`でアカウントごとのトークンとオプションの`name`を使用します。

3. Gatewayを再起動します。トークンが解決される（環境変数または設定）とZaloが起動します。
4. DMアクセスはデフォルトでペアリングです。ボットに最初に連絡された時にコードを承認してください。

## 動作の仕組み

- 受信メッセージはメディアプレースホルダー付きの共有チャンネルエンベロープに正規化されます。
- 返信は常に同じZaloチャットにルーティングされます。
- デフォルトではロングポーリング。`channels.zalo.webhookUrl`でウェブフックモードが利用可能です。

## 制限事項

- 送信テキストは2000文字で分割されます（Zalo API制限）。
- メディアのダウンロード/アップロードは`channels.zalo.mediaMaxMb`（デフォルト5）で制限されます。
- 2000文字制限によりストリーミングの有用性が低いため、ストリーミングはデフォルトでブロックされています。

## アクセス制御（DM）

### DMアクセス

- デフォルト: `channels.zalo.dmPolicy = "pairing"`。未知の送信者にはペアリングコードが送信されます。承認されるまでメッセージは無視されます（コードは1時間後に期限切れ）。
- 承認方法:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- ペアリングはデフォルトのトークン交換です。詳細: [ペアリング](/channels/pairing)
- `channels.zalo.allowFrom`は数値のユーザーIDを受け入れます（ユーザー名ルックアップは利用不可）。

## アクセス制御（グループ）

- `channels.zalo.groupPolicy`はグループの受信処理を制御します: `open | allowlist | disabled`。
- デフォルトの動作はフェイルクローズド: `allowlist`。
- `channels.zalo.groupAllowFrom`は、グループでボットをトリガーできる送信者IDを制限します。
- `groupAllowFrom`が未設定の場合、Zaloは送信者チェックに`allowFrom`にフォールバックします。
- `groupPolicy: "disabled"`はすべてのグループメッセージをブロックします。
- `groupPolicy: "open"`はどのグループメンバーも許可します（メンションゲーティング）。
- ランタイムの注意: `channels.zalo`が完全に欠けている場合、安全のためランタイムは`groupPolicy="allowlist"`にフォールバックします。

## ロングポーリング vs ウェブフック

- デフォルト: ロングポーリング（パブリックURL不要）。
- ウェブフックモード: `channels.zalo.webhookUrl`と`channels.zalo.webhookSecret`を設定します。
  - ウェブフックシークレットは8〜256文字である必要があります。
  - ウェブフックURLはHTTPSを使用する必要があります。
  - Zaloは検証用に`X-Bot-Api-Secret-Token`ヘッダー付きでイベントを送信します。
  - Gateway HTTPは`channels.zalo.webhookPath`でウェブフックリクエストを処理します（デフォルトはウェブフックURLのパス）。
  - リクエストは`Content-Type: application/json`（または`+json`メディアタイプ）を使用する必要があります。
  - 重複イベント（`event_name + message_id`）は短いリプレイウィンドウで無視されます。
  - バーストトラフィックはパス/ソースごとにレート制限され、HTTP 429を返すことがあります。

**注意:** getUpdates（ポーリング）とウェブフックは、Zalo APIドキュメントにより相互に排他的です。

## サポートされるメッセージタイプ

- **テキストメッセージ**: 2000文字の分割付きで完全サポート。
- **画像メッセージ**: 受信画像のダウンロードと処理。`sendPhoto`で画像を送信。
- **スタンプ**: ログに記録されますが、完全には処理されません（エージェントの応答なし）。
- **サポートされていないタイプ**: ログに記録されます（例: 保護されたユーザーからのメッセージ）。

## 機能

| 機能           | ステータス                                          |
| --------------- | -------------------------------------------------- |
| ダイレクトメッセージ | サポート済み                                       |
| グループ       | ポリシー制御付きでサポート（デフォルトは許可リスト） |
| メディア（画像） | サポート済み                                       |
| リアクション   | 未サポート                                         |
| スレッド       | 未サポート                                         |
| 投票           | 未サポート                                         |
| ネイティブコマンド | 未サポート                                       |
| ストリーミング | ブロック（2000文字制限）                            |

## 配信ターゲット（CLI/cron）

- チャットIDをターゲットとして使用します。
- 例: `openclaw message send --channel zalo --target 123456789 --message "hi"`

## トラブルシューティング

**ボットが応答しない:**

- トークンが有効であることを確認: `openclaw channels status --probe`
- 送信者が承認されていることを確認（ペアリングまたはallowFrom）
- Gatewayログを確認: `openclaw logs --follow`

**ウェブフックがイベントを受信しない:**

- ウェブフックURLがHTTPSを使用していることを確認
- シークレットトークンが8〜256文字であることを確認
- Gateway HTTPエンドポイントが設定されたパスで到達可能であることを確認
- getUpdatesポーリングが実行されていないことを確認（相互に排他的です）

## 設定リファレンス（Zalo）

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.zalo.enabled`: チャンネル起動の有効/無効。
- `channels.zalo.botToken`: Zalo Bot Platformからのボットトークン。
- `channels.zalo.tokenFile`: ファイルパスからトークンを読み取り。
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: pairing）。
- `channels.zalo.allowFrom`: DM許可リスト（ユーザーID）。`open`には`"*"`が必要。ウィザードは数値IDを要求します。
- `channels.zalo.groupPolicy`: `open | allowlist | disabled`（デフォルト: allowlist）。
- `channels.zalo.groupAllowFrom`: グループ送信者許可リスト（ユーザーID）。未設定時は`allowFrom`にフォールバック。
- `channels.zalo.mediaMaxMb`: 受信/送信メディア上限（MB、デフォルト5）。
- `channels.zalo.webhookUrl`: ウェブフックモードを有効化（HTTPS必須）。
- `channels.zalo.webhookSecret`: ウェブフックシークレット（8〜256文字）。
- `channels.zalo.webhookPath`: Gateway HTTPサーバー上のウェブフックパス。
- `channels.zalo.proxy`: APIリクエスト用プロキシURL。

マルチアカウントオプション:

- `channels.zalo.accounts.<id>.botToken`: アカウントごとのトークン。
- `channels.zalo.accounts.<id>.tokenFile`: アカウントごとのトークンファイル。
- `channels.zalo.accounts.<id>.name`: 表示名。
- `channels.zalo.accounts.<id>.enabled`: アカウントの有効/無効。
- `channels.zalo.accounts.<id>.dmPolicy`: アカウントごとのDMポリシー。
- `channels.zalo.accounts.<id>.allowFrom`: アカウントごとの許可リスト。
- `channels.zalo.accounts.<id>.groupPolicy`: アカウントごとのグループポリシー。
- `channels.zalo.accounts.<id>.groupAllowFrom`: アカウントごとのグループ送信者許可リスト。
- `channels.zalo.accounts.<id>.webhookUrl`: アカウントごとのウェブフックURL。
- `channels.zalo.accounts.<id>.webhookSecret`: アカウントごとのウェブフックシークレット。
- `channels.zalo.accounts.<id>.webhookPath`: アカウントごとのウェブフックパス。
- `channels.zalo.accounts.<id>.proxy`: アカウントごとのプロキシURL。
