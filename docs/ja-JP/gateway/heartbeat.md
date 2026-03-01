---
summary: "ハートビートポーリングメッセージと通知ルール"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
title: "ハートビート"
---

# ハートビート（Gateway）

> **ハートビート vs Cron?** それぞれをいつ使用すべきかのガイダンスについては、[Cron vs ハートビート](/automation/cron-vs-heartbeat)を参照してください。

ハートビートはメインセッションで**定期的なエージェントターン**を実行し、モデルがスパムせずに注意が必要な事項を表面化できるようにします。

トラブルシューティング：[/automation/troubleshooting](/automation/troubleshooting)

## クイックスタート（初心者向け）

1. ハートビートを有効のままにします（デフォルトは`30m`、Anthropic OAuth/setup-tokenの場合は`1h`）。または独自のケイデンスを設定します。
2. エージェントワークスペースに簡単な`HEARTBEAT.md`チェックリストを作成します（オプションですが推奨）。
3. ハートビートメッセージの送信先を決めます（`target: "none"`がデフォルト。最後の連絡先にルーティングするには`target: "last"`を設定）。
4. オプション：透明性のためにハートビート推論配信を有効にします。
5. オプション：ハートビートをアクティブ時間帯（ローカル時間）に制限します。

設定例：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 最後の連絡先への明示的配信（デフォルトは"none"）
        directPolicy: "allow", // デフォルト：direct/DMターゲットを許可。"block"で抑制
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // オプション：別途`Reasoning:`メッセージも送信
      },
    },
  },
}
```

## デフォルト

- 間隔：`30m`（検出された認証モードがAnthropic OAuth/setup-tokenの場合は`1h`）。`agents.defaults.heartbeat.every`またはエージェントごとの`agents.list[].heartbeat.every`で設定。無効にするには`0m`を使用。
- プロンプト本文（`agents.defaults.heartbeat.prompt`で設定可能）：
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- ハートビートプロンプトはユーザーメッセージとして**そのまま**送信されます。システムプロンプトには「Heartbeat」セクションが含まれ、実行は内部的にフラグされます。
- アクティブ時間（`heartbeat.activeHours`）は設定されたタイムゾーンでチェックされます。ウィンドウ外では、ウィンドウ内の次のティックまでハートビートはスキップされます。

## ハートビートプロンプトの目的

デフォルトのプロンプトは意図的に広範です：

- **バックグラウンドタスク**：「未処理のタスクを検討する」ことで、エージェントにフォローアップ（受信トレイ、カレンダー、リマインダー、キューに入れられた作業）をレビューし、緊急のものを表面化するよう促します。
- **人間のチェックイン**：「日中にときどき人間のチェックインをする」ことで、時折軽量な「何か必要ですか？」メッセージを促しますが、設定されたローカルタイムゾーン（[/concepts/timezone](/concepts/timezone)を参照）を使用して夜間のスパムを避けます。

ハートビートに非常に具体的なことをさせたい場合（例：「Gmail PubSub統計をチェック」や「Gatewayヘルスを確認」）、`agents.defaults.heartbeat.prompt`（または`agents.list[].heartbeat.prompt`）をカスタム本文に設定してください（そのまま送信されます）。

## レスポンス契約

- 注意が必要なことがない場合、**`HEARTBEAT_OK`**で返信します。
- ハートビート実行中、OpenClawは返信の**先頭または末尾**に`HEARTBEAT_OK`が出現した場合にackとして扱います。トークンは除去され、残りのコンテンツが**≤ `ackMaxChars`**（デフォルト：300）の場合、返信はドロップされます。
- `HEARTBEAT_OK`が返信の**中間**に出現した場合、特別な扱いはされません。
- アラートの場合、`HEARTBEAT_OK`を**含めず**、アラートテキストのみを返してください。

ハートビート外では、メッセージの先頭/末尾にある不要な`HEARTBEAT_OK`は除去されログに記録されます。`HEARTBEAT_OK`のみのメッセージはドロップされます。

## 設定

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // デフォルト：30m（0mで無効）
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // デフォルト：false（利用可能な場合は別途Reasoning:メッセージを配信）
        target: "last", // デフォルト：none | オプション：last | none | <チャンネルID>（コアまたはプラグイン、例："bluebubbles"）
        to: "+15551234567", // オプションのチャンネル固有オーバーライド
        accountId: "ops-bot", // オプションのマルチアカウントチャンネルID
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // HEARTBEAT_OK後に許可される最大文字数
      },
    },
  },
}
```

### スコープと優先順位

- `agents.defaults.heartbeat`はグローバルなハートビート動作を設定します。
- `agents.list[].heartbeat`はその上にマージされます。いずれかのエージェントに`heartbeat`ブロックがある場合、**それらのエージェントのみ**がハートビートを実行します。
- `channels.defaults.heartbeat`はすべてのチャンネルの表示デフォルトを設定します。
- `channels.<channel>.heartbeat`はチャンネルデフォルトをオーバーライドします。
- `channels.<channel>.accounts.<id>.heartbeat`（マルチアカウントチャンネル）はチャンネルごとの設定をオーバーライドします。

### エージェントごとのハートビート

いずれかの`agents.list[]`エントリに`heartbeat`ブロックが含まれている場合、**それらのエージェントのみ**がハートビートを実行します。エージェントごとのブロックは`agents.defaults.heartbeat`の上にマージされます（共有デフォルトを一度設定し、エージェントごとにオーバーライドできます）。

例：2つのエージェント、2番目のエージェントのみがハートビートを実行。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 最後の連絡先への明示的配信（デフォルトは"none"）
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### アクティブ時間の例

特定のタイムゾーンの営業時間にハートビートを制限します：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // オプション。設定されている場合はuserTimezoneを使用、それ以外はホストTZ
        },
      },
    },
  },
}
```

このウィンドウ外（午前9時前または午後10時以降東部時間）では、ハートビートはスキップされます。ウィンドウ内の次のスケジュールされたティックは通常通り実行されます。

### 24時間365日セットアップ

ハートビートを終日実行したい場合、以下のパターンを使用します：

- `activeHours`を完全に省略（時間制限なし、これがデフォルト動作）。
- フルデイウィンドウを設定：`activeHours: { start: "00:00", end: "24:00" }`。

同じ`start`と`end`時間（例：`08:00`から`08:00`）を設定しないでください。ゼロ幅ウィンドウとして扱われ、ハートビートは常にスキップされます。

### マルチアカウントの例

`accountId`を使用してTelegramなどのマルチアカウントチャンネルの特定のアカウントをターゲットにします：

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // オプション：特定のトピック/スレッドにルーティング
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### フィールドの注意事項

- `every`：ハートビート間隔（期間文字列。デフォルト単位 = 分）。
- `model`：ハートビート実行用のオプションのモデルオーバーライド（`provider/model`）。
- `includeReasoning`：有効にすると、利用可能な場合に別途`Reasoning:`メッセージも配信します（`/reasoning on`と同じ形状）。
- `session`：ハートビート実行用のオプションのセッションキー。
  - `main`（デフォルト）：エージェントのメインセッション。
  - 明示的なセッションキー（`openclaw sessions --json`または[セッションCLI](/cli/sessions)からコピー）。
  - セッションキーフォーマット：[セッション](/concepts/session)と[グループ](/channels/groups)を参照。
- `target`：
  - `last`：最後に使用された外部チャンネルに配信。
  - 明示的チャンネル：`whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`。
  - `none`（デフォルト）：ハートビートを実行しますが、外部に**配信しません**。
- `directPolicy`：直接/DM配信動作を制御：
  - `allow`（デフォルト）：直接/DMハートビート配信を許可。
  - `block`：直接/DM配信を抑制（`reason=dm-blocked`）。
- `to`：オプションの受信者オーバーライド（チャンネル固有ID、例：WhatsAppのE.164やTelegramチャットID）。Telegramトピック/スレッドの場合は`<chatId>:topic:<messageThreadId>`を使用。
- `accountId`：マルチアカウントチャンネル用のオプションのアカウントID。`target: "last"`の場合、アカウントIDは解決された最後のチャンネルがアカウントをサポートする場合に適用されます。そうでなければ無視されます。アカウントIDが解決されたチャンネルの設定済みアカウントと一致しない場合、配信はスキップされます。
- `prompt`：デフォルトのプロンプト本文をオーバーライドします（マージされません）。
- `ackMaxChars`：配信前に`HEARTBEAT_OK`後に許可される最大文字数。
- `suppressToolErrorWarnings`：trueの場合、ハートビート実行中のツールエラー警告ペイロードを抑制します。
- `activeHours`：ハートビート実行を時間ウィンドウに制限します。`start`（HH:MM、包含。1日の開始には`00:00`を使用）、`end`（HH:MM排他。1日の終了には`24:00`を許可）、オプションの`timezone`を持つオブジェクト。
  - 省略または`"user"`：設定されている場合は`agents.defaults.userTimezone`を使用、そうでなければホストシステムタイムゾーンにフォールバック。
  - `"local"`：常にホストシステムタイムゾーンを使用。
  - 任意のIANA識別子（例：`America/New_York`）：直接使用。無効な場合は上記の`"user"`動作にフォールバック。
  - `start`と`end`はアクティブウィンドウでは等しくてはいけません。等しい値はゼロ幅として扱われます（常にウィンドウ外）。
  - アクティブウィンドウ外では、ウィンドウ内の次のティックまでハートビートはスキップされます。

## 配信動作

- ハートビートはデフォルトでエージェントのメインセッション（`agent:<id>:<mainKey>`）で実行されます。`session.scope = "global"`の場合は`global`。`session`を設定して特定のチャンネルセッション（Discord/WhatsAppなど）にオーバーライドできます。
- `session`は実行コンテキストのみに影響します。配信は`target`と`to`で制御されます。
- 特定のチャンネル/受信者に配信するには、`target` + `to`を設定します。`target: "last"`の場合、配信はそのセッションの最後の外部チャンネルを使用します。
- ハートビート配信はデフォルトで直接/DMターゲットを許可します。`directPolicy: "block"`を設定すると、ハートビートターンの実行は継続しながら直接ターゲット送信を抑制します。
- メインキューがビジーな場合、ハートビートはスキップされ後で再試行されます。
- `target`が外部宛先に解決されない場合、実行は行われますが送信メッセージは送信されません。
- ハートビートのみの返信はセッションを**生存させません**。最後の`updatedAt`が復元されるため、アイドル期限切れが通常通り動作します。

## 表示制御

デフォルトでは、`HEARTBEAT_OK`確認応答は抑制され、アラートコンテンツは配信されます。チャンネルごとまたはアカウントごとに調整できます：

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # HEARTBEAT_OKを非表示（デフォルト）
      showAlerts: true # アラートメッセージを表示（デフォルト）
      useIndicator: true # インジケーターイベントを発行（デフォルト）
  telegram:
    heartbeat:
      showOk: true # TelegramでOK確認応答を表示
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # このアカウントのアラート配信を抑制
```

優先順位：アカウントごと → チャンネルごと → チャンネルデフォルト → 組み込みデフォルト。

### 各フラグの動作

- `showOk`：モデルがOKのみの返信を返した場合に`HEARTBEAT_OK`確認応答を送信します。
- `showAlerts`：モデルが非OK返信を返した場合にアラートコンテンツを送信します。
- `useIndicator`：UIステータスサーフェス用のインジケーターイベントを発行します。

**3つすべて**がfalseの場合、OpenClawはハートビート実行を完全にスキップします（モデルコールなし）。

### チャンネルごと vs アカウントごとの例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # すべてのSlackアカウント
    accounts:
      ops:
        heartbeat:
          showAlerts: false # opsアカウントのみアラートを抑制
  telegram:
    heartbeat:
      showOk: true
```

### 一般的なパターン

| 目標                                     | 設定                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| デフォルト動作（サイレントOK、アラートオン） | _（設定不要）_                                                                     |
| 完全サイレント（メッセージなし、インジケーターなし） | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| インジケーターのみ（メッセージなし）             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 1つのチャンネルでのみOK                  | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md（オプション）

ワークスペースに`HEARTBEAT.md`ファイルが存在する場合、デフォルトのプロンプトはエージェントにそれを読むよう指示します。「ハートビートチェックリスト」と考えてください：小さく、安定し、30分ごとに含めても安全です。

`HEARTBEAT.md`が存在するが実質的に空（空行とMarkdownヘッダー（`# Heading`など）のみ）の場合、OpenClawはAPIコールを節約するためにハートビート実行をスキップします。ファイルがない場合でもハートビートは実行され、モデルが何をするか決定します。

プロンプトの肥大化を避けるために小さく保ってください（短いチェックリストやリマインダー）。

`HEARTBEAT.md`の例：

```md
# ハートビートチェックリスト

- クイックスキャン：受信トレイに緊急のものはありますか？
- 日中であれば、他に保留中のものがなければ軽いチェックインをしてください。
- タスクがブロックされている場合、_何が不足しているか_を書き留め、次回Peterに聞いてください。
```

### エージェントがHEARTBEAT.mdを更新できますか？

はい。お願いすればできます。

`HEARTBEAT.md`はエージェントワークスペースの通常のファイルなので、（通常のチャットで）エージェントに以下のように伝えることができます：

- 「`HEARTBEAT.md`を更新して、毎日のカレンダーチェックを追加して。」
- 「`HEARTBEAT.md`を書き直して、受信トレイのフォローアップに焦点を当てた短いものにして。」

これをプロアクティブに行わせたい場合は、ハートビートプロンプトに明示的な行を含めることもできます：「チェックリストが古くなったら、より良いものでHEARTBEAT.mdを更新して。」

安全上の注意：`HEARTBEAT.md`にシークレット（APIキー、電話番号、プライベートトークン）を入れないでください。プロンプトコンテキストの一部になります。

## 手動ウェイク（オンデマンド）

システムイベントをキューに入れ、即座にハートビートをトリガーできます：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

複数のエージェントに`heartbeat`が設定されている場合、手動ウェイクはそれらのエージェントハートビートをそれぞれ即座に実行します。

`--mode next-heartbeat`を使用して、次のスケジュールされたティックを待ちます。

## 推論配信（オプション）

デフォルトでは、ハートビートは最終的な「回答」ペイロードのみを配信します。

透明性が必要な場合は、以下を有効にします：

- `agents.defaults.heartbeat.includeReasoning: true`

有効にすると、ハートビートは`Reasoning:`で始まる別のメッセージも配信します（`/reasoning on`と同じ形状）。これはエージェントが複数のセッション/コーデックスを管理していて、なぜpingしたのかを確認したい場合に便利ですが、望むよりも多くの内部詳細を漏洩する可能性もあります。グループチャットではオフのままにすることを推奨します。

## コスト意識

ハートビートは完全なエージェントターンを実行します。短い間隔はより多くのトークンを消費します。`HEARTBEAT.md`を小さく保ち、内部状態更新のみが必要な場合は安価な`model`や`target: "none"`を検討してください。
