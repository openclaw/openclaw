---
summary: "LINE Messaging APIプラグインのセットアップ、設定、使用方法"
read_when:
  - OpenClawをLINEに接続したいとき
  - LINEのウェブフック + 認証情報の設定が必要なとき
  - LINE固有のメッセージオプションが必要なとき
title: LINE
---

# LINE（プラグイン）

LINEはLINE Messaging API経由でOpenClawに接続します。プラグインはGateway上でウェブフック
レシーバーとして動作し、チャンネルアクセストークン + チャンネルシークレットを使用して
認証を行います。

ステータス: プラグインでサポート。ダイレクトメッセージ、グループチャット、メディア、位置情報、Flex
メッセージ、テンプレートメッセージ、クイックリプライがサポートされています。リアクションとスレッド
はサポートされていません。

## プラグインが必要です

LINEプラグインをインストール:

```bash
openclaw plugins install @openclaw/line
```

ローカルチェックアウト（gitリポジトリから実行する場合）:

```bash
openclaw plugins install ./extensions/line
```

## セットアップ

1. LINE Developersアカウントを作成し、コンソールを開きます:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. プロバイダーを作成（または選択）し、**Messaging API**チャンネルを追加します。
3. チャンネル設定から**チャンネルアクセストークン**と**チャンネルシークレット**をコピーします。
4. Messaging API設定で**Webhookを使用**を有効にします。
5. ウェブフックURLをGatewayのエンドポイントに設定します（HTTPSが必要）:

```
https://gateway-host/line/webhook
```

GatewayはLINEのウェブフック検証（GET）と受信イベント（POST）に応答します。
カスタムパスが必要な場合は、`channels.line.webhookPath`または
`channels.line.accounts.<id>.webhookPath`を設定し、URLを更新してください。

## 設定

最小設定:

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

トークン/シークレットファイル:

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

ダイレクトメッセージはデフォルトでペアリングです。未知の送信者にはペアリングコードが提示され、
承認されるまでメッセージは無視されます。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

許可リストとポリシー:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: DM用の許可されたLINEユーザーID
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: グループ用の許可されたLINEユーザーID
- グループごとのオーバーライド: `channels.line.groups.<groupId>.allowFrom`
- ランタイムの注意: `channels.line`が完全に欠けている場合、ランタイムはグループチェックに対して`groupPolicy="allowlist"`にフォールバックします（`channels.defaults.groupPolicy`が設定されていても）。

LINE IDは大文字小文字を区別します。有効なIDの形式:

- ユーザー: `U` + 32文字の16進数
- グループ: `C` + 32文字の16進数
- ルーム: `R` + 32文字の16進数

## メッセージの動作

- テキストは5000文字で分割されます。
- Markdownフォーマットは除去されます。コードブロックやテーブルは可能な場合Flex
  カードに変換されます。
- ストリーミング応答はバッファリングされます。エージェントが処理中、LINEはローディング
  アニメーション付きの完全なチャンクを受信します。
- メディアダウンロードは`channels.line.mediaMaxMb`（デフォルト10）で制限されます。

## チャンネルデータ（リッチメッセージ）

`channelData.line`を使用して、クイックリプライ、位置情報、Flexカード、テンプレート
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
          /* Flexペイロード */
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

LINEプラグインにはFlexメッセージプリセット用の`/card`コマンドも付属しています:

```
/card info "Welcome" "Thanks for joining!"
```

## トラブルシューティング

- **ウェブフック検証が失敗する:** ウェブフックURLがHTTPSであること、`channelSecret`がLINEコンソールと一致していることを確認してください。
- **受信イベントがない:** ウェブフックパスが`channels.line.webhookPath`と一致し、GatewayがLINEから到達可能であることを確認してください。
- **メディアダウンロードエラー:** メディアがデフォルトの制限を超える場合は`channels.line.mediaMaxMb`を引き上げてください。
