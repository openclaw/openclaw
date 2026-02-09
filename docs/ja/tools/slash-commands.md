---
summary: "スラッシュコマンド：テキスト vs ネイティブ、設定、対応コマンド"
read_when:
  - チャットコマンドを使用または設定する場合
  - コマンドのルーティングや権限をデバッグする場合
title: "スラッシュコマンド"
---

# スラッシュコマンド

コマンドはゲートウェイによって処理されます。 ほとんどのコマンドは`/`で始まる**スタンドアロン**メッセージとして送信する必要があります。
コマンドは Gateway（ゲートウェイ）によって処理されます。ほとんどのコマンドは、`/` で始まる **単独の** メッセージとして送信する必要があります。  
ホスト専用の bash チャットコマンドは `! <cmd>` を使用します（`/bash <cmd>` はエイリアスです）。

関連する仕組みは 2 つあります。

- **Commands**：単独の `/...` メッセージ。
- **Directives**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/exec`、`/model`、`/queue`。
  - Directives は、モデルがメッセージを見る前に取り除かれます。
  - 通常のチャットメッセージ（directive のみではない場合）では、「インラインヒント」として扱われ、セッション設定は **保持されません**。
  - directive のみのメッセージ（メッセージが directive だけで構成される場合）では、セッションに保持され、確認応答が返ります。
  - Directives は **許可された送信者**（チャンネル許可リスト／ペアリングに加えて `commands.useAccessGroups`）に対してのみ適用されます。  
    未許可の送信者では、directive はプレーンテキストとして扱われます。
    許可されていない送信者は、プレーンテキストとして扱われるディレクティブを参照します。

また、いくつかの **インラインショートカット**（許可リスト／許可された送信者のみ）があります：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。  
これらは即座に実行され、モデルがメッセージを見る前に取り除かれ、残りのテキストは通常のフローで処理されます。
それらはすぐに実行され、モデルがメッセージを見る前に剥がされ、残りのテキストは通常のフローを通過します。

## 設定

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text`（デフォルト：`true`）は、チャットメッセージ内の `/...` の解析を有効にします。
  - ネイティブコマンドを持たないサーフェス（WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams）では、これを `false` に設定してもテキストコマンドは引き続き動作します。
- `commands.native`（デフォルト：`"auto"`）は、ネイティブコマンドを登録します。
  - Auto：Discord/Telegram ではオン、Slack ではオフ（スラッシュコマンドを追加するまで）。ネイティブ対応のないプロバイダーでは無視されます。
  - `channels.discord.commands.native`、`channels.telegram.commands.native`、`channels.slack.commands.native` を設定して、プロバイダーごとに上書きできます（bool または `"auto"`）。
  - `false`は、起動時にDiscord/Telegramで登録したコマンドをクリアします。 `false` は、起動時に Discord/Telegram で以前に登録されたコマンドをクリアします。Slack のコマンドは Slack アプリ側で管理され、自動では削除されません。
- `commands.nativeSkills`（デフォルト：`"auto"`）は、対応している場合に **skill** コマンドをネイティブ登録します。
  - Auto：Discord/Telegram ではオン、Slack ではオフ（Slack では skill ごとにスラッシュコマンドを作成する必要があります）。
  - `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills`、`channels.slack.commands.nativeSkills` を設定して、プロバイダーごとに上書きできます（bool または `"auto"`）。
- `commands.bash`（デフォルト：`false`）は、`! <cmd>` がホストのシェルコマンドを実行できるようにします（`/bash <cmd>` はエイリアス。`tools.elevated` の許可リストが必要です）。
- `commands.bashForegroundMs`（デフォルト：`2000`）は、bash がバックグラウンドモードに切り替わるまでの待機時間を制御します（`0` は即座にバックグラウンド化します）。
- `commands.config`（デフォルト：`false`）は、`/config` を有効にします（`openclaw.json` の読み書き）。
- `commands.debug`（デフォルト：`false`）は、`/debug` を有効にします（ランタイムのみの上書き）。
- `commands.useAccessGroups`（デフォルト：`true`）は、コマンドに対して許可リスト／ポリシーを強制します。

## コマンド一覧

テキスト + ネイティブ（有効時）：

- `/help`
- `/commands`
- `/skill <name> [input]`（名前で skill を実行）
- `/status`（現在のステータスを表示。利用可能な場合、現在のモデルプロバイダーの使用量／クォータを含む）
- `/allowlist`（許可リストエントリの一覧／追加／削除）
- `/approve <id> allow-once|allow-always|deny`（実行承認プロンプトを解決）
- `/context [list|detail|json]`（「context」を説明。`detail` はファイル別＋ツール別＋skill 別＋システムプロンプトサイズを表示）
- `/whoami`（送信者 ID を表示。エイリアス：`/id`）
- `/subagents list|stop|log|info|send`（現在のセッションにおけるサブエージェント実行の検査／停止／ログ表示／メッセージ送信）
- `/config show|get|set|unset`（設定をディスクに永続化。オーナー専用。`commands.config: true` が必要）
- `/debug show|set|unset|reset`（ランタイム上書き。オーナー専用。`commands.debug: true` が必要）
- `/usage off|tokens|full|cost`（レスポンスごとの使用量フッター、またはローカルコスト要約）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio`（TTS を制御。[/tts](/tts) を参照）
  - Discord：ネイティブコマンドは `/voice`（Discord は `/tts` を予約）。テキストの `/tts` も引き続き動作します。
- `/stop`
- `/restart`
- `/dock-telegram`（エイリアス：`/dock_telegram`）（返信先を Telegram に切り替え）
- `/dock-discord`（エイリアス：`/dock_discord`）（返信先を Discord に切り替え）
- `/dock-slack`（エイリアス：`/dock_slack`）（返信先を Slack に切り替え）
- `/activation mention|always`（グループのみ）
- `/send on|off|inherit`（オーナー専用）
- `/reset` または `/new [model]`（任意のモデルヒント。残りはそのまま渡されます）
- `/think <off|minimal|low|medium|high|xhigh>`（モデル／プロバイダーによる動的選択。エイリアス：`/thinking`、`/t`）
- `/verbose on|full|off`（エイリアス：`/v`）
- `/reasoning on|off|stream`（エイリアス：`/reason`。オンの場合、`Reasoning:` をプレフィックスとする別メッセージを送信。`stream`＝Telegram の下書きのみ）
- `/elevated on|off|ask|full`（エイリアス：`/elev`。`full` は実行承認をスキップ）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（現在の状態を表示するには `/exec` を送信）
- `/model <name>`（エイリアス：`/models`。または `agents.defaults.models.*.alias` から `/<alias>`）
- `/queue <mode>`（`debounce:2s cap:25 drop:summarize` などのオプション付き。現在の設定を確認するには `/queue` を送信）
- `/bash <command>`（ホスト専用。`! <command>` のエイリアス。`commands.bash: true`＋`tools.elevated` の許可リストが必要）

テキストのみ：

- `/compact [instructions]`（[/concepts/compaction](/concepts/compaction) を参照）
- `! <command>`（ホスト専用。一度に 1 つ。長時間ジョブには `!poll`＋`!stop` を使用）
- `!poll`（出力／ステータスを確認。任意の `sessionId` を受け付けます。`/bash poll` も動作）
- `!stop`（実行中の bash ジョブを停止。任意の `sessionId` を受け付けます。`/bash stop` も動作）

注記：

- コマンドは、コマンドと引数の間に任意で `:` を受け付けます（例：`/think: high`、`/send: on`、`/help:`）。
- `/new <model>` は、モデルエイリアス、`provider/model`、またはプロバイダー名（あいまい一致）を受け付けます。一致しない場合、テキストはメッセージ本文として扱われます。
- プロバイダー使用量の完全な内訳を確認するには `openclaw status --usage` を使用してください。
- `/allowlist add|remove` には `commands.config=true` が必要で、チャンネルの `configWrites` を尊重します。
- `/usage` はレスポンスごとの使用量フッターを制御します。`/usage cost` は OpenClaw セッションログからローカルコスト要約を出力します。
- `/restart` はデフォルトで無効です。有効にするには `commands.restart: true` を設定してください。
- `/verbose` はデバッグや可視性向上を目的としています。通常利用では **オフ** にしてください。
- `/reasoning`（および `/verbose`）はグループ環境では危険です。意図しない内部推論やツール出力を公開する可能性があります。特にグループチャットではオフのままにすることを推奨します。 それらを離れることを好みます, 特にグループチャットで.
- **高速パス：** 許可リストに含まれる送信者からのコマンドのみのメッセージは、即時に処理されます（キュー＋モデルをバイパス）。
- **グループメンションのゲーティング：** 許可リストに含まれる送信者からのコマンドのみのメッセージは、メンション要件をバイパスします。
- **インラインショートカット（許可リストの送信者のみ）：** 一部のコマンドは通常メッセージ内に埋め込んでも動作し、モデルが残りのテキストを見る前に取り除かれます。
  - 例：`hey /status` はステータス返信をトリガーし、残りのテキストは通常フローで処理されます。
- 現在対応：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
- 未許可のコマンドのみのメッセージは黙って無視され、インラインの `/...` トークンはプレーンテキストとして扱われます。
- **Skill コマンド：** `user-invocable` の skill はスラッシュコマンドとして公開されます。名前は `a-z0-9_`（最大 32 文字）に正規化され、衝突した場合は数値サフィックスが付きます（例：`_2`）。 名前は `a-z0-9_` (最大 32 文字)にサニタイズされます。衝突は数字のサフィックスを取得します(例えば `_2`)。
  - `/skill <name> [input]` は名前で skill を実行します（ネイティブコマンドの制限により skill ごとのコマンドを作成できない場合に有用）。
  - デフォルトでは、skill コマンドは通常のリクエストとしてモデルに転送されます。
  - Skill は、コマンドをツールに直接ルーティングするための `command-dispatch: tool` を任意で宣言できます（決定論的、モデル不使用）。
  - 例：`/prose`（OpenProse プラグイン）— [OpenProse](/prose) を参照。
- **ネイティブコマンドの引数：** Discord は動的オプションに対してオートコンプリートを使用します（必須引数を省略した場合はボタンメニュー）。Telegram と Slack では、選択肢をサポートするコマンドで引数を省略するとボタンメニューが表示されます。 コマンドが選択肢をサポートし、argを省略すると、TelegramとSlackにボタンメニューが表示されます。

## 使用サーフェス（どこに何が表示されるか）

- **プロバイダー使用量／クォータ**（例：「Claude 残り 80%」）は、使用量追跡が有効な場合、現在のモデルプロバイダーについて `/status` に表示されます。
- **レスポンスごとのトークン／コスト**は `/usage off|tokens|full` によって制御されます（通常の返信に付加）。
- `/model status` は、使用量ではなく **モデル／認証／エンドポイント** に関するものです。

## モデル選択（`/model`）

`/model` は directive として実装されています。

例：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

注記：

- `/model` と `/model list` は、コンパクトな番号付きピッカー（モデルファミリー＋利用可能なプロバイダー）を表示します。
- `/model <#>` は、そのピッカーから選択します（可能な場合は現在のプロバイダーを優先）。
- `/model status` は、設定されたプロバイダーエンドポイント（`baseUrl`）や API モード（`api`）を含む詳細表示を行います。

## デバッグ用上書き

`/debug` を使用すると、**ランタイムのみ** の設定上書きを行えます（メモリのみ、ディスクには書き込みません）。オーナー専用です。デフォルトでは無効で、`commands.debug: true` により有効化します。 所有者のみ デフォルトでは無効です。`commands.debug: true` で有効にします。

例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注記：

- 上書きは新しい設定読み取りに即時反映されますが、`openclaw.json` には **書き込まれません**。
- すべての上書きをクリアしてディスク上の設定に戻すには `/debug reset` を使用してください。

## 設定更新

`/config` は、ディスク上の設定（`openclaw.json`）に書き込みます。オーナー専用です。デフォルトでは無効で、`commands.config: true` により有効化します。 所有者のみ デフォルトでは無効です。`commands.config: true` で有効にします。

例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注記：

- 書き込み前に設定が検証されます。無効な変更は拒否されます。
- `/config` による更新は再起動後も保持されます。

## サーフェスに関する注記

- **テキストコマンド** は通常のチャットセッションで実行されます（ダイレクトメッセージは `main` を共有し、グループは独自のセッションを持ちます）。
- **ネイティブコマンド** は分離されたセッションを使用します：
  - Discord：`agent:<agentId>:discord:slash:<userId>`
  - Slack：`agent:<agentId>:slack:slash:<userId>`（プレフィックスは `channels.slack.slashCommand.sessionPrefix` で設定可能）
  - Telegram：`telegram:slash:<userId>`（`CommandTargetSessionKey` によりチャットセッションを対象）
- **`/stop`** はアクティブなチャットセッションを対象とし、現在の実行を中断できます。
- **Slack：** `channels.slack.slashCommand` は、単一の `/openclaw` スタイルのコマンドについて引き続きサポートされます。`commands.native` を有効にした場合、組み込みコマンドごとに 1 つの Slack スラッシュコマンドを作成する必要があります（名前は `/help` と同一）。Slack 向けのコマンド引数メニューは、エフェメラルな Block Kit ボタンとして提供されます。 `commands.native` を有効にする場合、組み込みコマンドごとにスラッシュコマンドを1つ作成する必要があります (`/help` と同じ名前)。 Slackのコマンド引数メニューは、一時的なBlock Kitボタンとして提供されます。
