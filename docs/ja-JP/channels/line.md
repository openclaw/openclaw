---
summary: "LINE Messaging API プラグインのセットアップ、設定、および使用方法"
read_when:
  - OpenClaw を LINE に接続したい場合
  - LINE Webhook と認証情報のセットアップが必要な場合
  - LINE 固有のメッセージオプションが必要な場合
title: LINE
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 562395baa81d7f4570ad22010ca00953b562483a8fab5758cd187760dee9c61a
    source_path: channels/line.md
    workflow: 15
---

# LINE（プラグイン）

LINE は LINE Messaging API を介して OpenClaw に接続します。プラグインは Gateway ゲートウェイ上で Webhook レシーバーとして動作し、チャンネルアクセストークンとチャンネルシークレットで認証します。

ステータス: プラグイン経由でサポートされています。ダイレクトメッセージ、グループチャット、メディア、位置情報、Flex メッセージ、テンプレートメッセージ、クイック返信がサポートされています。リアクションとスレッドはサポートされていません。

## プラグインが必要

LINE プラグインをインストール:

```bash
openclaw plugins install @openclaw/line
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./path/to/local/line-plugin
```

## セットアップ

1. LINE Developers アカウントを作成してコンソールを開きます:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. プロバイダーを作成（または選択）し、**Messaging API** チャンネルを追加します。
3. チャンネル設定から**チャンネルアクセストークン**と**チャンネルシークレット**をコピーします。
4. Messaging API 設定で **Webhook の利用**を有効にします。
5. Webhook URL を Gateway ゲートウェイエンドポイントに設定します（HTTPS 必須）:

```
https://gateway-host/line/webhook
```

Gateway ゲートウェイは LINE の Webhook 検証（GET）とインバウンドイベント（POST）に応答します。
カスタムパスが必要な場合は、`channels.line.webhookPath` または
`channels.line.accounts.<id>.webhookPath` を設定して URL を更新してください。

セキュリティに関する注意:

- LINE の署名検証はボディに依存しています（生ボディ上の HMAC）。そのため OpenClaw は検証前に厳格なプリオース ボディ制限とタイムアウトを適用します。
- OpenClaw は検証済みの生リクエストバイトから Webhook イベントを処理します。アップストリームのミドルウェアで変換された `req.body` の値は署名整合性の安全のために無視されます。

## 設定

最小限の設定:

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

`tokenFile` と `secretFile` は通常ファイルを指す必要があります。シンボリックリンクは拒否されます。

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

ダイレクトメッセージはデフォルトでペアリングになります。未知の送信者にはペアリングコードが届き、
承認されるまでメッセージは無視されます。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

許可リストとポリシー:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: DM の許可リストに登録された LINE ユーザー ID
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: グループの許可リストに登録された LINE ユーザー ID
- グループごとの上書き: `channels.line.groups.<groupId>.allowFrom`
- ランタイムノート: `channels.line` が完全に欠落している場合、ランタイムはグループチェックで `groupPolicy="allowlist"` にフォールバックします（`channels.defaults.groupPolicy` が設定されていても）。

LINE ID は大文字小文字を区別します。有効な ID の形式:

- ユーザー: `U` + 32 文字の16進数
- グループ: `C` + 32 文字の16進数
- ルーム: `R` + 32 文字の16進数

## メッセージの動作

- テキストは 5000 文字でチャンク分割されます。
- Markdown フォーマットは削除されます。コードブロックとテーブルは可能な場合 Flex カードに変換されます。
- ストリーミング応答はバッファリングされます。エージェントが処理中、LINE はローディングアニメーション付きで完全なチャンクを受け取ります。
- メディアのダウンロードは `channels.line.mediaMaxMb` でキャップされます（デフォルト 10）。

## チャンネルデータ（リッチメッセージ）

`channelData.line` を使用してクイック返信、位置情報、Flex カード、またはテンプレートメッセージを送信します。

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

LINE プラグインには Flex メッセージプリセット用の `/card` コマンドも搭載されています:

```
/card info "Welcome" "Thanks for joining!"
```

## ACP サポート

LINE は ACP（Agent Communication Protocol）会話バインディングをサポートします:

- `/acp spawn <agent> --bind here` は子スレッドを作成せずに現在の LINE チャットを ACP セッションにバインドします。
- 設定された ACP バインディングとアクティブな会話バインド ACP セッションは、他の会話チャンネルと同様に LINE 上で動作します。

詳細については [ACP agents](/tools/acp-agents) を参照してください。

## アウトバウンドメディア

LINE プラグインはエージェントのメッセージツールを通じて画像、動画、音声ファイルの送信をサポートします。メディアは LINE 固有の配信パスを通じて適切なプレビューと追跡処理で送信されます:

- **画像**: 自動プレビュー生成付きの LINE 画像メッセージとして送信されます。
- **動画**: 明示的なプレビューとコンテンツタイプ処理付きで送信されます。
- **音声**: LINE 音声メッセージとして送信されます。

LINE 固有のパスが利用できない場合、汎用メディア送信は既存の画像専用ルートにフォールバックします。

## トラブルシューティング

- **Webhook 検証が失敗する**: Webhook URL が HTTPS であり、`channelSecret` が LINE コンソールと一致することを確認してください。
- **インバウンドイベントがない**: Webhook パスが `channels.line.webhookPath` と一致し、Gateway ゲートウェイが LINE からアクセス可能であることを確認してください。
- **メディアダウンロードエラー**: メディアがデフォルトの制限を超える場合は `channels.line.mediaMaxMb` を増やしてください。

## 関連項目

- [Channels Overview](/channels) — サポートされているすべてのチャンネル
- [Pairing](/channels/pairing) — DM 認証とペアリングフロー
- [Groups](/channels/groups) — グループチャットの動作とメンションゲート
- [Channel Routing](/channels/channel-routing) — メッセージのセッションルーティング
- [Security](/gateway/security) — アクセスモデルとハードニング
