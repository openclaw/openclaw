---
summary: "Zalo ボットのサポート状況、機能、設定"
read_when:
  - Zalo 機能または webhook に取り組んでいるとき
title: "Zalo"
---

# Zalo（Bot API）

状態: 実験的。 ダイレクトメッセージのみ; Zalo のドキュメントごとにすぐに来るグループ.

## プラグインが必要

Zalo はプラグインとして提供されており、コアインストールには同梱されていません。

- CLI からインストール: `openclaw plugins install @openclaw/zalo`
- またはオンボーディング中に **Zalo** を選択し、インストール確認プロンプトを承認
- 詳細: [Plugins](/tools/plugin)

## クイックセットアップ（初心者）

1. Zalo プラグインをインストールします:
   - ソースチェックアウトから: `openclaw plugins install ./extensions/zalo`
   - npm から（公開されている場合）: `openclaw plugins install @openclaw/zalo`
   - またはオンボーディングで **Zalo** を選択し、インストール確認プロンプトを承認
2. トークンを設定します:
   - Env: `ZALO_BOT_TOKEN=...`
   - または設定: `channels.zalo.botToken: "..."`。
3. ゲートウェイを再起動します（またはオンボーディングを完了します）。
4. DM アクセスはデフォルトでペアリングです。初回連絡時にペアリングコードを承認してください。

最小構成:

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

## これは何か

Zalo はベトナム向けのメッセージングアプリで、その Bot API により Gateway（ゲートウェイ）が 1:1 会話用のボットを実行できます。  
Zalo への確定的なルーティングが必要なサポートや通知に適しています。
Zaloへの決定的なルーティングを行いたい場合は、サポートや通知に適しています。

- ゲートウェイが所有する Zalo Bot API チャンネル。
- 確定的なルーティング: 返信は必ず Zalo に戻り、モデルがチャンネルを選択することはありません。
- DM はエージェントのメインセッションを共有します。
- グループは未対応（Zalo ドキュメントでは「近日対応予定」と記載）。

## セットアップ（最短手順）

### 1. ボットトークンを作成（Zalo Bot Platform）

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) にアクセスしてサインインします。
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

環境変数オプション: `ZALO_BOT_TOKEN=...`（デフォルトアカウントのみで動作）。

マルチアカウント対応: アカウントごとのトークンに `channels.zalo.accounts` を使用し、必要に応じて `name` を指定します。

3. ゲートウェイを再起動します。 Zalo はトークンが解決されたとき(envまたはconfig)に開始されます。
4. DMアクセスのデフォルトはペアリングです。 Botが最初に連絡されたときにコードを承認します。

## 動作（挙動）

- 受信メッセージは、メディアプレースホルダーを含む共有チャンネルエンベロープに正規化されます。
- 返信は常に同じ Zalo チャットにルーティングされます。
- 既定ではロングポーリング。`channels.zalo.webhookUrl` により webhook モードも利用できます。

## 制限

- 送信テキストは 2000 文字に分割されます（Zalo API の制限）。
- メディアのダウンロード／アップロードは `channels.zalo.mediaMaxMb` により上限が設定されます（デフォルト 5）。
- 2000 文字制限によりストリーミングの有用性が低いため、既定ではストリーミングはブロックされます。

## アクセス制御（DM）

### DM アクセス

- デフォルト: `channels.zalo.dmPolicy = "pairing"`。未承認の送信者にはペアリングコードが送信され、承認されるまでメッセージは無視されます（コードは 1 時間で失効）。 不明な送信者にはペアリングコードが送信され、承認されるまでメッセージは無視されます（コードは 1 時間で期限切れ）。
- 承認方法:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- ペアリングはデフォルトのトークン交換です。 詳細: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` は数値のユーザー ID を受け付けます（ユーザー名の検索は利用不可）。

## ロングポーリング vs webhook

- デフォルト: ロングポーリング（公開 URL は不要）。
- webhook モード: `channels.zalo.webhookUrl` と `channels.zalo.webhookSecret` を設定します。
  - webhook シークレットは 8～256 文字である必要があります。
  - webhook URL は HTTPS を使用する必要があります。
  - Zalo は検証のために `X-Bot-Api-Secret-Token` ヘッダー付きでイベントを送信します。
  - Gateway HTTP は `channels.zalo.webhookPath` で webhook リクエストを処理します（既定では webhook URL のパス）。

**注記:** Zalo API ドキュメントによると、getUpdates（ポーリング）と webhook は相互に排他的です。

## 対応メッセージタイプ

- **テキストメッセージ**: 2000 文字分割で完全対応。
- **画像メッセージ**: 受信画像のダウンロードと処理、`sendPhoto` による画像送信に対応。
- **スタンプ**: ログには記録されますが、完全には処理されません（エージェントの応答なし）。
- **未対応タイプ**: ログのみ（例: 保護されたユーザーからのメッセージ）。

## 機能

| 機能         | ステータス                    |
| ---------- | ------------------------ |
| ダイレクトメッセージ | ✅ 対応                     |
| グループ       | ❌ 近日対応予定（Zalo ドキュメントによる） |
| メディア（画像）   | ✅ 対応                     |
| Reactions  | ❌ 未対応                    |
| スレッド       | ❌ 未対応                    |
| 投票         | ❌ 未対応                    |
| ネイティブコマンド  | ❌ 未対応                    |
| ストリーミング    | ⚠️ ブロック（2000 文字制限）       |

## 配信ターゲット（CLI/cron）

- ターゲットとして chat id を使用します。
- 例: `openclaw message send --channel zalo --target 123456789 --message "hi"`。

## トラブルシューティング

**ボットが応答しない:**

- トークンが有効であることを確認: `openclaw channels status --probe`
- 送信者が承認されていることを確認（ペアリングまたは allowFrom）
- ゲートウェイのログを確認: `openclaw logs --follow`

**webhook がイベントを受信しない:**

- webhook URL が HTTPS を使用していることを確認
- シークレットトークンが 8～256 文字であることを確認
- 設定されたパスでゲートウェイ HTTP エンドポイントに到達可能であることを確認
- getUpdates のポーリングが実行されていないことを確認（相互に排他的）

## 設定リファレンス（Zalo）

完全な設定: [Configuration](/gateway/configuration)

プロバイダーオプション:

- `channels.zalo.enabled`: チャンネル起動の有効化／無効化。
- `channels.zalo.botToken`: Zalo Bot Platform のボットトークン。
- `channels.zalo.tokenFile`: ファイルパスからトークンを読み取ります。
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: ペアリング）。
- `channels.zalo.allowFrom`: DM の許可リスト（ユーザー ID）。`open` には `"*"` が必要です。ウィザードでは数値 ID を求められます。 `open`には`"*"`が必要です。 ウィザードは数値IDを要求します。
- `channels.zalo.mediaMaxMb`: 受信／送信メディアの上限（MB、デフォルト 5）。
- `channels.zalo.webhookUrl`: webhook モードを有効化（HTTPS 必須）。
- `channels.zalo.webhookSecret`: webhook シークレット（8～256 文字）。
- `channels.zalo.webhookPath`: ゲートウェイ HTTP サーバー上の webhook パス。
- `channels.zalo.proxy`: API リクエスト用のプロキシ URL。

マルチアカウントオプション:

- `channels.zalo.accounts.<id>.botToken`: アカウントごとのトークン。
- `channels.zalo.accounts.<id>.tokenFile`: アカウントごとのトークンファイル。
- `channels.zalo.accounts.<id>.name`: 表示名。
- `channels.zalo.accounts.<id>.enabled`: アカウントの有効化／無効化。
- `channels.zalo.accounts.<id>.dmPolicy`: アカウントごとの DM ポリシー。
- `channels.zalo.accounts.<id>.allowFrom`: アカウントごとの許可リスト。
- `channels.zalo.accounts.<id>.webhookUrl`: アカウントごとの webhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`: アカウントごとの webhook シークレット。
- `channels.zalo.accounts.<id>.webhookPath`: アカウントごとの webhook パス。
- `channels.zalo.accounts.<id>.proxy`: アカウントごとのプロキシ URL。
