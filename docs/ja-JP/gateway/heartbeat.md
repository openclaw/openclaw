---
summary: "ハートビートのポーリングメッセージと通知ルール"
read_when:
  - ハートビートのケイデンスやメッセージングを調整する場合
  - スケジュールタスクにハートビートと cron のどちらを使うか決める場合
title: "Heartbeat"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 9f1138ea89c5bcf8308c573df2c1815e225fcfb08c3b853f2c9e33b2fe005bf8
    source_path: gateway/heartbeat.md
    workflow: 15
---

# ハートビート（Gateway ゲートウェイ）

> **ハートビートと Cron の使い分け?** それぞれをいつ使うべきかは [Cron vs Heartbeat](/automation/cron-vs-heartbeat) を参照してください。

ハートビートはメインセッションで**定期的なエージェントターン**を実行し、モデルが注意を要するものを、スパムにならない形で表示できるようにします。

ハートビートはスケジュールされたメインセッションターンです。[バックグラウンドタスク](/automation/tasks)レコードは**作成しません**。
タスクレコードはデタッチされた作業（ACP 実行、サブエージェント、独立した cron ジョブ）のためのものです。

トラブルシューティング: [/automation/troubleshooting](/automation/troubleshooting)

## クイックスタート（初心者向け）

1. ハートビートを有効のままにする（デフォルトは `30m`、Anthropic OAuth/setup-token では `1h`）か、独自のケイデンスを設定する。
2. エージェントワークスペースに小さな `HEARTBEAT.md` チェックリストを作成する（オプションだが推奨）。
3. ハートビートメッセージの送信先を決める（`target: "none"` がデフォルト; 最後の連絡先にルーティングするには `target: "last"` を設定）。
4. オプション: 透明性のためにハートビートの推論配信を有効にする。
5. オプション: ハートビートの実行に `HEARTBEAT.md` のみが必要な場合は、軽量ブートストラップコンテキストを使用する。
6. オプション: 各ハートビートで会話履歴全体を送信しないよう、分離セッションを有効にする。
7. オプション: ハートビートをアクティブな時間帯に制限する（ローカル時間）。

設定例：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 最後の連絡先への明示的な配信（デフォルトは "none"）
        directPolicy: "allow", // デフォルト: ダイレクト/DM ターゲットを許可; "block" でサプレス
        lightContext: true, // オプション: ブートストラップファイルから HEARTBEAT.md のみを注入
        isolatedSession: true, // オプション: 実行ごとにフレッシュセッション（会話履歴なし）
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // オプション: 別の `Reasoning:` メッセージも送信
      },
    },
  },
}
```

## デフォルト

- インターバル: `30m`（Anthropic OAuth/setup-token が検出された認証モードの場合は `1h`）。`agents.defaults.heartbeat.every` またはエージェントごとの `agents.list[].heartbeat.every` で設定; 無効にするには `0m` を使用。
- プロンプト本文（`agents.defaults.heartbeat.prompt` で設定可能）:
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- ハートビートプロンプトはユーザーメッセージとして**そのまま**送信されます。システムプロンプトには「ハートビート」セクションが含まれ、実行は内部でフラグが立てられます。
- アクティブ時間帯（`heartbeat.activeHours`）は設定されたタイムゾーンでチェックされます。
  ウィンドウ外では、ウィンドウ内の次のティックまでハートビートはスキップされます。

## ハートビートプロンプトの目的

デフォルトのプロンプトは意図的に幅広く設定されています：

- **バックグラウンドタスク**: 「未解決のタスクを考慮する」というナッジがエージェントにフォローアップ（受信トレイ、カレンダー、リマインダー、キューに入った作業）を確認させ、緊急のものを表示させます。
- **ヒューマンチェックイン**: 「日中に人間のチェックインをすることがある」というナッジが、設定されたローカルタイムゾーン（[/concepts/timezone](/concepts/timezone) を参照）を使用して夜間のスパムを避けながら、軽量な「何か必要ですか?」メッセージを促します。

ハートビートは完了した[バックグラウンドタスク](/automation/tasks)に反応できますが、ハートビートの実行自体はタスクレコードを作成しません。

ハートビートに非常に具体的なことをさせたい場合（例: 「Gmail PubSub の統計をチェック」または「Gateway ゲートウェイのヘルスを確認」）、`agents.defaults.heartbeat.prompt`（または `agents.list[].heartbeat.prompt`）にカスタム本文（そのまま送信）を設定してください。

## レスポンスの規約

- 注意が必要なことが何もない場合は、**`HEARTBEAT_OK`** と返信します。
- ハートビートの実行中、OpenClaw は返信の**先頭または末尾**に `HEARTBEAT_OK` が現れた場合に確認として扱います。トークンは削除され、残りのコンテンツが **`ackMaxChars`**（デフォルト: 300）以下の場合は返信が破棄されます。
- `HEARTBEAT_OK` が返信の**中間**に現れた場合は特別扱いされません。
- アラートの場合は `HEARTBEAT_OK` を**含めず**、アラートテキストのみを返してください。

ハートビート以外では、メッセージの先頭または末尾にある `HEARTBEAT_OK` はストリップされてログに記録されます。`HEARTBEAT_OK` のみのメッセージは破棄されます。

## 設定

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // デフォルト: 30m (0m で無効)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // デフォルト: false (利用可能な場合に別の Reasoning: メッセージを配信)
        lightContext: false, // デフォルト: false; true ではワークスペースブートストラップファイルから HEARTBEAT.md のみを保持
        isolatedSession: false, // デフォルト: false; true では各ハートビートをフレッシュセッションで実行（会話履歴なし）
        target: "last", // デフォルト: none | オプション: last | none | <channel id>（コアまたはプラグイン、例: "bluebubbles"）
        to: "+15551234567", // オプションのチャンネル固有オーバーライド
        accountId: "ops-bot", // オプションのマルチアカウントチャンネル ID
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // HEARTBEAT_OK の後に許可される最大文字数
      },
    },
  },
}
```

### スコープと優先順位

- `agents.defaults.heartbeat` はグローバルなハートビートの動作を設定します。
- `agents.list[].heartbeat` はその上にマージされます; エージェントに `heartbeat` ブロックがある場合、**それらのエージェントのみ**がハートビートを実行します。
- `channels.defaults.heartbeat` はすべてのチャンネルの可視性デフォルトを設定します。
- `channels.<channel>.heartbeat` はチャンネルのデフォルトをオーバーライドします。
- `channels.<channel>.accounts.<id>.heartbeat`（マルチアカウントチャンネル）はチャンネルごとの設定をオーバーライドします。

### エージェントごとのハートビート

`agents.list[]` エントリに `heartbeat` ブロックが含まれている場合、**それらのエージェントのみ**がハートビートを実行します。エージェントごとのブロックは `agents.defaults.heartbeat` の上にマージされます（共有デフォルトを一度設定してエージェントごとにオーバーライドできます）。

例: 2つのエージェント、2番目のエージェントのみがハートビートを実行。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 最後の連絡先への明示的な配信（デフォルトは "none"）
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

特定のタイムゾーンでビジネス時間にハートビートを制限する：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 最後の連絡先への明示的な配信（デフォルトは "none"）
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // オプション; 設定されている場合は userTimezone を使用、それ以外はホスト TZ
        },
      },
    },
  },
}
```

このウィンドウ外（東部時間の午前9時以前または午後10時以降）ではハートビートはスキップされます。ウィンドウ内の次のスケジュールされたティックは通常通り実行されます。

### 24時間/7日間のセットアップ

ハートビートを終日実行させたい場合は、以下のいずれかのパターンを使用してください：

- `activeHours` を完全に省略する（時間ウィンドウの制限なし; これがデフォルトの動作）。
- 全日ウィンドウを設定する: `activeHours: { start: "00:00", end: "24:00" }`。

同じ `start` と `end` 時間を設定しないでください（例: `08:00` から `08:00`）。
これはゼロ幅のウィンドウとして扱われるため、ハートビートは常にスキップされます。

### マルチアカウントの例

Telegram のようなマルチアカウントチャンネルで特定のアカウントをターゲットにするには `accountId` を使用します：

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // オプション: 特定のトピック/スレッドにルーティング
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

- `every`: ハートビートインターバル（期間文字列; デフォルト単位 = 分）。
- `model`: ハートビート実行のオプションモデルオーバーライド（`provider/model`）。
- `includeReasoning`: 有効にすると、利用可能な場合に別の `Reasoning:` メッセージも配信します（`/reasoning on` と同じ形式）。
- `lightContext`: true の場合、ハートビート実行は軽量ブートストラップコンテキストを使用し、ワークスペースブートストラップファイルから `HEARTBEAT.md` のみを保持します。
- `isolatedSession`: true の場合、各ハートビートは以前の会話履歴なしにフレッシュセッションで実行されます。cron `sessionTarget: "isolated"` と同じ分離パターンを使用します。ハートビートごとのトークンコストを大幅に削減します。最大の節約には `lightContext: true` と組み合わせてください。配信ルーティングは引き続きメインセッションコンテキストを使用します。
- `session`: ハートビート実行のオプションセッションキー。
  - `main`（デフォルト）: エージェントのメインセッション。
  - 明示的なセッションキー（`openclaw sessions --json` または[セッション CLI](/cli/sessions) からコピー）。
  - セッションキーの形式: [Sessions](/concepts/session) および [Groups](/channels/groups) を参照。
- `target`:
  - `last`: 最後に使用した外部チャンネルに配信。
  - 明示的なチャンネル: 設定済みのチャンネルまたはプラグイン ID、例: `discord`、`matrix`、`telegram`、または `whatsapp`。
  - `none`（デフォルト）: ハートビートを実行するが、外部に**配信しない**。
- `directPolicy`: ダイレクト/DM 配信の動作を制御:
  - `allow`（デフォルト）: ダイレクト/DM ハートビート配信を許可。
  - `block`: ダイレクト/DM 配信をサプレス（`reason=dm-blocked`）。
- `to`: オプションの受信者オーバーライド（チャンネル固有 ID、例: WhatsApp の E.164 または Telegram チャット ID）。Telegram のトピック/スレッドには `<chatId>:topic:<messageThreadId>` を使用。
- `accountId`: マルチアカウントチャンネルのオプションアカウント ID。`target: "last"` の場合、アカウント ID はアカウントをサポートする解決済み最終チャンネルに適用されます。そうでなければ無視されます。アカウント ID が解決されたチャンネルの設定済みアカウントと一致しない場合、配信はスキップされます。
- `prompt`: デフォルトのプロンプト本文をオーバーライドします（マージされません）。
- `ackMaxChars`: 配信前に `HEARTBEAT_OK` の後に許可される最大文字数。
- `suppressToolErrorWarnings`: true の場合、ハートビート実行中のツールエラー警告ペイロードをサプレスします。
- `activeHours`: ハートビート実行を時間ウィンドウに制限します。`start`（HH:MM、含む; 当日の開始には `00:00` を使用）、`end`（HH:MM 排他的; 当日の終了には `24:00` を使用）、およびオプションの `timezone` を持つオブジェクト。
  - 省略または `"user"`: 設定されている場合は `agents.defaults.userTimezone` を使用、そうでなければホストシステムタイムゾーンにフォールバック。
  - `"local"`: 常にホストシステムタイムゾーンを使用。
  - 任意の IANA 識別子（例: `America/New_York`）: 直接使用; 無効な場合は上記の `"user"` の動作にフォールバック。
  - `start` と `end` はアクティブウィンドウに対して等しくなってはいけません; 等しい値はゼロ幅として扱われます（常にウィンドウ外）。
  - アクティブウィンドウ外では、ウィンドウ内の次のティックまでハートビートはスキップされます。

## 配信の動作

- ハートビートはデフォルトでエージェントのメインセッション（`agent:<id>:<mainKey>`）、または `session.scope = "global"` の場合は `global` で実行されます。`session` を設定して特定のチャンネルセッション（Discord/WhatsApp/など）にオーバーライドします。
- `session` は実行コンテキストのみに影響します; 配信は `target` と `to` によって制御されます。
- 特定のチャンネル/受信者に配信するには、`target` + `to` を設定します。`target: "last"` を使用すると、そのセッションの最後に使用した外部チャンネルを使って配信されます。
- ハートビート配信はデフォルトでダイレクト/DM ターゲットを許可します。ダイレクトターゲットへの送信を抑制するには `directPolicy: "block"` を設定します（ハートビートターンは引き続き実行されます）。
- メインキューがビジー状態の場合、ハートビートはスキップされ後で再試行されます。
- `target` が外部宛先に解決されない場合、実行は行われますが、アウトバウンドメッセージは送信されません。
- ハートビートのみの返信はセッションを生かし続け**ません**; アイドル期限が正常に動作するよう、最後の `updatedAt` は復元されます。
- デタッチされた[バックグラウンドタスク](/automation/tasks)はシステムイベントをエンキューしてハートビートをウェイクさせ、メインセッションが素早く何かに気づくようにできます。そのウェイクによってハートビートがバックグラウンドタスクになるわけではありません。

## 可視性コントロール

デフォルトでは、`HEARTBEAT_OK` の確認はサプレスされますが、アラートコンテンツは配信されます。チャンネルまたはアカウントごとにこれを調整できます：

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # HEARTBEAT_OK を非表示（デフォルト）
      showAlerts: true # アラートメッセージを表示（デフォルト）
      useIndicator: true # インジケーターイベントを出力（デフォルト）
  telegram:
    heartbeat:
      showOk: true # Telegram で OK 確認を表示
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # このアカウントのアラート配信をサプレス
```

優先順位: アカウントごと → チャンネルごと → チャンネルデフォルト → 組み込みデフォルト。

### 各フラグの動作

- `showOk`: モデルが OK のみの返信を返した場合に `HEARTBEAT_OK` 確認を送信します。
- `showAlerts`: モデルが OK でない返信を返した場合にアラートコンテンツを送信します。
- `useIndicator`: UI ステータスサーフェスのインジケーターイベントを出力します。

**3つすべて**が false の場合、OpenClaw はハートビートの実行を完全にスキップします（モデル呼び出しなし）。

### チャンネルごととアカウントごとの例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # すべての Slack アカウント
    accounts:
      ops:
        heartbeat:
          showAlerts: false # ops アカウントのみアラートをサプレス
  telegram:
    heartbeat:
      showOk: true
```

### よくあるパターン

| 目標                                       | 設定                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| デフォルト動作（サイレント OK、アラートオン） | _（設定不要）_                                                                          |
| 完全サイレント（メッセージなし、インジケーターなし） | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| インジケーターのみ（メッセージなし）       | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 1チャンネルのみ OK を表示                 | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md（オプション）

ワークスペースに `HEARTBEAT.md` ファイルが存在する場合、デフォルトのプロンプトはエージェントにそれを読むよう伝えます。「ハートビートチェックリスト」として考えてください: 小さく、安定していて、30分ごとに含めても安全なものです。

`HEARTBEAT.md` が存在するが実質的に空（空白行と `# 見出し` のような Markdown ヘッダーのみ）の場合、OpenClaw は API 呼び出しを節約するためにハートビートの実行をスキップします。
ファイルが見つからない場合でも、ハートビートは実行され、モデルが何をするかを決定します。

プロンプトの肥大化を避けるために小さく保ってください（短いチェックリストまたはリマインダー）。

`HEARTBEAT.md` の例：

```md
# ハートビートチェックリスト

- クイックスキャン: 受信トレイに緊急なものはある?
- 日中であれば、他に保留中のものがなければ軽量なチェックインを行う。
- タスクがブロックされている場合は、_何が不足しているか_を書き留め、次の機会に Peter に聞く。
```

### エージェントは HEARTBEAT.md を更新できますか?

はい — あなたが頼めば。

`HEARTBEAT.md` はエージェントワークスペースの通常のファイルなので、通常のチャットでエージェントに以下のようなことを言えます：

- 「毎日のカレンダーチェックを追加するよう `HEARTBEAT.md` を更新して。」
- 「`HEARTBEAT.md` を短くして、受信トレイのフォローアップに集中するよう書き直して。」

これを積極的に実行させたい場合は、ハートビートプロンプトに明示的な行を含めることもできます: 「チェックリストが古くなった場合は、より良いもので HEARTBEAT.md を更新して。」

安全上の注意: 秘密情報（API キー、電話番号、プライベートトークン）を `HEARTBEAT.md` に入れないでください — プロンプトコンテキストの一部になります。

## 手動ウェイク（オンデマンド）

システムイベントをエンキューして即座にハートビートをトリガーできます：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

複数のエージェントに `heartbeat` が設定されている場合、手動ウェイクはそれらのエージェントハートビートをそれぞれ即座に実行します。

次のスケジュールされたティックまで待つには `--mode next-heartbeat` を使用してください。

## 推論の配信（オプション）

デフォルトでは、ハートビートは最終的な「回答」ペイロードのみを配信します。

透明性が欲しい場合は以下を有効にしてください：

- `agents.defaults.heartbeat.includeReasoning: true`

有効にすると、ハートビートは `Reasoning:` プレフィックスが付いた別のメッセージも配信します（`/reasoning on` と同じ形式）。これは複数のセッション/コードベックスを管理しているエージェントが、なぜあなたに ping したのかを見たいときに役立ちますが、不必要な内部詳細が漏れる可能性もあります。グループチャットではオフのままにしてください。

## コスト意識

ハートビートはフルエージェントターンを実行します。短いインターバルはより多くのトークンを消費します。コストを削減するには：

- `isolatedSession: true` を使用して会話履歴全体を送信しないようにします（約100K トークンから実行ごとに約2〜5K に削減）。
- `lightContext: true` を使用してブートストラップファイルを `HEARTBEAT.md` のみに制限します。
- より安価な `model` を設定します（例: `ollama/llama3.2:1b`）。
- `HEARTBEAT.md` を小さく保ちます。
- 内部ステートの更新のみが必要な場合は `target: "none"` を使用します。

## 関連項目

- [自動化の概要](/automation) — すべての自動化メカニズムの概要
- [Cron と Heartbeat の比較](/automation/cron-vs-heartbeat) — それぞれをいつ使うか
- [バックグラウンドタスク](/automation/tasks) — デタッチされた作業の追跡方法
- [タイムゾーン](/concepts/timezone) — タイムゾーンがハートビートスケジューリングに与える影響
- [トラブルシューティング](/automation/troubleshooting) — 自動化の問題のデバッグ
