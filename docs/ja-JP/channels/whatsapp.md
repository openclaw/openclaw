---
summary: "WhatsAppチャンネルのサポート、アクセス制御、配信動作、運用"
read_when:
  - WhatsApp/Webチャンネルの動作や受信ルーティングを作業するとき
title: "WhatsApp"
---

# WhatsApp（Webチャンネル）

ステータス: WhatsApp Web（Baileys）経由でプロダクションレディ。Gatewayがリンクされたセッションを管理します。

<CardGroup cols={3}>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    未知の送信者に対するデフォルトのDMポリシーはペアリングです。
  </Card>
  <Card title="チャンネルトラブルシューティング" icon="wrench" href="/channels/troubleshooting">
    クロスチャンネルの診断と修復プレイブック。
  </Card>
  <Card title="Gateway設定" icon="settings" href="/gateway/configuration">
    完全なチャンネル設定パターンと例。
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

  <Step title="WhatsAppをリンク（QR）">

```bash
openclaw channels login --channel whatsapp
```

    特定のアカウントの場合:

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="Gatewayを起動">

```bash
openclaw gateway
```

  </Step>

  <Step title="最初のペアリングリクエストを承認（ペアリングモード使用時）">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    ペアリングリクエストは1時間後に期限切れになります。保留中のリクエストはチャンネルごとに3件が上限です。

  </Step>
</Steps>

<Note>
OpenClawは可能であればWhatsAppを別の番号で実行することを推奨します。（チャンネルメタデータとオンボーディングフローはそのセットアップに最適化されていますが、個人番号のセットアップもサポートされています。）
</Note>

## デプロイメントパターン

<AccordionGroup>
  <Accordion title="専用番号（推奨）">
    最もクリーンな運用モードです:

    - OpenClaw用の別のWhatsApp ID
    - より明確なDM許可リストとルーティング境界
    - セルフチャットの混乱が少ない

    最小ポリシーパターン:

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

  <Accordion title="個人番号フォールバック">
    オンボーディングは個人番号モードをサポートし、セルフチャットに対応したベースラインを書き込みます:

    - `dmPolicy: "allowlist"`
    - `allowFrom`に個人番号を含む
    - `selfChatMode: true`

    ランタイムでは、セルフチャット保護はリンクされた自己番号と`allowFrom`をキーにします。

  </Accordion>

  <Accordion title="WhatsApp Web専用チャンネルスコープ">
    メッセージングプラットフォームチャンネルは、現在のOpenClawチャンネルアーキテクチャでWhatsApp Webベース（`Baileys`）です。

    ビルトインのチャットチャンネルレジストリに別のTwilio WhatsAppメッセージングチャンネルはありません。

  </Accordion>
</AccordionGroup>

## ランタイムモデル

- GatewayはWhatsAppソケットと再接続ループを管理します。
- 送信にはターゲットアカウントのアクティブなWhatsAppリスナーが必要です。
- ステータスとブロードキャストチャット（`@status`、`@broadcast`）は無視されます。
- ダイレクトチャットはDMセッションルールを使用します（`session.dmScope`。デフォルトの`main`はDMをエージェントメインセッションに統合）。
- グループセッションは分離されます（`agent:<agentId>:whatsapp:group:<jid>`）。

## アクセス制御とアクティベーション

<Tabs>
  <Tab title="DMポリシー">
    `channels.whatsapp.dmPolicy`はダイレクトチャットアクセスを制御します:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`allowFrom`に`"*"`が必要）
    - `disabled`

    `allowFrom`はE.164形式の番号を受け入れます（内部で正規化されます）。

    マルチアカウントオーバーライド: `channels.whatsapp.accounts.<id>.dmPolicy`（および`allowFrom`）はそのアカウントのチャンネルレベルのデフォルトよりも優先されます。

    ランタイム動作の詳細:

    - ペアリングはチャンネル許可ストアに永続化され、設定された`allowFrom`とマージされます
    - 許可リストが設定されていない場合、リンクされた自己番号がデフォルトで許可されます
    - 送信`fromMe` DMは自動ペアリングされません

  </Tab>

  <Tab title="グループポリシー + 許可リスト">
    グループアクセスには2つのレイヤーがあります:

    1. **グループメンバーシップ許可リスト**（`channels.whatsapp.groups`）
       - `groups`が省略されている場合、すべてのグループが対象
       - `groups`が存在する場合、グループ許可リストとして機能（`"*"`許可）

    2. **グループ送信者ポリシー**（`channels.whatsapp.groupPolicy` + `groupAllowFrom`）
       - `open`: 送信者許可リストをバイパス
       - `allowlist`: 送信者は`groupAllowFrom`（または`*`）に一致する必要あり
       - `disabled`: すべてのグループ受信をブロック

    送信者許可リストのフォールバック:

    - `groupAllowFrom`が未設定の場合、ランタイムは利用可能な`allowFrom`にフォールバック
    - 送信者許可リストはメンション/返信アクティベーションの前に評価されます

    注意: `channels.whatsapp`ブロックがまったく存在しない場合、ランタイムのグループポリシーフォールバックは`allowlist`（警告ログ付き）です。`channels.defaults.groupPolicy`が設定されていても同様です。

  </Tab>

  <Tab title="メンション + /activation">
    グループ返信にはデフォルトでメンションが必要です。

    メンション検出に含まれるもの:

    - ボットIDの明示的なWhatsAppメンション
    - 設定されたメンション正規表現パターン（`agents.list[].groupChat.mentionPatterns`、フォールバック`messages.groupChat.mentionPatterns`）
    - 暗黙的なボットへの返信検出（返信送信者がボットIDに一致）

    セキュリティノート:

    - 引用/返信はメンションゲーティングのみを満たします。送信者認可は**付与しません**
    - `groupPolicy: "allowlist"`では、許可リストにない送信者は、許可リストユーザーのメッセージに返信しても引き続きブロックされます

    セッションレベルのアクティベーションコマンド:

    - `/activation mention`
    - `/activation always`

    `activation`はセッション状態を更新します（グローバル設定ではありません）。オーナーゲートです。

  </Tab>
</Tabs>

## 個人番号とセルフチャットの動作

リンクされた自己番号が`allowFrom`にも存在する場合、WhatsAppセルフチャットのセーフガードが有効になります:

- セルフチャットターンの既読レシートをスキップ
- 自分自身にpingするメンションJID自動トリガー動作を無視
- `messages.responsePrefix`が未設定の場合、セルフチャット返信はデフォルトで`[{identity.name}]`または`[openclaw]`

## メッセージの正規化とコンテキスト

<AccordionGroup>
  <Accordion title="受信エンベロープ + 返信コンテキスト">
    受信WhatsAppメッセージは共有受信エンベロープにラップされます。

    引用返信が存在する場合、以下の形式でコンテキストが追加されます:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <引用本文またはメディアプレースホルダー>
    [/Replying]
    ```

    返信メタデータフィールドは利用可能な場合に設定されます（`ReplyToId`、`ReplyToBody`、`ReplyToSender`、送信者JID/E.164）。

  </Accordion>

  <Accordion title="メディアプレースホルダーとロケーション/連絡先の抽出">
    メディアのみの受信メッセージは以下のようなプレースホルダーで正規化されます:

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    ロケーションと連絡先のペイロードはルーティング前にテキストコンテキストに正規化されます。

  </Accordion>

  <Accordion title="ペンディンググループ履歴インジェクション">
    グループでは、未処理のメッセージをバッファリングし、ボットがトリガーされた時にコンテキストとして注入できます。

    - デフォルト制限: `50`
    - 設定: `channels.whatsapp.historyLimit`
    - フォールバック: `messages.groupChat.historyLimit`
    - `0`で無効化

    インジェクションマーカー:

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="既読レシート">
    既読レシートはデフォルトで受け入れられた受信WhatsAppメッセージに対して有効です。

    グローバルで無効化:

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    アカウントごとのオーバーライド:

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

    セルフチャットターンはグローバルで有効な場合でも既読レシートをスキップします。

  </Accordion>
</AccordionGroup>

## 配信、チャンキング、メディア

<AccordionGroup>
  <Accordion title="テキストチャンキング">
    - デフォルトのチャンク制限: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline`モードは段落境界（空行）を優先し、次に長さセーフチャンキングにフォールバック
  </Accordion>

  <Accordion title="送信メディア動作">
    - 画像、動画、音声（PTTボイスノート）、ドキュメントペイロードをサポート
    - `audio/ogg`はボイスノート互換のため`audio/ogg; codecs=opus`に書き換え
    - アニメーションGIF再生はビデオ送信で`gifPlayback: true`によりサポート
    - マルチメディア返信ペイロードの送信時、キャプションは最初のメディアアイテムに適用
    - メディアソースはHTTP(S)、`file://`、またはローカルパス
  </Accordion>

  <Accordion title="メディアサイズ制限とフォールバック動作">
    - 受信メディア保存上限: `channels.whatsapp.mediaMaxMb`（デフォルト`50`）
    - 自動返信の送信メディア上限: `agents.defaults.mediaMaxMb`（デフォルト`5MB`）
    - 画像は制限に収まるように自動最適化（リサイズ/品質スイープ）
    - メディア送信失敗時、最初のアイテムのフォールバックは応答をサイレントに破棄する代わりにテキスト警告を送信
  </Accordion>
</AccordionGroup>

## 確認リアクション

WhatsAppは`channels.whatsapp.ackReaction`経由で受信レシートに即時確認リアクションをサポートします。

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

動作ノート:

- 受信が受け入れられた直後に送信されます（返信前）
- 失敗はログに記録されますが、通常の返信配信はブロックされません
- グループモード`mentions`はメンションでトリガーされたターンでリアクションします。グループアクティベーション`always`はこのチェックのバイパスとして機能します
- WhatsAppは`channels.whatsapp.ackReaction`を使用します（レガシーの`messages.ackReaction`はここでは使用されません）

## マルチアカウントと認証情報

<AccordionGroup>
  <Accordion title="アカウント選択とデフォルト">
    - アカウントIDは`channels.whatsapp.accounts`から取得
    - デフォルトアカウント選択: `default`が存在する場合はそれ、そうでなければ最初の設定済みアカウントID（ソート順）
    - アカウントIDはルックアップのため内部で正規化されます
  </Accordion>

  <Accordion title="認証情報パスとレガシー互換性">
    - 現在の認証パス: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - バックアップファイル: `creds.json.bak`
    - `~/.openclaw/credentials/`のレガシーデフォルト認証はデフォルトアカウントフローで引き続き認識/移行されます
  </Accordion>

  <Accordion title="ログアウト動作">
    `openclaw channels logout --channel whatsapp [--account <id>]`はそのアカウントのWhatsApp認証状態をクリアします。

    レガシー認証ディレクトリでは、`oauth.json`は保持されBaileys認証ファイルは削除されます。

  </Accordion>
</AccordionGroup>

## ツール、アクション、設定の書き込み

- エージェントツールサポートにはWhatsAppリアクションアクション（`react`）が含まれます。
- アクションゲート:
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- チャンネル起動の設定書き込みはデフォルトで有効です（`channels.whatsapp.configWrites=false`で無効化）。

## トラブルシューティング

<AccordionGroup>
  <Accordion title="リンクされていない（QRが必要）">
    症状: チャンネルステータスがリンクされていないと報告。

    修正:

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="リンク済みだが切断 / 再接続ループ">
    症状: リンクされたアカウントで繰り返し切断または再接続の試行。

    修正:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    必要に応じて`channels login`で再リンクしてください。

  </Accordion>

  <Accordion title="送信時にアクティブなリスナーがない">
    ターゲットアカウントのアクティブなGatewayリスナーが存在しない場合、送信はすぐに失敗します。

    Gatewayが実行中でアカウントがリンクされていることを確認してください。

  </Accordion>

  <Accordion title="グループメッセージが予期せず無視される">
    以下の順序で確認:

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups`許可リストエントリ
    - メンションゲーティング（`requireMention` + メンションパターン）
    - `openclaw.json`（JSON5）の重複キー: 後のエントリが前のエントリをオーバーライドするため、スコープごとに1つの`groupPolicy`を維持してください

  </Accordion>

  <Accordion title="Bunランタイム警告">
    WhatsApp GatewayランタイムはNodeを使用する必要があります。Bunは安定したWhatsApp/Telegram Gateway運用に対して非互換としてフラグ付けされています。
  </Accordion>
</AccordionGroup>

## 設定リファレンスポインター

プライマリリファレンス:

- [設定リファレンス - WhatsApp](/gateway/configuration-reference#whatsapp)

重要なWhatsAppフィールド:

- アクセス: `dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`
- 配信: `textChunkLimit`、`chunkMode`、`mediaMaxMb`、`sendReadReceipts`、`ackReaction`
- マルチアカウント: `accounts.<id>.enabled`、`accounts.<id>.authDir`、アカウントレベルのオーバーライド
- 運用: `configWrites`、`debounceMs`、`web.enabled`、`web.heartbeatSeconds`、`web.reconnect.*`
- セッション動作: `session.dmScope`、`historyLimit`、`dmHistoryLimit`、`dms.<id>.historyLimit`

## 関連ドキュメント

- [ペアリング](/channels/pairing)
- [チャンネルルーティング](/channels/channel-routing)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [トラブルシューティング](/channels/troubleshooting)
