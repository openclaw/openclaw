---
summary: "スラッシュコマンド: テキスト対ネイティブ、設定、サポートされるコマンド"
read_when:
  - チャットコマンドの使用または設定
  - コマンドルーティングまたはパーミッションのデバッグ
title: "スラッシュコマンド"
---

# スラッシュコマンド

コマンドは Gateway によって処理されます。ほとんどのコマンドは `/` で始まる**スタンドアロン**メッセージとして送信する必要があります。
ホスト専用の bash チャットコマンドは `! <cmd>` を使用します（`/bash <cmd>` はエイリアスです）。

2 つの関連するシステムがあります:

- **コマンド**: スタンドアロンの `/...` メッセージ。
- **ディレクティブ**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`。
  - ディレクティブはモデルがメッセージを見る前にメッセージから削除されます。
  - 通常のチャットメッセージ（ディレクティブのみでない）では、「インラインヒント」として扱われ、セッション設定を**永続化しません**。
  - ディレクティブのみのメッセージ（メッセージにディレクティブのみが含まれる）では、セッションに永続化され、確認応答で返信します。
  - ディレクティブは**認証済み送信者**にのみ適用されます。`commands.allowFrom` が設定されている場合、それが唯一のアローリストとして使用されます。設定されていない場合、認証はチャンネルアローリスト・ペアリングおよび `commands.useAccessGroups` から得られます。
    未認証の送信者にはディレクティブがプレーンテキストとして扱われます。

また、いくつかの**インラインショートカット**もあります（アローリスト・認証済み送信者のみ）: `/help`, `/commands`, `/status`, `/whoami`（`/id`）。
これらはすぐに実行され、モデルがメッセージを見る前に削除され、残りのテキストは通常のフローで続行されます。

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
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text`（デフォルト `true`）はチャットメッセージの `/...` の解析を有効化します。
  - ネイティブコマンドがないサーフェス（WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams）では、これを `false` に設定してもテキストコマンドは引き続き機能します。
- `commands.native`（デフォルト `"auto"`）はネイティブコマンドを登録します。
  - Auto: Discord/Telegram では有効; Slack では無効（スラッシュコマンドを追加するまで）; ネイティブサポートのないプロバイダーでは無視されます。
  - プロバイダーごとに上書きするには `channels.discord.commands.native`、`channels.telegram.commands.native`、または `channels.slack.commands.native` を設定してください（bool または `"auto"`）。
  - `false` は起動時に Discord/Telegram の登録済みコマンドをクリアします。Slack のコマンドは Slack アプリで管理されており、自動的に削除されません。
- `commands.nativeSkills`（デフォルト `"auto"`）はサポートされている場合に**スキル**コマンドをネイティブで登録します。
  - Auto: Discord/Telegram では有効; Slack では無効（Slack ではスキルごとにスラッシュコマンドの作成が必要）。
  - プロバイダーごとに上書きするには `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills`、または `channels.slack.commands.nativeSkills` を設定してください（bool または `"auto"`）。
- `commands.bash`（デフォルト `false`）はホストシェルコマンドを実行するための `! <cmd>` を有効化します（`/bash <cmd>` はエイリアス; `tools.elevated` アローリストが必要）。
- `commands.bashForegroundMs`（デフォルト `2000`）はバックグラウンドモードに切り替える前に bash が待機する時間を制御します（`0` は即座にバックグラウンドに移行します）。
- `commands.config`（デフォルト `false`）は `/config`（`openclaw.json` の読み書き）を有効化します。
- `commands.debug`（デフォルト `false`）は `/debug`（ランタイムのみのオーバーライド）を有効化します。
- `commands.allowFrom`（オプション）はコマンド認証のためのプロバイダーごとのアローリストを設定します。設定されている場合、コマンドとディレクティブの唯一の認証ソースになります（チャンネルアローリスト・ペアリングおよび `commands.useAccessGroups` は無視されます）。グローバルデフォルトには `"*"` を使用; プロバイダー固有のキーで上書きします。
- `commands.useAccessGroups`（デフォルト `true`）は `commands.allowFrom` が設定されていない場合にコマンドのアローリスト・ポリシーを強制します。

## コマンドリスト

テキスト + ネイティブ（有効な場合）:

- `/help`
- `/commands`
- `/skill <name> [input]`（名前でスキルを実行）
- `/status`（現在のステータスを表示; 利用可能な場合は現在のモデルプロバイダーのプロバイダー使用状況・クォータを含む）
- `/allowlist`（アローリストエントリの一覧・追加・削除）
- `/approve <id> allow-once|allow-always|deny`（exec 承認プロンプトを解決）
- `/context [list|detail|json]`（「コンテキスト」の説明; `detail` はファイルごと + ツールごと + スキルごと + システムプロンプトサイズを表示）
- `/export-session [path]`（エイリアス: `/export`）（現在のセッションをフルシステムプロンプト付き HTML にエクスポート）
- `/whoami`（送信者 id を表示; エイリアス: `/id`）
- `/session idle <duration|off>`（フォーカスされたスレッドバインディングの非アクティブ自動アンフォーカスを管理）
- `/session max-age <duration|off>`（フォーカスされたスレッドバインディングのハードマックスエイジ自動アンフォーカスを管理）
- `/subagents list|kill|log|info|send|steer|spawn`（現在のセッションのサブエージェント実行を検査、制御、またはスポーン）
- `/acp spawn|cancel|steer|close|status|set-mode|set|cwd|permissions|timeout|model|reset-options|doctor|install|sessions`（ACP ランタイムセッションを検査・制御）
- `/agents`（このセッションのスレッドバインドエージェントを一覧表示）
- `/focus <target>`（Discord: このスレッド、または新しいスレッドをセッション・サブエージェントターゲットにバインド）
- `/unfocus`（Discord: 現在のスレッドバインディングを削除）
- `/kill <id|#|all>`（このセッションの 1 つまたはすべての実行中のサブエージェントを即座に中止; 確認メッセージなし）
- `/steer <id|#> <message>`（実行中のサブエージェントを即座にステアリング: 可能な場合は実行中に、それ以外は現在の作業を中止してステアリングメッセージで再起動）
- `/tell <id|#> <message>`（`/steer` のエイリアス）
- `/config show|get|set|unset`（設定をディスクに永続化、オーナーのみ; `commands.config: true` が必要）
- `/debug show|set|unset|reset`（ランタイムオーバーライド、オーナーのみ; `commands.debug: true` が必要）
- `/usage off|tokens|full|cost`（レスポンスごとの使用状況フッターまたはローカルコスト概要）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio`（TTS を制御; [/tts](/tts) を参照）
  - Discord: ネイティブコマンドは `/voice`（Discord は `/tts` を予約済み）; テキストの `/tts` は引き続き機能します。
- `/stop`
- `/restart`
- `/dock-telegram`（エイリアス: `/dock_telegram`）（返信を Telegram に切り替え）
- `/dock-discord`（エイリアス: `/dock_discord`）（返信を Discord に切り替え）
- `/dock-slack`（エイリアス: `/dock_slack`）（返信を Slack に切り替え）
- `/activation mention|always`（グループのみ）
- `/send on|off|inherit`（オーナーのみ）
- `/reset` または `/new [model]`（オプションのモデルヒント; 残りはそのまま渡される）
- `/think <off|minimal|low|medium|high|xhigh>`（モデル・プロバイダーによる動的な選択肢; エイリアス: `/thinking`, `/t`）
- `/verbose on|full|off`（エイリアス: `/v`）
- `/reasoning on|off|stream`（エイリアス: `/reason`; on の場合、`Reasoning:` がプレフィックスされた別のメッセージを送信; `stream` = Telegram ドラフトのみ）
- `/elevated on|off|ask|full`（エイリアス: `/elev`; `full` は exec 承認をスキップ）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（`/exec` を送信して現在の設定を表示）
- `/model <name>`（エイリアス: `/models`; または `agents.defaults.models.*.alias` からの `/<alias>`）
- `/queue <mode>`（`debounce:2s cap:25 drop:summarize` などのオプションを含む; `/queue` を送信して現在の設定を表示）
- `/bash <command>`（ホスト専用; `! <command>` のエイリアス; `commands.bash: true` + `tools.elevated` アローリストが必要）

テキストのみ:

- `/compact [instructions]`（[/concepts/compaction](/concepts/compaction) を参照）
- `! <command>`（ホスト専用; 一度に 1 つ; 長時間実行ジョブには `!poll` + `!stop` を使用）
- `!poll`（出力・ステータスを確認; オプションの `sessionId` を受け付ける; `/bash poll` も機能）
- `!stop`（実行中の bash ジョブを停止; オプションの `sessionId` を受け付ける; `/bash stop` も機能）

注意事項:

- コマンドとアーギュメントの間にオプションの `:` を受け付けます（例: `/think: high`、`/send: on`、`/help:`）。
- `/new <model>` はモデルエイリアス、`provider/model`、またはプロバイダー名（ファジーマッチ）を受け付けます。マッチがない場合、テキストはメッセージ本文として扱われます。
- プロバイダーの詳細な使用状況については `openclaw status --usage` を使用してください。
- `/allowlist add|remove` は `commands.config=true` が必要で、チャンネルの `configWrites` を尊重します。
- `/usage` はレスポンスごとの使用状況フッターを制御します。`/usage cost` は OpenClaw セッションログからのローカルコスト概要を出力します。
- `/restart` はデフォルトで有効です。無効化するには `commands.restart: false` を設定してください。
- Discord 専用ネイティブコマンド: `/vc join|leave|status` は音声チャンネルを制御します（`channels.discord.voice` とネイティブコマンドが必要; テキストとしては利用不可）。
- Discord のスレッドバインドコマンド（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`）は有効なスレッドバインディングが必要です（`session.threadBindings.enabled` および/または `channels.discord.threadBindings.enabled`）。
- ACP コマンドリファレンスとランタイム動作: [ACP エージェント](/tools/acp-agents)。
- `/verbose` はデバッグと追加の可視性を目的としています。通常使用では**オフ**にしてください。
- ツール失敗サマリーは関連する場合に引き続き表示されますが、詳細な失敗テキストは `/verbose` が `on` または `full` の場合にのみ含まれます。
- `/reasoning`（および `/verbose`）はグループ設定ではリスクがあります: 意図せず公開したくない内部の推論やツール出力を明らかにする可能性があります。特にグループチャットではオフのままにしてください。
- **ファストパス:** アローリスト済み送信者からのコマンドのみのメッセージは即座に処理されます（キュー + モデルをバイパス）。
- **グループメンション制限:** アローリスト済み送信者からのコマンドのみのメッセージはメンション要件をバイパスします。
- **インラインショートカット（アローリスト済み送信者のみ）:** 一部のコマンドは通常のメッセージに埋め込まれても機能し、モデルが残りのテキストを見る前に削除されます。
  - 例: `hey /status` はステータス返信をトリガーし、残りのテキストは通常のフローで続行されます。
- 現在: `/help`、`/commands`、`/status`、`/whoami`（`/id`）。
- 未認証のコマンドのみのメッセージはサイレントに無視され、インラインの `/...` トークンはプレーンテキストとして扱われます。
- **スキルコマンド:** `user-invocable` スキルはスラッシュコマンドとして公開されます。名前は `a-z0-9_` にサニタイズされます（最大 32 文字）; 衝突には数値サフィックスが付きます（例: `_2`）。
  - `/skill <name> [input]` は名前でスキルを実行します（ネイティブコマンドの制限によりスキルごとのコマンドが使えない場合に便利）。
  - デフォルトでは、スキルコマンドは通常のリクエストとしてモデルに転送されます。
  - スキルはオプションで `command-dispatch: tool` を宣言してコマンドをツールに直接ルーティングできます（決定論的、モデルなし）。
  - 例: `/prose`（OpenProse プラグイン）— [OpenProse](/prose) を参照。
- **ネイティブコマンドアーギュメント:** Discord は動的オプションにオートコンプリートを使用します（必須アーギュメントを省略するとボタンメニューも表示されます）。Telegram と Slack は、コマンドが選択肢をサポートしてアーギュメントを省略した場合にボタンメニューを表示します。

## 使用サーフェス（何がどこに表示されるか）

- **プロバイダーの使用状況・クォータ**（例: 「Claude 80% left」）は使用状況追跡が有効な場合、現在のモデルプロバイダーの `/status` に表示されます。
- **レスポンスごとのトークン・コスト**は `/usage off|tokens|full`（通常の返信に追加）によって制御されます。
- `/model status` は使用状況ではなく**モデル・認証・エンドポイント**に関するものです。

## モデル選択（`/model`）

`/model` はディレクティブとして実装されています。

例:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

注意事項:

- `/model` と `/model list` はコンパクトな番号付きピッカーを表示します（モデルファミリー + 利用可能なプロバイダー）。
- Discord では、`/model` と `/models` はプロバイダーとモデルのドロップダウンと送信ステップを持つインタラクティブなピッカーを開きます。
- `/model <#>` はそのピッカーから選択します（可能な場合は現在のプロバイダーを優先）。
- `/model status` は設定済みのプロバイダーエンドポイント（`baseUrl`）と API モード（`api`）を含む詳細ビューを表示します（利用可能な場合）。

## デバッグオーバーライド

`/debug` を使用すると**ランタイムのみ**の設定オーバーライドを設定できます（メモリ、ディスクではありません）。オーナーのみ。デフォルトでは無効; `commands.debug: true` で有効化します。

例:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注意事項:

- オーバーライドは新しい設定読み取りに即座に適用されますが、`openclaw.json` には**書き込まれません**。
- `/debug reset` を使用してすべてのオーバーライドをクリアしてディスク上の設定に戻します。

## 設定の更新

`/config` はディスク上の設定（`openclaw.json`）に書き込みます。オーナーのみ。デフォルトでは無効; `commands.config: true` で有効化します。

例:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意事項:

- 設定は書き込み前に検証されます; 無効な変更は拒否されます。
- `/config` の更新は再起動後も永続します。

## サーフェスに関する注意事項

- **テキストコマンド**は通常のチャットセッションで実行されます（DM は `main` を共有し、グループは独自のセッションを持ちます）。
- **ネイティブコマンド**は分離されたセッションを使用します:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>`（`channels.slack.slashCommand.sessionPrefix` で設定可能なプレフィックス）
  - Telegram: `telegram:slash:<userId>`（`CommandTargetSessionKey` 経由でチャットセッションをターゲット）
- **`/stop`** は現在の実行を中止できるように、アクティブなチャットセッションをターゲットにします。
- **Slack:** `channels.slack.slashCommand` は単一の `/openclaw` スタイルコマンドに引き続き対応しています。`commands.native` を有効にする場合は、組み込みコマンドごとに 1 つの Slack スラッシュコマンドを作成する必要があります（`/help` と同じ名前）。Slack のコマンドアーギュメントメニューはエフェメラルな Block Kit ボタンとして配信されます。
  - Slack ネイティブの例外: Slack が `/status` を予約しているため、`/agentstatus`（`/status` ではなく）を登録してください。テキストの `/status` は Slack メッセージで引き続き機能します。
