---
summary: "ハートビートのポーリングメッセージと通知ルール"
read_when:
  - ハートビートの間隔やメッセージングを調整する場合
  - スケジュールされたタスクにハートビートと cron のどちらを使うか判断する場合
title: "Heartbeat"
---

# Heartbeat（Gateway）

> **Heartbeat と Cron の違いは？** 使い分けの指針については [Cron vs Heartbeat](/automation/cron-vs-heartbeat) を参照してください。

Heartbeat は、メインセッション内で **定期的なエージェントターン** を実行し、
あなたにスパムを送ることなく、注意が必要な事項をモデルが浮上させられるようにします。

トラブルシューティング: [/automation/troubleshooting](/automation/troubleshooting)

## クイックスタート（初心者向け）

1. ハートビートを有効のままにします（デフォルトは `30m`、Anthropic OAuth/setup-token の場合は `1h`）。または独自の間隔を設定します。
2. エージェントのワークスペースに小さな `HEARTBEAT.md` チェックリストを作成します（任意ですが推奨）。
3. ハートビートメッセージの送信先を決定します（デフォルトは `target: "last"`）。
4. 任意: 透明性のためにハートビートの reasoning 配信を有効にします。
5. 任意: アクティブ時間（ローカル時間）にハートビートを制限します。

設定例:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## デフォルト

- Interval: `30m` (または `1h` Anthropic OAuth/setup-token が検出された認証モードの場合) 間隔: `30m`（Anthropic OAuth/setup-token が検出された認証モードの場合は `1h`）。`agents.defaults.heartbeat.every` またはエージェントごとの `agents.list[].heartbeat.every` を設定します。無効化するには `0m` を使用します。
- プロンプト本文（`agents.defaults.heartbeat.prompt` で設定可能）:
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- ハートビートプロンプトは、ユーザーメッセージとして **そのまま** 送信されます。システムプロンプトには「Heartbeat」セクションが含まれ、実行は内部的にフラグ付けされます。 システム
  プロンプトには「ハートビート」セクションが含まれており、実行には内部的にフラグが付けられています。
- アクティブ時間（`heartbeat.activeHours`）は、設定されたタイムゾーンで判定されます。
  ウィンドウ外では、次にウィンドウ内に入るティックまでハートビートはスキップされます。
  ウィンドウの外側には、ウィンドウ内の次のチェックマークまでハートビートがスキップされます。

## ハートビートプロンプトの目的

デフォルトのプロンプトは、意図的に広範です。

- **バックグラウンドタスク**: 「未完了のタスクを考慮する」は、フォローアップ（受信箱、カレンダー、リマインダー、キューに入った作業）を見直し、緊急のものを浮上させるようエージェントに促します。
- **人へのチェックイン**: 「日中にときどき人間をチェックする」は、軽量な「何か必要ですか？」というメッセージを時折送るよう促しますが、設定したローカルタイムゾーンを使うことで夜間のスパムを避けます（[/concepts/timezone](/concepts/timezone) を参照）。

ハートビートで非常に具体的なこと（例: 「Gmail PubSub の統計を確認する」や「ゲートウェイの健全性を検証する」）を行わせたい場合は、`agents.defaults.heartbeat.prompt`（または `agents.list[].heartbeat.prompt`）にカスタム本文を設定してください（そのまま送信されます）。

## レスポンス契約

- 注意すべき点がない場合は、**`HEARTBEAT_OK`** と返信します。
- ハートビート実行中、OpenClaw は返信の **先頭または末尾** に現れる `HEARTBEAT_OK` を ack として扱います。このトークンは削除され、残りの内容が **≤ `ackMaxChars`**（デフォルト: 300）の場合、返信は破棄されます。 トークンが削除され、残りのコンテンツが **以下の `ackMaxChars`** (デフォルト: 300) の場合、返信は
  ドロップされます。
- `HEARTBEAT_OK` が返信の **途中** に現れた場合、特別扱いされません。
- アラートの場合、`HEARTBEAT_OK` は **含めないでください**。アラート本文のみを返します。

ハートビート外では、メッセージの先頭または末尾にある余分な `HEARTBEAT_OK` は削除されログに記録されます。内容が `HEARTBEAT_OK` のみのメッセージは破棄されます。

## 設定

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### スコープと優先順位

- `agents.defaults.heartbeat` はグローバルなハートビート動作を設定します。
- `agents.list[].heartbeat` は上書きマージされます。いずれかのエージェントに `heartbeat` ブロックがある場合、**それらのエージェントのみ** がハートビートを実行します。
- `channels.defaults.heartbeat` はすべてのチャンネルの可視性デフォルトを設定します。
- `channels.<channel>.heartbeat` はチャンネルのデフォルトを上書きします。
- `channels.<channel>.accounts.<id>.heartbeat`（マルチアカウントチャンネル）はチャンネルごとの設定を上書きします。

### エージェントごとのハートビート

いずれかの `agents.list[]` エントリーに `heartbeat` ブロックが含まれる場合、**それらのエージェントのみ** がハートビートを実行します。  
エージェントごとのブロックは `agents.defaults.heartbeat` の上にマージされます（共有デフォルトを一度設定し、エージェントごとに上書きできます）。 エージェントごとのブロックは、`agents.defaults.heartbeat`
の上にマージされます。共有のデフォルトを1回設定し、エージェントごとにオーバーライドできます。

例: 2 つのエージェントがあり、2 番目のエージェントのみがハートビートを実行します。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
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

特定のタイムゾーンで、営業時間内にハートビートを制限します。

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
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

この窓の外(午前9時以前または午後10時以降)には、鼓動がスキップされます。 ウィンドウ内の次のスケジュールされたチェックマークは正常に実行されます。

### マルチアカウントの例

Telegram のようなマルチアカウントチャンネルで特定のアカウントを指定するには、`accountId` を使用します。

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
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

### フィールドノート

- `every`: ハートビート間隔（duration 文字列。デフォルトの単位 = 分）。
- `model`: ハートビート実行時の任意のモデル上書き（`provider/model`）。
- `includeReasoning`: 有効にすると、利用可能な場合に別個の `Reasoning:` メッセージも配信します（`/reasoning on` と同じ形状）。
- `session`: ハートビート実行用の任意のセッションキー。
  - `main`（デフォルト）: エージェントのメインセッション。
  - 明示的なセッションキー（`openclaw sessions --json` または [sessions CLI](/cli/sessions) からコピー）。
  - セッションキー形式: [Sessions](/concepts/session) および [Groups](/channels/groups) を参照。
- `target`:
  - `last`（デフォルト）: 最後に使用した外部チャンネルに配信します。
  - 明示的なチャンネル: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`。
  - `none`: ハートビートを実行しますが、外部には **配信しません**。
- `to`: 任意の受信者上書き（チャンネル固有の ID。例: WhatsApp の E.164、Telegram の chat id）。
- `accountId`: マルチアカウントチャンネルのオプションのアカウントID。 `accountId`: マルチアカウントチャンネル用の任意のアカウント ID。`target: "last"` の場合、アカウント ID はアカウントをサポートする解決済みの最終チャンネルに適用され、それ以外は無視されます。アカウント ID が解決済みチャンネルに設定されたアカウントと一致しない場合、配信はスキップされます。 アカウントIDが解決済みチャネルの設定済みアカウントと一致しない場合、配信はスキップされます。
- `prompt`: デフォルトのプロンプト本文を上書きします（マージされません）。
- `ackMaxChars`: `HEARTBEAT_OK` 以降に配信を許可する最大文字数。
- `activeHours`: ハートビートの実行をタイムウィンドウに制限します。 `activeHours`: ハートビート実行を時間ウィンドウに制限します。`start`（HH:MM、包含）、`end`（HH:MM、排他的。終日の場合は `24:00` 可）、および任意の `timezone` を持つオブジェクト。
  - 省略または `"user"`: 設定されていれば `agents.defaults.userTimezone` を使用し、なければホストシステムのタイムゾーンにフォールバックします。
  - `"local"`: 常にホストシステムのタイムゾーンを使用します。
  - 任意の IANA 識別子（例: `America/New_York`）: 直接使用され、無効な場合は上記の `"user"` の挙動にフォールバックします。
  - アクティブウィンドウ外では、次にウィンドウ内に入るティックまでハートビートはスキップされます。

## 配信動作

- ハートビートは、デフォルトでエージェントのメインセッション（`agent:<id>:<mainKey>`）で実行されます。`session.scope = "global"` の場合は `global` になります。特定のチャンネルセッション（Discord/WhatsApp など）に上書きするには `session` を設定します。 `session`を
  特定のチャンネルセッション（Discord/WhatsApp/etc）にオーバーライドするように設定します。
- `session` は実行コンテキストのみに影響します。配信は `target` と `to` によって制御されます。
- 特定のチャンネル/受信者に配信するには、`target` + `to` を設定します。 特定のチャンネル/受信者に配信するには、`target` + `to` を設定します。`target: "last"` を使用すると、配信はそのセッションの最後の外部チャンネルを使用します。
- メインキューがビジーな場合、ハートビートはスキップされ、後で再試行されます。
- `target` が外部宛先に解決されない場合でも、実行自体は行われますが、送信メッセージはありません。
- ハートビートのみの返信はセッションを維持しません。最後の `updatedAt` が復元され、アイドル期限は通常どおり動作します。

## 可視性コントロール

デフォルトでは、アラートコンテンツが
配信されている間、`HEARTBEAT_OK` の承認は抑制されます。 チャンネルごとまたはアカウントごとにこれを調整できます:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

優先順位: アカウントごと → チャンネルごと → チャンネルのデフォルト → ビルトインのデフォルト。

### 各フラグの動作

- `showOk`: モデルが OK のみの返信を返した場合に、`HEARTBEAT_OK` の確認応答を送信します。
- `showAlerts`: モデルが非 OK の返信を返した場合に、アラート内容を送信します。
- `useIndicator`: UI のステータス表示用にインジケーターイベントを発行します。

**3 つすべて** が false の場合、OpenClaw はハートビート実行自体をスキップします（モデル呼び出しなし）。

### チャンネル別とアカウント別の例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### 一般的なパターン

| 目的                          | 設定                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| デフォルト動作（OK は非表示、アラート有効）     | _(設定不要)_                                                              |
| 完全にサイレント（メッセージなし、インジケーターなし） | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| インジケーターのみ（メッセージなし）          | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 特定の 1 チャンネルのみ OK を表示        | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md（任意）

ワークスペースに `HEARTBEAT.md` ファイルが存在する場合、デフォルトのプロンプトはエージェントにそれを読むよう指示します。これは「ハートビートチェックリスト」と考えてください。小さく、安定しており、30 分ごとに含めても安全な内容です。 30分ごとに安全な小型、安定、
の「ハートビートチェックリスト」と考えてください。

`HEARTBEAT.md` が存在するが、実質的に空（空行と `# Heading` のような Markdown 見出しのみ）の場合、OpenClaw は API コール節約のためにハートビート実行をスキップします。ファイルが存在しない場合でも、ハートビートは実行され、モデルが何をするかを判断します。
ファイルが存在しない場合でも、ハートビートは実行され、モデルが何をするかを判断します。

プロンプトの膨張を避けるために、小さくしてください (短いチェックリストまたはリマインダー)。

`HEARTBEAT.md` の例:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### エージェントは HEARTBEAT.md を更新できますか？

はい - あなたがそれを求める場合。

`HEARTBEAT.md` はエージェントのワークスペース内の通常のファイルなので、通常のチャットで次のように指示できます。

- 「`HEARTBEAT.md` を更新して、毎日のカレンダーチェックを追加してください。」
- 「`HEARTBEAT.md` を、より短く、受信箱のフォローアップに集中した内容に書き直してください。」

これをプロアクティブに行いたい場合は、ハートビートプロンプトに「チェックリストが古くなったら、より良いものに HEARTBEAT.md を更新する」といった明示的な一文を含めることもできます。

安全上の注意: 秘密情報（API キー、電話番号、プライベートトークン）を `HEARTBEAT.md` に入れないでください。これはプロンプトコンテキストの一部になります。

## 手動ウェイク（オンデマンド）

次のコマンドで、システムイベントをキューに入れ、即座にハートビートをトリガーできます。

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

複数のエージェントに `heartbeat` が設定されている場合、手動ウェイクはそれら各エージェントのハートビートを即座に実行します。

次のスケジュールされたティックまで待つには `--mode next-heartbeat` を使用します。

## Reasoning 配信（任意）

デフォルトでは、ハートビートは最終的な「回答」ペイロードのみを配信します。

透明性が必要な場合は、次を有効にしてください。

- `agents.defaults.heartbeat.includeReasoning: true`

有効にすると、ハートビートは
`Reasoning:`（`/reasoning`と同じ形状）の接頭辞を付けた別個のメッセージを送信します。 エージェントが複数のセッション／コーデックスを管理しており、なぜ通知されたのかを知りたい場合に有用ですが、望まない内部詳細が漏れる可能性もあります。 グループチャットで
をオフにすることを好みます。

## コストに関する注意

ハートビートはフルエージェントターンを実行します。 短い間隔では、より多くのトークンを燃焼させます。 `HEARTBEAT.md` は小さく保ち、内部状態の更新だけが目的であれば、より安価な `model` や `target: "none"` を検討してください。
