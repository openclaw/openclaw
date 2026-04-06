---
read_when:
    - WhatsApp/webチャネルの動作や受信ルーティングに関する作業時
summary: WhatsAppチャネルのサポート、アクセス制御、配信動作、および運用
title: WhatsApp
x-i18n:
    generated_at: "2026-04-02T07:33:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c16a468b3f47fdf7e4fc3fd745b5c49c7ccebb7af0e8c87c632b78b04c583e49
    source_path: channels/whatsapp.md
    workflow: 15
---

# WhatsApp（Webチャネル）

ステータス: WhatsApp Web（Baileys）経由で本番利用可能。Gateway ゲートウェイがリンク済みセッションを管理。

## インストール（オンデマンド）

- オンボーディング（`openclaw onboard`）および `openclaw channels add --channel whatsapp`
  は、WhatsAppを初めて選択した際にWhatsAppプラグインのインストールを案内します。
- `openclaw channels login --channel whatsapp` も、プラグインが未インストールの場合に
  インストールフローを提示します。
- 開発チャネル + gitチェックアウト: ローカルプラグインパスがデフォルトになります。
- Stable/Beta: npmパッケージ `@openclaw/whatsapp` がデフォルトになります。

手動インストールも利用可能です:

```bash
openclaw plugins install @openclaw/whatsapp
```

<CardGroup cols={3}>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    未知の送信者に対するデフォルトのダイレクトメッセージポリシーはペアリングです。
  </Card>
  <Card title="チャネルのトラブルシューティング" icon="wrench" href="/channels/troubleshooting">
    チャネル横断の診断と修復プレイブック。
  </Card>
  <Card title="Gateway ゲートウェイの設定" icon="settings" href="/gateway/configuration">
    チャネル設定のパターンと例の完全版。
  </Card>
</CardGroup>

## クイックセットアップ

<Steps>
  <Step title="WhatsAppアクセスポリシーの設定">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="WhatsAppのリンク（QR）">

```bash
openclaw channels login --channel whatsapp
```

    特定のアカウントの場合:

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="Gateway ゲートウェイの起動">

```bash
openclaw gateway
```

  </Step>

  <Step title="最初のペアリングリクエストの承認（ペアリングモード使用時）">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    ペアリングリクエストは1時間後に期限切れになります。保留中のリクエストはチャネルあたり最大3件に制限されています。

  </Step>
</Steps>

<Note>
OpenClawでは、可能であればWhatsAppを別の電話番号で運用することを推奨しています。（チャネルのメタデータとセットアップフローはその構成に最適化されていますが、個人番号での構成もサポートされています。）
</Note>

## デプロイパターン

<AccordionGroup>
  <Accordion title="専用番号（推奨）">
    最もクリーンな運用モードです:

    - OpenClaw専用のWhatsApp IDを使用
    - ダイレクトメッセージの許可リストとルーティング境界が明確
    - セルフチャットの混乱が発生しにくい

    最小限のポリシーパターン:

    ```json5
    {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="個人番号のフォールバック">
    オンボーディングは個人番号モードをサポートし、セルフチャット対応のベースラインを書き込みます:

    - `dmPolicy: "allowlist"`
    - `allowFrom` にあなたの個人番号が含まれる
    - `selfChatMode: true`

    ランタイムでは、セルフチャット保護はリンク済みの自己番号と `allowFrom` に基づいて動作します。

  </Accordion>

  <Accordion title="WhatsApp Webのみのチャネルスコープ">
    メッセージングプラットフォームのチャネルは、現在のOpenClawチャネルアーキテクチャにおいてWhatsApp Webベース（`Baileys`）です。

    組み込みチャットチャネルレジストリには、個別のTwilio WhatsAppメッセージングチャネルはありません。

  </Accordion>
</AccordionGroup>

## ランタイムモデル

- Gateway ゲートウェイがWhatsAppソケットと再接続ループを管理します。
- 送信にはターゲットアカウントのアクティブなWhatsAppリスナーが必要です。
- ステータスおよびブロードキャストチャットは無視されます（`@status`、`@broadcast`）。
- ダイレクトチャットはダイレクトメッセージセッションルールを使用します（`session.dmScope`、デフォルトの `main` はダイレクトメッセージをエージェントのメインセッションに統合します）。
- グループセッションは分離されます（`agent:<agentId>:whatsapp:group:<jid>`）。

## アクセス制御と有効化

<Tabs>
  <Tab title="ダイレクトメッセージポリシー">
    `channels.whatsapp.dmPolicy` はダイレクトチャットのアクセスを制御します:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`allowFrom` に `"*"` を含める必要があります）
    - `disabled`

    `allowFrom` はE.164形式の電話番号を受け付けます（内部で正規化されます）。

    マルチアカウントオーバーライド: `channels.whatsapp.accounts.<id>.dmPolicy`（および `allowFrom`）は、そのアカウントに対してチャネルレベルのデフォルトよりも優先されます。

    ランタイムの動作詳細:

    - ペアリングはチャネル許可ストアに永続化され、設定済みの `allowFrom` とマージされます
    - 許可リストが設定されていない場合、リンク済みの自己番号がデフォルトで許可されます
    - 送信側の `fromMe` ダイレクトメッセージは自動ペアリングされません

  </Tab>

  <Tab title="グループポリシー + 許可リスト">
    グループアクセスには2つのレイヤーがあります:

    1. **グループメンバーシップ許可リスト**（`channels.whatsapp.groups`）
       - `groups` が省略された場合、すべてのグループが対象になります
       - `groups` が指定された場合、グループ許可リストとして機能します（`"*"` が使用可能）

    2. **グループ送信者ポリシー**（`channels.whatsapp.groupPolicy` + `groupAllowFrom`）
       - `open`: 送信者許可リストをバイパス
       - `allowlist`: 送信者が `groupAllowFrom`（または `*`）に一致する必要があります
       - `disabled`: すべてのグループ受信をブロック

    送信者許可リストのフォールバック:

    - `groupAllowFrom` が未設定の場合、ランタイムは利用可能な `allowFrom` にフォールバックします
    - 送信者許可リストはメンション/リプライによる有効化より前に評価されます

    注意: `channels.whatsapp` ブロックがまったく存在しない場合、ランタイムのグループポリシーのフォールバックは `allowlist`（警告ログ付き）になります。`channels.defaults.groupPolicy` が設定されている場合でも同様です。

  </Tab>

  <Tab title="メンション + /activation">
    グループ返信はデフォルトでメンションが必要です。

    メンション検出の対象:

    - ボットIDへの明示的なWhatsAppメンション
    - 設定済みのメンション正規表現パターン（`agents.list[].groupChat.mentionPatterns`、フォールバック `messages.groupChat.mentionPatterns`）
    - 暗黙のボットへのリプライ検出（リプライ送信者がボットIDに一致）

    セキュリティに関する注意:

    - 引用/リプライはメンションゲートを満たすだけで、送信者の認可は**付与しません**
    - `groupPolicy: "allowlist"` の場合、許可リストに含まれていない送信者は、許可リストに含まれているユーザーのメッセージにリプライしてもブロックされます

    セッションレベルのactivationコマンド:

    - `/activation mention`
    - `/activation always`

    `activation` はセッション状態を更新します（グローバル設定ではありません）。オーナーゲートされています。

  </Tab>
</Tabs>

## 個人番号とセルフチャットの動作

リンク済みの自己番号が `allowFrom` にも含まれている場合、WhatsAppセルフチャットのセーフガードが有効になります:

- セルフチャットのターンで既読レシートをスキップ
- 自分自身にpingを送信してしまうメンションJID自動トリガー動作を無視
- `messages.responsePrefix` が未設定の場合、セルフチャットの返信はデフォルトで `[{identity.name}]` または `[openclaw]` になります

## メッセージの正規化とコンテキスト

<AccordionGroup>
  <Accordion title="受信エンベロープ + リプライコンテキスト">
    受信WhatsAppメッセージは共有受信エンベロープにラップされます。

    引用リプライが存在する場合、以下の形式でコンテキストが付加されます:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    利用可能な場合、リプライメタデータフィールドも設定されます（`ReplyToId`、`ReplyToBody`、`ReplyToSender`、送信者JID/E.164）。

  </Accordion>

  <Accordion title="メディアプレースホルダーと位置情報/連絡先の抽出">
    メディアのみの受信メッセージは以下のようなプレースホルダーで正規化されます:

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    位置情報と連絡先のペイロードはルーティング前にテキストコンテキストに正規化されます。

  </Accordion>

  <Accordion title="保留中のグループ履歴インジェクション">
    グループでは、未処理のメッセージをバッファリングし、ボットが最終的にトリガーされた時にコンテキストとしてインジェクションできます。

    - デフォルト上限: `50`
    - 設定: `channels.whatsapp.historyLimit`
    - フォールバック: `messages.groupChat.historyLimit`
    - `0` で無効化

    インジェクションマーカー:

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="既読レシート">
    受理された受信WhatsAppメッセージに対して、既読レシートはデフォルトで有効です。

    グローバルに無効化:

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    アカウント単位のオーバーライド:

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    セルフチャットのターンは、グローバルで有効になっていても既読レシートをスキップします。

  </Accordion>
</AccordionGroup>

## 配信、チャンキング、メディア

<AccordionGroup>
  <Accordion title="テキストチャンキング">
    - デフォルトのチャンク上限: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` モードは段落の境界（空行）を優先し、次に長さベースのチャンキングにフォールバックします
  </Accordion>

  <Accordion title="送信メディアの動作">
    - 画像、動画、音声（PTTボイスノート）、ドキュメントのペイロードをサポート
    - `audio/ogg` はボイスノート互換性のために `audio/ogg; codecs=opus` に書き換えられます
    - アニメーションGIF再生は動画送信時に `gifPlayback: true` でサポートされます
    - キャプションは複数メディア返信ペイロード送信時に最初のメディアアイテムに適用されます
    - メディアソースはHTTP(S)、`file://`、またはローカルパスが使用可能です
  </Accordion>

  <Accordion title="メディアサイズ制限とフォールバック動作">
    - 受信メディア保存上限: `channels.whatsapp.mediaMaxMb`（デフォルト `50`）
    - 送信メディア送信上限: `channels.whatsapp.mediaMaxMb`（デフォルト `50`）
    - アカウント単位のオーバーライド: `channels.whatsapp.accounts.<accountId>.mediaMaxMb`
    - 画像は制限に収まるように自動最適化されます（リサイズ/品質スイープ）
    - メディア送信失敗時、最初のアイテムのフォールバックとして応答を無言でドロップする代わりにテキスト警告を送信します
  </Accordion>
</AccordionGroup>

## リアクションレベル

`channels.whatsapp.reactionLevel` は、WhatsAppでエージェントが絵文字リアクションをどの程度使用するかを制御します:

| レベル        | 確認リアクション | エージェント主導のリアクション | 説明                                     |
| ------------- | ---------------- | ------------------------------ | ---------------------------------------- |
| `"off"`       | なし             | なし                           | リアクションなし                         |
| `"ack"`       | あり             | なし                           | 確認リアクションのみ（返信前のレシート） |
| `"minimal"`   | あり             | あり（控えめ）                 | 確認 + 控えめなエージェントリアクション  |
| `"extensive"` | あり             | あり（積極的）                 | 確認 + 積極的なエージェントリアクション  |

デフォルト: `"minimal"`。

アカウント単位のオーバーライド: `channels.whatsapp.accounts.<id>.reactionLevel`。

```json5
{
  channels: {
    whatsapp: {
      reactionLevel: "ack",
    },
  },
}
```

## 確認リアクション

WhatsAppは `channels.whatsapp.ackReaction` を通じて、受信時の即時確認リアクションをサポートします。
確認リアクションは `reactionLevel` によってゲートされ、`reactionLevel` が `"off"` の場合は抑制されます。

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

動作に関する注意:

- 受信が受理された直後に送信されます（返信前）
- 失敗はログに記録されますが、通常の返信配信はブロックしません
- グループモード `mentions` はメンションでトリガーされたターンでリアクションします。グループactivation `always` はこのチェックのバイパスとして機能します
- WhatsAppは `channels.whatsapp.ackReaction` を使用します（レガシーの `messages.ackReaction` はここでは使用されません）

## マルチアカウントと認証情報

<AccordionGroup>
  <Accordion title="アカウントの選択とデフォルト">
    - アカウントIDは `channels.whatsapp.accounts` から取得されます
    - デフォルトのアカウント選択: `default` が存在すればそれを使用、それ以外は最初に設定されたアカウントID（ソート順）
    - アカウントIDはルックアップ時に内部で正規化されます
  </Accordion>

  <Accordion title="認証情報のパスとレガシー互換性">
    - 現在の認証パス: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - バックアップファイル: `creds.json.bak`
    - `~/.openclaw/credentials/` にあるレガシーのデフォルト認証は、デフォルトアカウントフローでも認識/移行されます
  </Accordion>

  <Accordion title="ログアウトの動作">
    `openclaw channels logout --channel whatsapp [--account <id>]` は、そのアカウントのWhatsApp認証状態をクリアします。

    レガシー認証ディレクトリでは、Baileys認証ファイルが削除される一方、`oauth.json` は保持されます。

  </Accordion>
</AccordionGroup>

## ツール、アクション、設定の書き込み

- エージェントのツールサポートにはWhatsAppリアクションアクション（`react`）が含まれます。
- アクションゲート:
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- チャネル起因の設定書き込みはデフォルトで有効です（`channels.whatsapp.configWrites=false` で無効化）。

## トラブルシューティング

<AccordionGroup>
  <Accordion title="未リンク（QRが必要）">
    症状: チャネルステータスがリンクされていないと報告される。

    修正:

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="リンク済みだが切断 / 再接続ループ">
    症状: リンク済みアカウントで繰り返し切断または再接続が試行される。

    修正:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    必要に応じて `channels login` で再リンクしてください。

  </Accordion>

  <Accordion title="送信時にアクティブなリスナーがない">
    ターゲットアカウントに対してアクティブなGateway ゲートウェイリスナーが存在しない場合、送信は即座に失敗します。

    Gateway ゲートウェイが実行中で、アカウントがリンクされていることを確認してください。

  </Accordion>

  <Accordion title="グループメッセージが予期せず無視される">
    以下の順序で確認してください:

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 許可リストのエントリ
    - メンションゲート（`requireMention` + メンションパターン）
    - `openclaw.json`（JSON5）のキー重複: 後のエントリが前のエントリを上書きするため、スコープごとに `groupPolicy` は1つにしてください

  </Accordion>

  <Accordion title="Bunランタイムの警告">
    WhatsApp Gateway ゲートウェイのランタイムはNodeを使用してください。BunはWhatsApp/Telegram Gateway ゲートウェイの安定運用には非互換としてフラグ付けされています。
  </Accordion>
</AccordionGroup>

## 設定リファレンスへのポインター

主要リファレンス:

- [設定リファレンス - WhatsApp](/gateway/configuration-reference#whatsapp)

重要なWhatsAppフィールド:

- アクセス: `dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`
- 配信: `textChunkLimit`、`chunkMode`、`mediaMaxMb`、`sendReadReceipts`、`ackReaction`、`reactionLevel`
- マルチアカウント: `accounts.<id>.enabled`、`accounts.<id>.authDir`、アカウントレベルのオーバーライド
- 運用: `configWrites`、`debounceMs`、`web.enabled`、`web.heartbeatSeconds`、`web.reconnect.*`
- セッション動作: `session.dmScope`、`historyLimit`、`dmHistoryLimit`、`dms.<id>.historyLimit`

## 関連項目

- [ペアリング](/channels/pairing)
- [グループ](/channels/groups)
- [セキュリティ](/gateway/security)
- [チャネルルーティング](/channels/channel-routing)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [トラブルシューティング](/channels/troubleshooting)
