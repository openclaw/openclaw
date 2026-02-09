---
summary: "WhatsApp（Web チャンネル）統合：ログイン、受信トレイ、返信、メディア、運用"
read_when:
  - WhatsApp/Web チャンネルの挙動や受信トレイのルーティングに取り組むとき
title: "WhatsApp"
---

# WhatsApp（Web チャンネル）

ステータス：Baileys 経由の WhatsApp Web のみ対応。Gateway がセッションを所有します。 ゲートウェイはセッションを所有しています。

## クイックセットアップ（初心者向け）

1. 可能であれば **別の電話番号** を使用してください（推奨）。
2. `~/.openclaw/openclaw.json` で WhatsApp を設定します。
3. `openclaw channels login` を実行して QR コード（リンク済みデバイス）をスキャンします。
4. ゲートウェイを起動します。

最小構成：

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

## 目標

- 1 つの Gateway プロセスで複数の WhatsApp アカウント（マルチアカウント）を扱う。
- 決定的なルーティング：返信は必ず WhatsApp に戻り、モデルルーティングは行わない。
- モデルが引用返信を理解できるだけのコンテキストを提供する。

## 設定の書き込み

デフォルトでは、`/config set|unset` によってトリガーされる設定更新の書き込みが WhatsApp に許可されています（`commands.config: true` が必要）。

無効化するには：

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## アーキテクチャ（責務の分離）

- **Gateway** が Baileys ソケットと受信ループを所有します。
- **CLI / macOS アプリ** はゲートウェイと通信し、Baileys を直接使用しません。
- **アクティブなリスナー** が送信には必須です。存在しない場合、送信は即時失敗します。

## 電話番号の取得（2 つのモード）

WhatsApp は認証のために実在する携帯電話番号を要求します。VoIP や仮想番号は通常ブロックされます。OpenClaw を WhatsApp で運用する方法は次の 2 つです。 VoIPと仮想番号は通常ブロックされます。 WhatsAppでOpenClawを実行するには2つの方法があります。

### 専用番号（推奨）

**別の電話番号** をOpenClawに使用します。 ベストUX、クリーンなルーティング、ない自己チャット癖。 理想的な設定: **spare/old Android phone + eSIM** . Wi-Fiと電源に残し、QRでリンクしてください。

**WhatsApp Business：** 同じ端末で別の番号として WhatsApp Business を使用できます。個人用 WhatsApp と分離できるため便利です。WhatsApp Business をインストールし、OpenClaw 用番号を登録してください。 WhatsAppビジネスをインストールし、そこでOpenClaw番号を登録してください。

**サンプル設定（専用番号、単一ユーザー許可リスト）：**

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

**ペアリングモード (オプション):**
allowlistの代わりにペアリングをしたい場合は、 `channels.whatsapp.dmPolicy` を `pairing` に設定します。 **ペアリングモード（任意）：**  
許可リストではなくペアリングを使う場合、`channels.whatsapp.dmPolicy` を `pairing` に設定します。不明な送信者にはペアリングコードが送られ、次で承認します：
`openclaw pairing approve whatsapp <code>`

### 個人番号（フォールバック）

クイックフォールバック: **あなた自身の番号**でOpenClawを実行します。 連絡先にスパムメールを送信しないようにテスト用のWhatsApp（「自分自身にメッセージを送信」）にメッセージを送信します。 セットアップと実験中にメインの携帯電話で検証コードを読み取ることを期待しています。 \*\*セルフチャットモードを有効にする必要があります。 \*
ウィザードがあなたのWhatsApp番号を尋ねるときは、アシスタント番号ではなく、(所有者/送信者)からメッセージを送信する電話番号を入力します。

**サンプル設定（個人番号、自己チャット）：**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

自己チャットの返信は、設定されている場合はデフォルトで `[{identity.name}]` を使用します（それ以外は `[openclaw]`）。  
`messages.responsePrefix` が未設定の場合です。明示的に設定してカスタマイズまたは無効化してください  
（削除するには `""` を使用）。 7. プレフィックスをカスタマイズまたは無効化するには明示的に設定してください（削除するには `""` を使用します）。

### 番号調達のヒント

- **国内キャリアのローカル eSIM**（最も信頼性が高い）
  - オーストリア： [hot.at](https://www.hot.at)
  - 英国： [giffgaff](https://www.giffgaff.com) — 無料 SIM、契約不要
- **プリペイド SIM** — 安価で、認証用に 1 通の SMS を受信できれば十分

**避けるべきもの：** TextNow、Google Voice、ほとんどの「無料 SMS」サービス — WhatsApp はこれらを積極的にブロックします。

**ヒント：** この数字は検証SMSを1回受け取るだけです。 その後、 WhatsApp Web セッションは `creds.json` 経由で継続されます。

## なぜ Twilio を使わないのか？

- 初期の OpenClaw ビルドは Twilio の WhatsApp Business 統合をサポートしていました。
- WhatsApp Business 番号は個人用アシスタントには不向きです。
- Meta は 24 時間の返信ウィンドウを強制します。直近 24 時間に返信していない場合、ビジネス番号は新規メッセージを開始できません。
- 高頻度や「おしゃべり」な利用は、ビジネスアカウントが個人アシスタント用途を想定していないため、厳しいブロックを招きます。
- 結果として配信が不安定でブロックが頻発するため、サポートは削除されました。

## ログイン + 資格情報

- ログインコマンド：`openclaw channels login`（リンク済みデバイス経由の QR）。
- マルチアカウントログイン：`openclaw channels login --account <id>`（`<id>` = `accountId`）。
- デフォルトアカウント（`--account` を省略した場合）：`default` が存在すればそれ、なければ設定済みアカウント ID の先頭（ソート順）。
- 資格情報は `~/.openclaw/credentials/whatsapp/<accountId>/creds.json` に保存されます。
- バックアップコピーは `creds.json.bak`（破損時に復元）。
- レガシー互換：旧インストールでは Baileys ファイルを `~/.openclaw/credentials/` に直接保存していました。
- ログアウト：`openclaw channels logout`（または `--account <id>`）は WhatsApp の認証状態を削除します（共有の `oauth.json` は保持）。
- ログアウト状態のソケット ⇒ 再リンクを促すエラーが表示されます。

## 受信フロー（DM + グループ）

- WhatsApp イベントは `messages.upsert`（Baileys）から到達します。
- テストや再起動時にイベントハンドラが蓄積しないよう、シャットダウン時に受信リスナーを解除します。
- ステータス／ブロードキャストチャットは無視されます。
- ダイレクトチャットは E.164、グループはグループ JID を使用します。
- **DM ポリシー**：`channels.whatsapp.dmPolicy` がダイレクトチャットのアクセスを制御します（デフォルト：`pairing`）。
  - ペアリング：不明な送信者にはペアリングコードを返します（`openclaw pairing approve whatsapp <code>` で承認。コードは 1 時間で失効）。
  - オープン：`channels.whatsapp.allowFrom` に `"*"` を含める必要があります。
  - リンク済みの自分の WhatsApp 番号は暗黙的に信頼されるため、自己メッセージは `channels.whatsapp.dmPolicy` と `channels.whatsapp.allowFrom` のチェックをスキップします。

### 個人番号モード（フォールバック）

**個人の WhatsApp 番号** で OpenClaw を実行する場合は、`channels.whatsapp.selfChatMode` を有効化してください（上記サンプル参照）。

挙動：

- 送信 DM はペアリング返信を決してトリガーしません（連絡先のスパム防止）。
- 受信の不明な送信者は引き続き `channels.whatsapp.dmPolicy` に従います。
- 自己チャットモード（allowFrom に自分の番号を含める）では、自動既読送信を回避し、メンション JID を無視します。
- セルフチャット以外のDMの領収書をお読みください。

## 既読（Read receipts）

デフォルトでは、受信した WhatsApp メッセージは受理されると既読（青いチェック）に設定されます。

グローバルに無効化：

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

アカウントごとに無効化：

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

注記：

- 自己チャットモードでは常に既読をスキップします。

## WhatsApp FAQ：送信 + ペアリング

**WhatsApp をリンクすると、OpenClaw がランダムな連絡先にメッセージを送りますか？**  
いいえ。デフォルトの DM ポリシーは **ペアリング** のため、不明な送信者にはペアリングコードのみが送られ、メッセージは **処理されません**。OpenClaw は受信したチャット、またはエージェント／CLI で明示的にトリガーした送信にのみ返信します。 デフォルトのDMポリシーは**ペアリング**であるため、未知の送信者はペアリングコードのみを取得し、メッセージは**処理されません**。 OpenClawは、受信したチャットまたは明示的にトリガー(エージェント/CLI)を送信するチャットのみに返信します。

**WhatsApp のペアリングはどのように機能しますか？**  
ペアリングは不明な送信者に対する DM ゲートです。

- 新規送信者からの最初の DM には短いコードが返ります（メッセージは処理されません）。
- 次で承認します：`openclaw pairing approve whatsapp <code>`（一覧は `openclaw pairing list whatsapp`）。
- コードは 1 時間で失効し、保留リクエストはチャンネルごとに最大 3 件です。

**1 つの WhatsApp 番号で、複数人が異なる OpenClaw インスタンスを使えますか？**  
はい。`bindings` により送信者ごとに別エージェントへルーティングできます（ピア `kind: "dm"`、送信者の E.164 例：`+15551234567`）。返信は **同一の WhatsApp アカウント** から送信され、ダイレクトチャットは各エージェントのメインセッションに集約されるため、**1 人につき 1 エージェント** を使用してください。DM のアクセス制御（`dmPolicy`/`allowFrom`）は WhatsApp アカウント単位でグローバルです。詳細は [Multi-Agent Routing](/concepts/multi-agent) を参照してください。 返信はまだ**同じWhatsAppアカウント**から来ており、各エージェントのメインセッションに直接チャットが崩壊しますので、**1人あたり1人のエージェント**を使用してください。 DM のアクセス制御(`dmPolicy`/`allowFrom`)は、WhatsAppアカウントごとにグローバルです。 [マルチエージェントルーティング](/concepts/multi-agent)を参照。

**ウィザードで電話番号を尋ねられるのはなぜですか？**  
自分の DM を許可するための **許可リスト／オーナー** 設定に使用されます。自動送信には使われません。個人の WhatsApp 番号で運用する場合は、その同じ番号を使用し、`channels.whatsapp.selfChatMode` を有効化してください。 自動送信には使用されません。 あなたのWhatsApp番号で実行する場合は、その同じ番号を使用して、`channels.whatsapp.selfChatMode` を有効にしてください。

## メッセージ正規化（モデルが見る内容）

- `Body` は現在のメッセージ本文（エンベロープ付き）です。

- 引用返信のコンテキストは **常に付加** されます：

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- 返信メタデータも設定されます：
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = 引用本文またはメディアのプレースホルダー
  - `ReplyToSender` = 既知の場合は E.164

- メディアのみの受信メッセージはプレースホルダーを使用します：
  - `<media:image|video|audio|document|sticker>`

## グループ

- グループは `agent:<agentId>:whatsapp:group:<jid>` セッションにマッピングされます。
- グループポリシー：`channels.whatsapp.groupPolicy = open|disabled|allowlist`（デフォルト `allowlist`）。
- 有効化モード：
  - `mention`（デフォルト）：@メンションまたは正規表現一致が必要。
  - `always`：常にトリガー。
- `/activation mention|always` はオーナー専用で、単独メッセージとして送信する必要があります。
- オーナー = `channels.whatsapp.allowFrom`（未設定の場合は自己 E.164）。
- **履歴インジェクション**（未処理のみ）：
  - 最近の _未処理_ メッセージ（デフォルト 50 件）を次に挿入：
    `[Chat messages since your last reply - for context]`（すでにセッション内にあるメッセージは再挿入されません）
  - 現在のメッセージは次に挿入：
    `[Current message - respond to this]`
  - 送信者サフィックスを付加：`[from: Name (+E164)]`
- グループメタデータは 5 分間キャッシュされます（件名 + 参加者）。

## 返信配信（スレッディング）

- WhatsApp Web は標準メッセージを送信します（現行ゲートウェイでは引用返信のスレッディングは未対応）。
- 返信タグはこのチャンネルでは無視されます。

## 受信確認リアクション（受信時の自動リアクション）

WhatsApp は、ボットが返信を生成する前に、受信直後に絵文字リアクションを自動送信できます。これにより、ユーザーに即時の受信フィードバックを提供します。 これにより、メッセージが受信されたことをユーザーに即座にフィードバックします。

**設定：**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**オプション：**

- `emoji`（string）：受信確認に使用する絵文字（例：「👀」「✅」「📨」）。空または未指定の場合は無効。 空または省略された = 機能は無効です。
- `direct`（boolean、デフォルト：`true`）：ダイレクト／DM チャットでリアクションを送信。
- `group`（string、デフォルト：`"mentions"`）：グループチャットの挙動：
  - `"always"`：すべてのグループメッセージにリアクション（@メンションなしでも）
  - `"mentions"`：ボットが @メンションされた場合のみリアクション
  - `"never"`：グループではリアクションしない

**アカウント別オーバーライド：**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**挙動に関する注記：**

- リアクションは、入力中インジケーターやボット返信より前に、受信 **直後** に送信されます。
- `requireMention: false`（有効化：常に）のグループでは、`group: "mentions"` はすべてのメッセージにリアクションします（@メンションに限定されません）。
- Fire-and-forget：リアクション送信の失敗はログに記録されますが、返信自体は妨げません。
- グループリアクションでは参加者 JID が自動的に含まれます。
- WhatsApp は `messages.ackReaction` を無視するため、代わりに `channels.whatsapp.ackReaction` を使用してください。

## エージェントツール（リアクション）

- ツール：`whatsapp`、アクション `react`（`chatJid`、`messageId`、`emoji`、任意で `remove`）。
- 任意：`participant`（グループ送信者）、`fromMe`（自分のメッセージへのリアクション）、`accountId`（マルチアカウント）。
- リアクション削除のセマンティクス：[/tools/reactions](/tools/reactions) を参照。
- ツールのゲーティング：`channels.whatsapp.actions.reactions`（デフォルト：有効）。

## 制限

- 送信テキストは `channels.whatsapp.textChunkLimit` まで分割されます（デフォルト 4000）。
- 改行による分割（任意）：`channels.whatsapp.chunkMode="newline"` を設定すると、長さ分割の前に空行（段落境界）で分割します。
- 受信メディアの保存上限は `channels.whatsapp.mediaMaxMb`（デフォルト 50 MB）。
- 送信メディアの上限は `agents.defaults.mediaMaxMb`（デフォルト 5 MB）。

## 送信（テキスト + メディア）

- アクティブな Web リスナーを使用します。ゲートウェイ未起動の場合はエラー。
- テキスト分割：1 メッセージあたり最大 4k（`channels.whatsapp.textChunkLimit` で設定、任意で `channels.whatsapp.chunkMode`）。
- メディア：
  - 画像／動画／音声／ドキュメントをサポート。
  - 音声は PTT として送信。`audio/ogg` ⇒ `audio/ogg; codecs=opus`。
  - キャプションは最初のメディア項目のみに付与。
  - メディア取得は HTTP(S) とローカルパスをサポート。
  - アニメーション GIF：WhatsApp はインラインループのため `gifPlayback: true` 付きの MP4 を期待します。
    - CLI：`openclaw message send --media <mp4> --gif-playback`
    - Gateway：`send` のパラメータに `gifPlayback: true` を含めます。

## ボイスノート（PTT 音声）

WhatsApp は音声を **ボイスノート**（PTT バブル）として送信します。

- 最高の結果:OGG/Opus。 最良の結果：OGG/Opus。OpenClaw は `audio/ogg` を `audio/ogg; codecs=opus` に書き換えます。
- `[[audio_as_voice]]` は WhatsApp では無視されます（音声は既にボイスノートとして送信されるため）。

## メディア制限 + 最適化

- デフォルトの送信上限：5 MB（メディア項目ごと）。
- オーバーライド：`agents.defaults.mediaMaxMb`。
- 画像は上限未満になるよう自動最適化（リサイズ + 品質スイープ）されます。
- 上限超過メディア ⇒ エラー。メディア返信はテキスト警告にフォールバックします。

## ハートビート

- **Gateway ハートビート** は接続ヘルスをログします（`web.heartbeatSeconds`、デフォルト 60 秒）。
- **エージェントハートビート** はエージェントごと（`agents.list[].heartbeat`）またはグローバル（`agents.defaults.heartbeat`、エージェント別設定がない場合のフォールバック）に設定できます。
  - 設定されたハートビートプロンプト（デフォルト：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）+ `HEARTBEAT_OK` のスキップ挙動を使用します。
  - 配信先はデフォルトで最後に使用したチャンネル（または設定済みのターゲット）です。

## 再接続の挙動

- バックオフポリシー：`web.reconnect`：
  - `initialMs`、`maxMs`、`factor`、`jitter`、`maxAttempts`。
- maxAttempts に到達すると、Web 監視は停止します（劣化状態）。
- ログアウト状態 ⇒ 停止し、再リンクが必要です。

## 設定クイックマップ

- `channels.whatsapp.dmPolicy`（DM ポリシー：pairing/allowlist/open/disabled）。
- `channels.whatsapp.selfChatMode`（同一端末セットアップ；ボットが個人の WhatsApp 番号を使用）。
- `channels.whatsapp.allowFrom` (DM allowlist). `channels.whatsapp.allowFrom`（DM 許可リスト）。WhatsApp は E.164 電話番号を使用します（ユーザー名なし）。
- `channels.whatsapp.mediaMaxMb`（受信メディア保存上限）。
- `channels.whatsapp.ackReaction`（受信時の自動リアクション：`{emoji, direct, group}`）。
- `channels.whatsapp.accounts.<accountId>.*`（アカウント別設定 + 任意の `authDir`）。
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb`（アカウント別受信メディア上限）。
- `channels.whatsapp.accounts.<accountId>.ackReaction`（アカウント別受信確認リアクション上書き）。
- `channels.whatsapp.groupAllowFrom`（グループ送信者許可リスト）。
- `channels.whatsapp.groupPolicy`（グループポリシー）。
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit`（グループ履歴コンテキスト；`0` で無効化）。
- `channels.whatsapp.dmHistoryLimit`（DM 履歴上限（ユーザーターン数））。ユーザー別上書き：`channels.whatsapp.dms["<phone>"].historyLimit`。 `channels.imessage.dmHistoryLimit`: ユーザー ターン数での DM 履歴上限。ユーザーごとの上書き: `channels.whatsapp.dms["<phone>"].historyLimit`。
- `channels.whatsapp.groups`（グループ許可リスト + メンションゲーティングのデフォルト；全許可は `"*"`）。
- `channels.whatsapp.actions.reactions`（WhatsApp ツールのリアクションをゲート）。
- `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）。
- `messages.groupChat.historyLimit`。
- `channels.whatsapp.messagePrefix`（受信プレフィックス；アカウント別：`channels.whatsapp.accounts.<accountId>.messagePrefix`；非推奨：`messages.messagePrefix`）。
- `messages.responsePrefix`（送信プレフィックス）。
- `agents.defaults.mediaMaxMb`。
- `agents.defaults.heartbeat.every`。
- `agents.defaults.heartbeat.model`（任意の上書き）。
- `agents.defaults.heartbeat.target`。
- `agents.defaults.heartbeat.to`。
- `agents.defaults.heartbeat.session`。
- `agents.list[].heartbeat.*`（エージェント別上書き）。
- `session.*`（scope、idle、store、mainKey）。
- `web.enabled`（false の場合にチャンネル起動を無効化）。
- `web.heartbeatSeconds`。
- `web.reconnect.*`。

## ログ + トラブルシューティング

- サブシステム：`whatsapp/inbound`、`whatsapp/outbound`、`web-heartbeat`、`web-reconnect`。
- ログファイル：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（設定可能）。
- トラブルシューティングガイド：[Gateway troubleshooting](/gateway/troubleshooting)。

## トラブルシューティング（簡易）

**未リンク／QR ログインが必要**

- 症状：`channels status` に `linked: false` が表示される、または「Not linked」と警告される。
- 対処：Gateway ホストで `openclaw channels login` を実行し、QR をスキャンします（WhatsApp → 設定 → リンク済みデバイス）。

**リンク済みだが切断／再接続ループ**

- 症状：`channels status` に `running, disconnected` が表示される、または「Linked but disconnected」と警告される。
- 修正: `openclaw doctor` (またはゲートウェイを再起動) それが続く場合は、 `channels login` 経由でrelinkし、 `openclawログ --follow` を調べてください。

**Bun ランタイム**

- Bun は **推奨されません** 。 Bun は **非推奨** です。WhatsApp（Baileys）と Telegram は Bun では不安定です。  
  **Node** でゲートウェイを実行してください。（Getting Started のランタイム注記を参照。）
  **Node** でゲートウェイを実行します。 (ランタイムノート入門を参照してください。
