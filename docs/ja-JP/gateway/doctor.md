---
summary: "Doctor コマンド: ヘルスチェック、設定マイグレーション、修復手順"
read_when:
  - Doctor マイグレーションの追加・変更時
  - 破壊的な設定変更の導入時
title: "Doctor"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: bdad9b6853d3ff8f2fdd255310c45d4910b106579df79b422bdaf04a3e7e468e
    source_path: gateway/doctor.md
    workflow: 15
---

# Doctor

`openclaw doctor` は OpenClaw の修復・マイグレーションツールです。古い設定やステートを修正し、ヘルスチェックを実行し、修復手順を提供します。

## クイックスタート

```bash
openclaw doctor
```

### ヘッドレス / 自動化

```bash
openclaw doctor --yes
```

プロンプトなしでデフォルトを受け入れます（再起動・サービス・サンドボックス修復手順が該当する場合も含む）。

```bash
openclaw doctor --repair
```

プロンプトなしで推奨修復を適用します（安全な箇所では修復と再起動を実行）。

```bash
openclaw doctor --repair --force
```

積極的な修復も適用します（カスタムスーパーバイザー設定を上書き）。

```bash
openclaw doctor --non-interactive
```

プロンプトなしで実行し、安全なマイグレーションのみ適用します（設定の正規化とディスク上のステート移動）。人間の確認が必要な再起動・サービス・サンドボックスのアクションはスキップされます。
レガシーステートのマイグレーションは検出時に自動実行されます。

```bash
openclaw doctor --deep
```

追加の Gateway ゲートウェイインストールのシステムサービスをスキャンします（launchd/systemd/schtasks）。

変更を書き込む前に確認したい場合は、先に設定ファイルを開いてください：

```bash
cat ~/.openclaw/openclaw.json
```

## 実行内容（概要）

- git インストールのオプション事前更新（対話モードのみ）。
- UI プロトコルの最新性チェック（プロトコルスキーマが新しい場合に Control UI を再ビルド）。
- ヘルスチェックと再起動プロンプト。
- スキルのステータス概要（対象可能/不足/ブロック）とプラグインのステータス。
- レガシー値の設定正規化。
- レガシー Chrome 拡張機能設定と Chrome MCP 準備のブラウザーマイグレーションチェック。
- OpenCode プロバイダーオーバーライドの警告（`models.providers.opencode` / `models.providers.opencode-go`）。
- OpenAI Codex OAuth プロファイルの OAuth TLS 前提条件チェック。
- レガシーディスク上ステートのマイグレーション（セッション/エージェントディレクトリ/WhatsApp 認証）。
- レガシープラグインマニフェストのコントラクトキーマイグレーション（`speechProviders`、`mediaUnderstandingProviders`、`imageGenerationProviders` → `contracts`）。
- レガシー cron ストアのマイグレーション（`jobId`、`schedule.cron`、トップレベルの配信/ペイロードフィールド、ペイロード `provider`、シンプルな `notify: true` Webhook フォールバックジョブ）。
- セッションロックファイルの検査と古いロックのクリーンアップ。
- ステートの整合性とパーミッションチェック（セッション、トランスクリプト、ステートディレクトリ）。
- 設定ファイルのパーミッションチェック（chmod 600、ローカル実行時）。
- モデル認証のヘルス: OAuth 有効期限の確認、期限切れトークンの更新、認証プロファイルのクールダウン/無効化ステートの報告。
- 追加ワークスペースディレクトリの検出（`~/openclaw`）。
- サンドボックスが有効な場合のサンドボックスイメージ修復。
- レガシーサービスマイグレーションと追加 Gateway ゲートウェイの検出。
- Matrix チャンネルのレガシーステートマイグレーション（`--fix` / `--repair` モード）。
- Gateway ゲートウェイランタイムチェック（サービスがインストール済みだが未起動; キャッシュされた launchd ラベル）。
- チャンネルステータスの警告（実行中の Gateway ゲートウェイからプローブ）。
- スーパーバイザー設定の監査（launchd/systemd/schtasks）とオプションの修復。
- Gateway ゲートウェイランタイムのベストプラクティスチェック（Node と Bun、バージョンマネージャーパス）。
- Gateway ゲートウェイポート衝突の診断（デフォルト `18789`）。
- オープン DM ポリシーのセキュリティ警告。
- ローカルトークンモードの Gateway ゲートウェイ認証チェック（トークンソースが存在しない場合のトークン生成を提案; トークン SecretRef 設定は上書きしない）。
- Linux での systemd linger チェック。
- ワークスペースブートストラップファイルのサイズチェック（コンテキストファイルの切り詰め/上限近辺の警告）。
- シェル補完のステータスチェックと自動インストール/アップグレード。
- メモリ検索エンベッディングプロバイダーの準備チェック（ローカルモデル、リモート API キー、QMD バイナリ）。
- ソースインストールのチェック（pnpm ワークスペースの不一致、UI アセットの不足、tsx バイナリの不足）。
- 更新された設定とウィザードメタデータの書き込み。

## 詳細な動作と根拠

### 0) オプション更新（git インストール）

git チェックアウトで doctor が対話モードで実行されている場合、doctor を実行する前に更新（fetch/rebase/build）を提案します。

### 1) 設定の正規化

設定にレガシーな値の形式が含まれている場合（例: チャンネル固有のオーバーライドなしの `messages.ackReaction`）、doctor はそれらを現在のスキーマに正規化します。

### 2) レガシー設定キーのマイグレーション

設定に非推奨のキーが含まれている場合、他のコマンドの実行が拒否され、`openclaw doctor` を実行するよう求められます。

Doctor は以下を実行します：

- 見つかったレガシーキーを説明。
- 適用したマイグレーションを表示。
- 更新されたスキーマで `~/.openclaw/openclaw.json` を書き直す。

Gateway ゲートウェイはスタートアップ時にレガシー設定フォーマットを検出すると doctor マイグレーションを自動実行するため、古い設定は手動介入なしに修復されます。
Cron ジョブストアのマイグレーションは `openclaw doctor --fix` で処理されます。

現在のマイグレーション：

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → トップレベル `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `messages.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `messages.tts.providers.<provider>`
- `channels.discord.voice.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `channels.discord.voice.tts.providers.<provider>`
- `channels.discord.accounts.<id>.voice.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `channels.discord.accounts.<id>.voice.tts.providers.<provider>`
- `plugins.entries.voice-call.config.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `plugins.entries.voice-call.config.tts.providers.<provider>`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- 名前付き `accounts` があるが `accounts.default` がないチャンネルでは、チャンネルスコープのトップレベル単一アカウントチャンネル値を、存在する場合は `channels.<channel>.accounts.default` に移動
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*`（tools/elevated/exec/sandbox/subagents）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`
- `browser.ssrfPolicy.allowPrivateNetwork` → `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`
- `browser.profiles.*.driver: "extension"` → `"existing-session"`
- `browser.relayBindHost` を削除（レガシー拡張機能リレー設定）

Doctor の警告にはマルチアカウントチャンネルのアカウントデフォルトガイダンスも含まれます：

- 2つ以上の `channels.<channel>.accounts` エントリが `channels.<channel>.defaultAccount` や `accounts.default` なしで設定されている場合、doctor はフォールバックルーティングが予期しないアカウントを選ぶ可能性があると警告します。
- `channels.<channel>.defaultAccount` が不明なアカウント ID に設定されている場合、doctor は警告し、設定済みアカウント ID を一覧表示します。

### 2b) OpenCode プロバイダーオーバーライド

`models.providers.opencode`、`opencode-zen`、または `opencode-go` を手動で追加している場合、`@mariozechner/pi-ai` からの組み込み OpenCode カタログが上書きされます。これにより、モデルが誤った API に強制されたり、コストがゼロになる可能性があります。Doctor はオーバーライドを削除してモデルごとの API ルーティングとコストを復元できるよう警告します。

### 2c) ブラウザーマイグレーションと Chrome MCP 準備

ブラウザー設定が削除済みの Chrome 拡張機能パスを指している場合、doctor は現在のホストローカル Chrome MCP アタッチモデルに正規化します：

- `browser.profiles.*.driver: "extension"` が `"existing-session"` になる
- `browser.relayBindHost` が削除される

Doctor は `defaultProfile: "user"` または設定済みの `existing-session` プロファイルを使用している場合、ホストローカル Chrome MCP パスも監査します：

- デフォルトの自動接続プロファイルに Google Chrome が同じホストにインストールされているかチェック
- 検出された Chrome バージョンを確認し、Chrome 144 未満の場合に警告
- ブラウザーインスペクトページでリモートデバッグを有効にするよう提示（例: `chrome://inspect/#remote-debugging`、`brave://inspect/#remote-debugging`、または `edge://inspect/#remote-debugging`）

Doctor は Chrome 側の設定を有効にすることはできません。ホストローカル Chrome MCP には以下が必要です：

- Gateway ゲートウェイ/ノードホスト上の Chromium ベースブラウザー 144 以上
- ローカルで実行中のブラウザー
- そのブラウザーでリモートデバッグが有効
- ブラウザーで最初のアタッチ同意プロンプトを承認

このチェックは Docker、サンドボックス、リモートブラウザー、その他のヘッドレスフローには**適用されません**。それらは引き続き生の CDP を使用します。

### 2d) OAuth TLS 前提条件

OpenAI Codex OAuth プロファイルが設定されている場合、doctor はローカルの Node/OpenSSL TLS スタックが証明書チェーンを検証できるか確認するため、OpenAI 認証エンドポイントをプローブします。プローブが証明書エラー（例: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`、期限切れ証明書、自己署名証明書）で失敗した場合、doctor はプラットフォーム固有の修正ガイダンスを表示します。Homebrew Node を使用した macOS では、通常 `brew postinstall ca-certificates` が修正方法です。`--deep` を指定すると、Gateway ゲートウェイが正常であっても、プローブが実行されます。

### 3) レガシーステートのマイグレーション（ディスクレイアウト）

Doctor は古いディスクレイアウトを現在の構造にマイグレーションできます：

- セッションストアとトランスクリプト：
  - `~/.openclaw/sessions/` から `~/.openclaw/agents/<agentId>/sessions/` へ
- エージェントディレクトリ：
  - `~/.openclaw/agent/` から `~/.openclaw/agents/<agentId>/agent/` へ
- WhatsApp 認証ステート（Baileys）：
  - レガシーの `~/.openclaw/credentials/*.json`（`oauth.json` を除く）から
  - `~/.openclaw/credentials/whatsapp/<accountId>/...` へ（デフォルトアカウント ID: `default`）

これらのマイグレーションはベストエフォートで冪等です。レガシーフォルダーをバックアップとして残す場合、doctor は警告を出します。Gateway ゲートウェイ/CLI はスタートアップ時にレガシーセッションとエージェントディレクトリも自動マイグレーションするため、手動で doctor を実行しなくても履歴/認証/モデルがエージェントごとのパスに移動します。WhatsApp 認証は意図的に `openclaw doctor` 経由でのみマイグレーションされます。

### 3a) レガシープラグインマニフェストのマイグレーション

Doctor はインストール済みのすべてのプラグインマニフェストで非推奨のトップレベルケーパビリティキー（`speechProviders`、`mediaUnderstandingProviders`、`imageGenerationProviders`）をスキャンします。見つかった場合、それらを `contracts` オブジェクトに移動してマニフェストファイルをその場で書き直すことを提案します。このマイグレーションは冪等です。`contracts` キーにすでに同じ値がある場合、レガシーキーはデータを重複させることなく削除されます。

### 3b) レガシー cron ストアのマイグレーション

Doctor は cron ジョブストア（デフォルトでは `~/.openclaw/cron/jobs.json`、またはオーバーライド時は `cron.store`）で、スケジューラーが互換性のために受け入れている古いジョブ形式もチェックします。

現在の cron クリーンアップには以下が含まれます：

- `jobId` → `id`
- `schedule.cron` → `schedule.expr`
- トップレベルのペイロードフィールド（`message`、`model`、`thinking` など）→ `payload`
- トップレベルの配信フィールド（`deliver`、`channel`、`to`、`provider` など）→ `delivery`
- ペイロード `provider` 配信エイリアス → 明示的な `delivery.channel`
- シンプルなレガシー `notify: true` Webhook フォールバックジョブ → 明示的な `delivery.mode="webhook"` と `delivery.to=cron.webhook`

Doctor は動作を変更せずにマイグレーションできる場合のみ `notify: true` ジョブを自動マイグレーションします。既存の非 Webhook 配信モードを持つレガシー notify フォールバックと組み合わせたジョブがある場合、doctor は警告を出してそのジョブを手動確認のために残します。

### 3c) セッションロックのクリーンアップ

Doctor はすべてのエージェントセッションディレクトリで古い書き込みロックファイル（セッションが異常終了したときに残されたファイル）をスキャンします。見つかったロックファイルごとに、パス、PID、PID がまだ生存しているか、ロックの経過時間、および古くなっているか（死んだ PID または 30 分以上経過）を報告します。`--fix` / `--repair` モードでは古いロックファイルを自動削除します。それ以外の場合は、メモを出力して `--fix` で再実行するよう指示します。

### 4) ステートの整合性チェック（セッション永続性、ルーティング、安全性）

ステートディレクトリは運用の中枢です。消えてしまうと、セッション、認証情報、ログ、設定が失われます（他にバックアップがない限り）。

Doctor がチェックする項目：

- **ステートディレクトリが見つからない**: 壊滅的なステート損失について警告し、ディレクトリの再作成を促し、失われたデータを回復できないことを通知します。
- **ステートディレクトリのパーミッション**: 書き込み可能かを確認し、パーミッションの修復を提案します（所有者/グループの不一致が検出された場合は `chown` のヒントを出します）。
- **macOS クラウド同期ステートディレクトリ**: ステートが iCloud Drive（`~/Library/Mobile Documents/com~apple~CloudDocs/...`）または `~/Library/CloudStorage/...` の下に解決される場合に警告します。同期バックアップされたパスはより遅い I/O やロック/同期の競合を引き起こす可能性があります。
- **Linux SD または eMMC ステートディレクトリ**: ステートが `mmcblk*` マウントソースに解決される場合に警告します。SD または eMMC バックアップのランダム I/O はセッションや認証情報の書き込みに対して遅く、消耗が早い可能性があります。
- **セッションディレクトリが見つからない**: `sessions/` とセッションストアディレクトリは履歴を永続化し `ENOENT` クラッシュを避けるために必要です。
- **トランスクリプトの不一致**: 最近のセッションエントリにトランスクリプトファイルが見つからない場合に警告します。
- **メインセッション「1行 JSONL」**: メイントランスクリプトが1行しかない場合にフラグを立てます（履歴が蓄積されていない）。
- **複数のステートディレクトリ**: ホームディレクトリ間に複数の `~/.openclaw` フォルダーが存在する場合、または `OPENCLAW_STATE_DIR` が別の場所を指している場合に警告します（インストール間で履歴が分割される可能性があります）。
- **リモートモードのリマインダー**: `gateway.mode=remote` の場合、doctor はリモートホスト上で実行するよう提示します（ステートはそこにあります）。
- **設定ファイルのパーミッション**: `~/.openclaw/openclaw.json` がグループ/全員が読み取り可能な場合に警告し、`600` への変更を提案します。

### 5) モデル認証のヘルス（OAuth 有効期限）

Doctor は認証ストアの OAuth プロファイルを検査し、トークンが期限切れ/期限切れ間近の場合に警告し、安全な場合はトークンを更新できます。Anthropic Claude Code プロファイルが古い場合、`claude setup-token` の実行（またはセットアップトークンの貼り付け）を提案します。更新プロンプトは対話モード（TTY）の場合のみ表示されます。`--non-interactive` では更新の試みをスキップします。

Doctor は一時的に使用できない認証プロファイルも報告します：

- 短いクールダウン（レート制限/タイムアウト/認証失敗）
- 長時間の無効化（課金/クレジット失敗）

### 6) フックモデルの検証

`hooks.gmail.model` が設定されている場合、doctor はカタログと許可リストに対してモデル参照を検証し、解決できないまたは許可されていない場合に警告します。

### 7) サンドボックスイメージの修復

サンドボックスが有効な場合、doctor は Docker イメージをチェックし、現在のイメージが見つからない場合はビルドするか、レガシー名に切り替えることを提案します。

### 7b) バンドルプラグインランタイム依存関係

Doctor はバンドルプラグインのランタイム依存関係（例: Discord プラグインのランタイムパッケージ）が OpenClaw インストールルートに存在するかを確認します。不足している場合、doctor はパッケージを報告し、`openclaw doctor --fix` / `openclaw doctor --repair` モードでインストールします。

### 8) Gateway ゲートウェイサービスのマイグレーションとクリーンアップのヒント

Doctor はレガシー Gateway ゲートウェイサービス（launchd/systemd/schtasks）を検出し、それらを削除して現在の Gateway ゲートウェイポートを使用する OpenClaw サービスをインストールすることを提案します。追加の Gateway ゲートウェイ的なサービスをスキャンしてクリーンアップのヒントを出すこともできます。プロファイル名付きの OpenClaw Gateway ゲートウェイサービスは一等市民として扱われ、「追加」としてフラグ立てされません。

### 8b) スタートアップ Matrix マイグレーション

Matrix チャンネルアカウントに保留中または実行可能なレガシーステートマイグレーションがある場合、doctor は（`--fix` / `--repair` モードで）事前マイグレーションスナップショットを作成し、ベストエフォートのマイグレーション手順を実行します：レガシー Matrix ステートマイグレーションとレガシー暗号化ステートの準備。両方の手順は非致命的です。エラーはログに記録されてスタートアップは継続されます。読み取り専用モード（`--fix` なしの `openclaw doctor`）では、このチェックは完全にスキップされます。

### 9) セキュリティ警告

Doctor は、プロバイダーが許可リストなしで DM に公開されている場合、またはポリシーが危険な方法で設定されている場合に警告を出します。

### 10) systemd linger（Linux）

systemd ユーザーサービスとして実行している場合、doctor はログアウト後も Gateway ゲートウェイが生き続けるように linger が有効になっていることを確認します。

### 11) ワークスペースのステータス（スキル、プラグイン、レガシーディレクトリ）

Doctor はデフォルトエージェントのワークスペースステートの概要を出力します：

- **スキルのステータス**: 対象可能、要件不足、許可リストブロックのスキル数。
- **レガシーワークスペースディレクトリ**: `~/openclaw` またはその他のレガシーワークスペースディレクトリが現在のワークスペースと並んで存在する場合に警告します。
- **プラグインのステータス**: ロード済み/無効/エラーのプラグイン数; エラーがあるプラグイン ID を一覧表示; バンドルプラグインのケーパビリティを報告。
- **プラグイン互換性の警告**: 現在のランタイムと互換性の問題があるプラグインにフラグを立てます。
- **プラグイン診断**: プラグインレジストリによって出力されたロード時の警告またはエラーを表示します。

### 11b) ブートストラップファイルのサイズ

Doctor はワークスペースブートストラップファイル（例: `AGENTS.md`、`CLAUDE.md`、その他の注入されるコンテキストファイル）が設定された文字バジェットの近くや超えていないかをチェックします。ファイルごとの生の文字数と注入済み文字数、切り詰めパーセンテージ、切り詰め原因（`max/file` または `max/total`）、および合計バジェットに対する注入済み文字の割合を報告します。ファイルが切り詰められているか上限に近い場合、doctor は `agents.defaults.bootstrapMaxChars` と `agents.defaults.bootstrapTotalMaxChars` の調整のヒントを出します。

### 11c) シェル補完

Doctor は現在のシェル（zsh、bash、fish、または PowerShell）にタブ補完がインストールされているかをチェックします：

- シェルプロファイルが遅い動的補完パターン（`source <(openclaw completion ...)`）を使用している場合、doctor はより速いキャッシュファイルバリアントにアップグレードします。
- 補完がプロファイルに設定されているがキャッシュファイルが見つからない場合、doctor はキャッシュを自動再生成します。
- 補完がまったく設定されていない場合、doctor はインストールを促します（対話モードのみ; `--non-interactive` ではスキップ）。

キャッシュを手動で再生成するには `openclaw completion --write-state` を実行してください。

### 12) Gateway ゲートウェイ認証チェック（ローカルトークン）

Doctor はローカル Gateway ゲートウェイトークン認証の準備を確認します。

- トークンモードでトークンが必要でトークンソースが存在しない場合、doctor はトークンの生成を提案します。
- `gateway.auth.token` が SecretRef 管理されているが利用できない場合、doctor は警告し、プレーンテキストで上書きしません。
- `openclaw doctor --generate-gateway-token` はトークン SecretRef が設定されていない場合にのみ生成を強制します。

### 12b) 読み取り専用 SecretRef 対応の修復

一部の修復フローでは、ランタイムのフェイルファスト動作を弱めることなく設定済み認証情報を検査する必要があります。

- `openclaw doctor --fix` は、対象の設定修復のためにステータス系コマンドと同じ読み取り専用 SecretRef サマリーモデルを使用するようになりました。
- 例: Telegram の `allowFrom` / `groupAllowFrom` `@username` 修復は、利用可能な場合に設定済み bot 認証情報を使用しようとします。
- Telegram bot トークンが SecretRef 経由で設定されているが現在のコマンドパスで利用できない場合、doctor は認証情報が設定済みだが利用不可であることを報告し、クラッシュしたり、トークンが見つからないと誤報するのではなく、自動解決をスキップします。

### 13) Gateway ゲートウェイのヘルスチェックと再起動

Doctor はヘルスチェックを実行し、Gateway ゲートウェイが不健全に見える場合に再起動を提案します。

### 13b) メモリ検索の準備

Doctor はデフォルトエージェントの設定済みメモリ検索エンベッディングプロバイダーが準備できているかをチェックします。動作は設定済みバックエンドとプロバイダーによって異なります：

- **QMD バックエンド**: `qmd` バイナリが利用可能で起動できるかをプローブします。利用できない場合、npm パッケージと手動バイナリパスオプションを含む修正ガイダンスを表示します。
- **明示的なローカルプロバイダー**: ローカルモデルファイルまたは認識されたリモート/ダウンロード可能なモデル URL をチェックします。見つからない場合、リモートプロバイダーへの切り替えを提案します。
- **明示的なリモートプロバイダー**（`openai`、`voyage` など）: API キーが環境または認証ストアに存在するかを確認します。見つからない場合、実行可能な修正のヒントを表示します。
- **自動プロバイダー**: まずローカルモデルの利用可能性をチェックし、次に自動選択順序で各リモートプロバイダーを試します。

Gateway ゲートウェイのプローブ結果が利用可能な場合（チェック時に Gateway ゲートウェイが正常だった場合）、doctor はその結果を CLI で見える設定と相互参照し、不一致があれば記録します。

エンベッディングの準備をランタイムで確認するには `openclaw memory status --deep` を使用してください。

### 14) チャンネルステータスの警告

Gateway ゲートウェイが正常な場合、doctor はチャンネルステータスプローブを実行し、修正の提案とともに警告を報告します。

### 15) スーパーバイザー設定の監査と修復

Doctor はインストール済みのスーパーバイザー設定（launchd/systemd/schtasks）で不足または古いデフォルト（例: systemd のネットワークオンライン依存関係と再起動遅延）を確認します。不一致が見つかった場合、更新を推奨し、サービスファイル/タスクを現在のデフォルトに書き直すことができます。

注意事項：

- `openclaw doctor` はスーパーバイザー設定を書き直す前にプロンプトを表示します。
- `openclaw doctor --yes` はデフォルトの修復プロンプトを受け入れます。
- `openclaw doctor --repair` はプロンプトなしで推奨修正を適用します。
- `openclaw doctor --repair --force` はカスタムスーパーバイザー設定を上書きします。
- トークン認証でトークンが必要で `gateway.auth.token` が SecretRef 管理されている場合、doctor サービスのインストール/修復は SecretRef を検証しますが、解決されたプレーンテキストトークン値をスーパーバイザーサービスの環境メタデータに保存しません。
- トークン認証でトークンが必要で設定済みトークン SecretRef が未解決の場合、doctor は実行可能なガイダンスとともにインストール/修復パスをブロックします。
- `gateway.auth.token` と `gateway.auth.password` の両方が設定され `gateway.auth.mode` が未設定の場合、doctor はモードが明示的に設定されるまでインストール/修復をブロックします。
- Linux ユーザー systemd ユニットの場合、doctor のトークンドリフトチェックはサービス認証メタデータを比較する際に `Environment=` と `EnvironmentFile=` ソースの両方を含むようになりました。
- `openclaw gateway install --force` で完全な書き直しを強制することもできます。

### 16) Gateway ゲートウェイランタイムとポートの診断

Doctor はサービスランタイム（PID、最後の終了ステータス）を検査し、サービスがインストールされているが実際に実行されていない場合に警告します。また、Gateway ゲートウェイポート（デフォルト `18789`）のポート衝突をチェックし、考えられる原因（Gateway ゲートウェイがすでに実行中、SSH トンネル）を報告します。

### 17) Gateway ゲートウェイランタイムのベストプラクティス

Doctor は Gateway ゲートウェイサービスが Bun またはバージョン管理された Node パス（`nvm`、`fnm`、`volta`、`asdf` など）で実行されている場合に警告します。WhatsApp と Telegram チャンネルは Node が必要で、バージョンマネージャーのパスはサービスがシェル init を読み込まないため、アップグレード後に壊れる可能性があります。Doctor は利用可能な場合にシステム Node インストール（Homebrew/apt/choco）への移行を提案します。

### 18) 設定の書き込みとウィザードメタデータ

Doctor は設定の変更を永続化し、doctor の実行を記録するためにウィザードメタデータをスタンプします。

### 19) ワークスペースのヒント（バックアップとメモリシステム）

Doctor はメモリシステムが見つからない場合にワークスペースメモリシステムを提案し、ワークスペースがまだ git 管理下にない場合はバックアップのヒントを出します。

ワークスペースの構造と git バックアップ（プライベートな GitHub または GitLab を推奨）の完全なガイドは [/concepts/agent-workspace](/concepts/agent-workspace) を参照してください。
