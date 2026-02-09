---
summary: "LINE Messaging API プラグインのセットアップ、設定、使用方法"
read_when:
  - OpenClaw を LINE に接続したい場合
  - LINE の webhook と認証情報のセットアップが必要な場合
  - LINE 固有のメッセージオプションを使用したい場合
title: LINE
---

# LINE（プラグイン）

LINE は LINE Messaging API を介して OpenClaw に接続します。本プラグインはゲートウェイ上で webhook
レシーバーとして動作し、認証にはチャンネルアクセストークンとチャンネルシークレットを使用します。 プラグインはゲートウェイでWebhook
受信者として動作し、
認証のためにチャンネルアクセストークン+チャンネルシークレットを使用します。

ステータス: プラグイン経由でサポートされています。 ダイレクトメッセージ、グループチャット、メディア、ロケーション、Flex
メッセージ、テンプレートメッセージ、およびクイック返信に対応しています。 リアクションとスレッド
はサポートされていません。

## プラグインが必要

LINE プラグインをインストールします。

```bash
openclaw plugins install @openclaw/line
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/line
```

## セットアップ

1. LINE Developers アカウントを作成し、コンソールを開きます:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. プロバイダーを作成（または選択）し、**Messaging API** チャンネルを追加します。
3. チャンネル設定から **Channel access token** と **Channel secret** をコピーします。
4. Messaging API の設定で **Use webhook** を有効にします。
5. webhook URL をゲートウェイのエンドポイントに設定します（HTTPS が必須）:

```
https://gateway-host/line/webhook
```

ゲートウェイは LINE の webhook 検証（GET）および受信イベント（POST）に応答します。
カスタムパスが必要な場合は `channels.line.webhookPath` または
`channels.line.accounts.<id>
カスタムパスが必要な場合は、`channels.line.webhookPath`または`channels.line.accounts.<id> を設定してください。.webhookPath\` を設定し、それに合わせて URL を更新してください。

## 設定

最小構成:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

環境変数（デフォルトアカウントのみ）:

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

トークン／シークレットのファイル:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

複数アカウント:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## アクセス制御

ダイレクトメッセージはデフォルトでペアリングします。 不明な送信者はペアリングコードを取得し、承認されるまで
メッセージは無視されます。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

許可リストとポリシー:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: ダイレクトメッセージ用に許可された LINE ユーザー ID
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: グループ用に許可された LINE ユーザー ID
- グループごとの上書き: `channels.line.groups.<groupId>.allowFrom`

LINE ID は大文字と小文字を区別します。有効な ID は次の形式です。 有効な ID は以下のようになります:

- ユーザー: `U` + 32 桁の 16 進数
- グループ: `C` + 32 桁の 16 進数
- ルーム: `R` + 32 桁の 16 進数

## メッセージの挙動

- テキストは 5000 文字で分割されます。
- Markdown の書式は除去されます。コードブロックと表は可能な場合に Flex
  カードへ変換されます。
- ストリーミング応答はバッファリングされます。エージェントが処理中の間、LINE にはローディング
  アニメーション付きで完全なチャンクが送信されます。
- メディアのダウンロード数は `channels.line.mediaMaxMb`（既定値 10）で制限されます。

## チャンネルデータ（リッチメッセージ）

`channelData.line` を使用して、クイックリプライ、位置情報、Flex カード、またはテンプレート
メッセージを送信します。

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE プラグインには、Flex メッセージのプリセット用の `/card` コマンドも同梱されています。

```
/card info "Welcome" "Thanks for joining!"
```

## トラブルシューティング

- **Webhook の検証に失敗する:** webhook URL が HTTPS であること、および
  `channelSecret` が LINE コンソールと一致していることを確認してください。
- **受信イベントがない:** webhook のパスが `channels.line.webhookPath` と一致していること、
  そしてゲートウェイが LINE から到達可能であることを確認してください。
- **メディアのダウンロードエラー:** メディアが既定の制限を超える場合は
  `channels.line.mediaMaxMb` を引き上げてください。
