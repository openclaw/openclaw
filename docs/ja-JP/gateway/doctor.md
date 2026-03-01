---
summary: "Doctorコマンド：ヘルスチェック、設定マイグレーション、修復手順"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
title: "Doctor"
---

# Doctor

`openclaw doctor`はOpenClawの修復 + マイグレーションツールです。古い設定/状態を修正し、健全性をチェックし、実行可能な修復手順を提供します。

## クイックスタート

```bash
openclaw doctor
```

### ヘッドレス / 自動化

```bash
openclaw doctor --yes
```

再起動/サービス/サンドボックス修復手順を含め、プロンプトなしでデフォルトを受け入れます。

```bash
openclaw doctor --repair
```

プロンプトなしで推奨修復を適用します（安全な場合は修復 + 再起動）。

```bash
openclaw doctor --repair --force
```

カスタムスーパーバイザー設定を上書きする積極的な修復も適用します。

```bash
openclaw doctor --non-interactive
```

プロンプトなしで実行し、安全なマイグレーション（設定の正規化 + ディスク上の状態移動）のみを適用します。人間の確認が必要な再起動/サービス/サンドボックスアクションはスキップされます。
レガシー状態マイグレーションは検出時に自動的に実行されます。

```bash
openclaw doctor --deep
```

追加のGatewayインストールがないかシステムサービス（launchd/systemd/schtasks）をスキャンします。

変更を書き込む前にレビューしたい場合は、最初に設定ファイルを開きます：

```bash
cat ~/.openclaw/openclaw.json
```

## 動作内容（概要）

- gitインストール用のオプションのプリフライト更新（インタラクティブのみ）。
- UIプロトコルの新鮮さチェック（プロトコルスキーマが新しい場合にコントロールUIを再ビルド）。
- ヘルスチェック + 再起動プロンプト。
- スキルステータスの概要（対象/不足/ブロック）。
- レガシー値の設定正規化。
- OpenCode Zenプロバイダーオーバーライド警告（`models.providers.opencode`）。
- レガシーディスク上の状態マイグレーション（セッション/エージェントディレクトリ/WhatsApp認証）。
- 状態の整合性とパーミッションチェック（セッション、トランスクリプト、状態ディレクトリ）。
- ローカル実行時の設定ファイルパーミッションチェック（chmod 600）。
- モデル認証の健全性：OAuth期限切れをチェックし、期限切れトークンをリフレッシュでき、認証プロファイルのクールダウン/無効状態を報告。
- 追加ワークスペースディレクトリ検出（`~/openclaw`）。
- サンドボックスが有効な場合のサンドボックスイメージ修復。
- レガシーサービスマイグレーションと追加Gateway検出。
- Gatewayランタイムチェック（サービスはインストールされているが実行されていない、キャッシュされたlaunchdラベル）。
- チャンネルステータス警告（実行中のGatewayからプローブ）。
- スーパーバイザー設定監査（launchd/systemd/schtasks）とオプションの修復。
- Gatewayランタイムベストプラクティスチェック（Node vs Bun、バージョンマネージャーパス）。
- Gatewayポート衝突診断（デフォルト`18789`）。
- オープンDMポリシーのセキュリティ警告。
- `gateway.auth.token`が設定されていない場合のGateway認証警告（ローカルモード、トークン生成を提案）。
- Linuxでのsystemd lingerチェック。
- ソースインストールチェック（pnpmワークスペースの不一致、UIアセットの不足、tsxバイナリの不足）。
- 更新された設定 + ウィザードメタデータの書き込み。

## 詳細な動作と根拠

### 0) オプション更新（gitインストール）

gitチェックアウトでdoctorがインタラクティブに実行されている場合、doctorを実行する前に更新（fetch/rebase/build）を提案します。

### 1) 設定正規化

設定にレガシーの値形状が含まれている場合（例：チャンネル固有のオーバーライドなしの`messages.ackReaction`）、doctorはそれらを現在のスキーマに正規化します。

### 2) レガシー設定キーのマイグレーション

設定に非推奨のキーが含まれている場合、他のコマンドは実行を拒否し、`openclaw doctor`の実行を求めます。

Doctorは以下を行います：

- どのレガシーキーが見つかったかを説明。
- 適用したマイグレーションを表示。
- 更新されたスキーマで`~/.openclaw/openclaw.json`を書き換え。

Gatewayもレガシー設定フォーマットを検出した場合、起動時にdoctorマイグレーションを自動実行するため、手動介入なしに古い設定が修復されます。

現在のマイグレーション：

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → トップレベル`bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- 名前付き`accounts`があるが`accounts.default`がないチャンネルの場合、アカウントスコープのトップレベルの単一アカウントチャンネル値を`channels.<channel>.accounts.default`に移動
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*`（tools/elevated/exec/sandbox/subagents）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks` → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`
- `browser.ssrfPolicy.allowPrivateNetwork` → `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`

### 2b) OpenCode Zenプロバイダーオーバーライド

`models.providers.opencode`（または`opencode-zen`）を手動で追加した場合、`@mariozechner/pi-ai`の組み込みOpenCode Zenカタログを上書きします。これにより、すべてのモデルが単一のAPIに強制されたり、コストがゼロになったりする可能性があります。Doctorは警告を出すので、オーバーライドを削除してモデルごとのAPIルーティング + コストを復元できます。

### 3) レガシー状態マイグレーション（ディスクレイアウト）

Doctorは古いディスク上のレイアウトを現在の構造にマイグレーションできます：

- セッションストア + トランスクリプト：
  - `~/.openclaw/sessions/`から`~/.openclaw/agents/<agentId>/sessions/`へ
- エージェントディレクトリ：
  - `~/.openclaw/agent/`から`~/.openclaw/agents/<agentId>/agent/`へ
- WhatsApp認証状態（Baileys）：
  - レガシー`~/.openclaw/credentials/*.json`（`oauth.json`を除く）から
  - `~/.openclaw/credentials/whatsapp/<accountId>/...`へ（デフォルトアカウントID：`default`）

これらのマイグレーションはベストエフォートで冪等です。レガシーフォルダをバックアップとして残す場合、doctorは警告を発行します。Gateway/CLIも起動時にレガシーセッション + エージェントディレクトリを自動マイグレーションするため、手動のdoctor実行なしに履歴/認証/モデルがエージェントごとのパスに配置されます。WhatsApp認証は意図的に`openclaw doctor`でのみマイグレーションされます。

### 4) 状態の整合性チェック（セッション永続化、ルーティング、安全性）

状態ディレクトリは運用上の脳幹です。消失すると、セッション、認証情報、ログ、設定が失われます（別の場所にバックアップがない限り）。

Doctorがチェックする項目：

- **状態ディレクトリの欠落**：壊滅的な状態損失について警告し、ディレクトリの再作成を促し、欠落データの回復ができないことを通知。
- **状態ディレクトリのパーミッション**：書き込み可能性を検証。パーミッションの修復を提案（オーナー/グループの不一致が検出された場合は`chown`ヒントを表示）。
- **セッションディレクトリの欠落**：`sessions/`とセッションストアディレクトリは履歴の永続化と`ENOENT`クラッシュの回避に必要。
- **トランスクリプトの不一致**：最近のセッションエントリにトランスクリプトファイルが欠落している場合に警告。
- **メインセッション「1行JSONL」**：メイントランスクリプトが1行のみの場合にフラグ（履歴が蓄積されていない）。
- **複数の状態ディレクトリ**：ホームディレクトリ間に複数の`~/.openclaw`フォルダが存在する場合、または`OPENCLAW_STATE_DIR`が別の場所を指している場合に警告（インストール間で履歴が分割される可能性）。
- **リモートモードのリマインダー**：`gateway.mode=remote`の場合、リモートホストでdoctorを実行するよう通知（状態はそこに保存）。
- **設定ファイルのパーミッション**：`~/.openclaw/openclaw.json`がグループ/ワールド読み取り可能な場合に警告し、`600`への変更を提案。

### 5) モデル認証の健全性（OAuthの期限切れ）

Doctorは認証ストアのOAuthプロファイルを検査し、トークンが期限切れ/期限切れ間近の場合に警告し、安全な場合はリフレッシュできます。Anthropic Claude Codeプロファイルが古い場合、`claude setup-token`の実行（またはsetup-tokenの貼り付け）を提案します。リフレッシュプロンプトはインタラクティブ（TTY）実行時のみ表示されます。`--non-interactive`はリフレッシュの試行をスキップします。

Doctorは以下の理由で一時的に使用できない認証プロファイルも報告します：

- 短いクールダウン（レート制限/タイムアウト/認証失敗）
- 長い無効化（課金/クレジット失敗）

### 6) Hooksモデルのバリデーション

`hooks.gmail.model`が設定されている場合、doctorはカタログと許可リストに対してモデル参照を検証し、解決されない場合や許可されていない場合に警告します。

### 7) サンドボックスイメージの修復

サンドボックスが有効な場合、doctorはDockerイメージをチェックし、現在のイメージが見つからない場合はビルドまたはレガシー名への切り替えを提案します。

### 8) Gatewayサービスのマイグレーションとクリーンアップヒント

Doctorはレガシーのgatewayサービス（launchd/systemd/schtasks）を検出し、それらを削除して現在のGatewayポートでOpenClawサービスをインストールすることを提案します。追加のGateway的なサービスをスキャンし、クリーンアップヒントを表示することもできます。プロファイル名付きのOpenClaw Gatewayサービスはファーストクラスと見なされ、「追加」としてフラグされません。

### 9) セキュリティ警告

許可リストなしでDMにオープンなプロバイダーがある場合、または危険な方法でポリシーが設定されている場合に警告を発行します。

### 10) systemd linger（Linux）

systemdユーザーサービスとして実行している場合、doctorはリンガーが有効であることを確認し、ログアウト後もGatewayが生き続けるようにします。

### 11) スキルステータス

Doctorは現在のワークスペースの対象/不足/ブロックされたスキルのクイックサマリーを表示します。

### 12) Gateway認証チェック（ローカルトークン）

ローカルGatewayで`gateway.auth`が欠落している場合にDoctorは警告し、トークンの生成を提案します。自動化でトークン作成を強制するには`openclaw doctor --generate-gateway-token`を使用してください。

### 13) Gatewayヘルスチェック + 再起動

Doctorはヘルスチェックを実行し、不健全に見える場合はGatewayの再起動を提案します。

### 14) チャンネルステータス警告

Gatewayが健全な場合、doctorはチャンネルステータスプローブを実行し、修正提案付きの警告を報告します。

### 15) スーパーバイザー設定の監査 + 修復

Doctorはインストールされたスーパーバイザー設定（launchd/systemd/schtasks）に不足または古いデフォルト（例：systemdのnetwork-online依存関係と再起動遅延）がないかチェックします。不一致が見つかった場合、更新を推奨し、サービスファイル/タスクを現在のデフォルトに書き換えることができます。

注意：

- `openclaw doctor`はスーパーバイザー設定を書き換える前にプロンプトを表示します。
- `openclaw doctor --yes`はデフォルトの修復プロンプトを受け入れます。
- `openclaw doctor --repair`はプロンプトなしで推奨修正を適用します。
- `openclaw doctor --repair --force`はカスタムスーパーバイザー設定を上書きします。
- `openclaw gateway install --force`で完全な書き換えをいつでも強制できます。

### 16) Gatewayランタイム + ポート診断

Doctorはサービスランタイム（PID、最後の終了ステータス）を検査し、サービスはインストールされているが実際には実行されていない場合に警告します。Gatewayポート（デフォルト`18789`）のポート衝突もチェックし、原因の可能性（Gatewayが既に実行中、SSHトンネル）を報告します。

### 17) Gatewayランタイムのベストプラクティス

GatewayサービスがBunまたはバージョン管理されたNodeパス（`nvm`、`fnm`、`volta`、`asdf`など）で実行されている場合にDoctorは警告します。WhatsApp + TelegramチャンネルはNodeを必要とし、バージョンマネージャーパスはサービスがシェルinitをロードしないためアップグレード後に壊れる可能性があります。利用可能な場合、DoctorはシステムNodeインストール（Homebrew/apt/choco）へのマイグレーションを提案します。

### 18) 設定書き込み + ウィザードメタデータ

Doctorは設定変更を永続化し、doctor実行を記録するためにウィザードメタデータをスタンプします。

### 19) ワークスペースのヒント（バックアップ + メモリシステム）

Doctorはワークスペースメモリシステムが欠落している場合に提案し、ワークスペースがまだgit管理下にない場合はバックアップのヒントを表示します。

ワークスペース構造とgitバックアップ（プライベートGitHubまたはGitLabを推奨）の完全ガイドについては、[/concepts/agent-workspace](/concepts/agent-workspace)を参照してください。
