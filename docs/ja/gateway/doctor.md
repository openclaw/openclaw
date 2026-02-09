---
summary: "Doctor コマンド: ヘルスチェック、設定マイグレーション、修復手順"
read_when:
  - Doctor マイグレーションを追加または変更する場合
  - 破壊的な設定変更を導入する場合
title: "Doctor"
---

# Doctor

`openclaw doctor` は OpenClaw の修復およびマイグレーションツールです。古くなった設定や状態を修正し、ヘルスチェックを実行し、実行可能な修復手順を提供します。 古い
構成/状態を修正し、状態をチェックし、実用的な修理ステップを提供します。

## クイックスタート

```bash
openclaw doctor
```

### ヘッドレス / 自動化

```bash
openclaw doctor --yes
```

プロンプトを表示せずに既定値を受け入れます（該当する場合、再起動 / サービス / サンドボックスの修復手順を含む）。

```bash
openclaw doctor --repair
```

プロンプトなしで推奨される修復を適用します（安全な場合の修復 + 再起動）。

```bash
openclaw doctor --repair --force
```

積極的な修復も適用します（カスタムのスーパーバイザー設定を上書きします）。

```bash
openclaw doctor --non-interactive
```

プロンプトなしで実行し、安全な移行のみを適用します (設定の正規化とディスク上の状態の移動)。 人間による確認が必要な再起動/サービス/サンドボックスアクションをスキップします。
検出されると、レガシー状態の移行は自動的に実行されます。

```bash
openclaw doctor --deep
```

システムサービスから追加の ゲートウェイ インストール（launchd/systemd/schtasks）をスキャンします。

書き込み前に変更内容を確認したい場合は、先に設定ファイルを開いてください。

```bash
cat ~/.openclaw/openclaw.json
```

## 何をするか（要約）

- git インストール向けの任意の事前更新（対話実行時のみ）。
- UI プロトコルの新鮮さチェック（プロトコルスキーマが新しい場合に Control UI を再ビルド）。
- ヘルスチェック + 再起動プロンプト。
- Skills の状態サマリー（対象 / 不足 / ブロック）。
- レガシー値に対する設定の正規化。
- OpenCode Zen プロバイダー上書きの警告（`models.providers.opencode`）。
- レガシーなディスク上の状態マイグレーション（セッション / エージェント ディレクトリ / WhatsApp 認証）。
- 状態の整合性および権限チェック（セッション、トランスクリプト、状態ディレクトリ）。
- ローカル実行時の設定ファイル権限チェック（chmod 600）。
- モデル認証の健全性: OAuth の有効期限を確認し、期限切れが近いトークンを更新可能、認証プロファイルのクールダウン / 無効化状態を報告。
- 追加のワークスペース ディレクトリ検出（`~/openclaw`）。
- サンドボックス化が有効な場合のサンドボックス イメージ修復。
- レガシー サービスのマイグレーションおよび追加 ゲートウェイ 検出。
- ゲートウェイ ランタイム チェック（サービスはインストール済みだが未起動、キャッシュされた launchd ラベル）。
- チャンネル状態の警告（実行中の ゲートウェイ からプローブ）。
- スーパーバイザー設定の監査（launchd/systemd/schtasks）と任意の修復。
- ゲートウェイ ランタイムのベストプラクティス チェック（Node 対 Bun、バージョンマネージャーのパス）。
- ゲートウェイ ポート衝突の診断（既定 `18789`）。
- オープンな DM ポリシーに対するセキュリティ警告。
- `gateway.auth.token` が未設定の場合の ゲートウェイ 認証警告（ローカルモード; トークン生成を提案）。
- Linux における systemd linger チェック。
- ソース インストールのチェック（pnpm ワークスペース不一致、UI アセット欠如、tsx バイナリ欠如）。
- 更新された設定 + ウィザード メタデータを書き込み。

## 詳細な動作と根拠

### 0. 任意の更新（git インストール）

git チェックアウトで Doctor を対話的に実行している場合、Doctor 実行前に更新（fetch/rebase/build）を提案します。

### 1. 設定の正規化

設定にレガシーな値の形（例: チャンネル固有の上書きがない `messages.ackReaction`）が含まれる場合、Doctor は現在のスキーマに正規化します。

### 2. レガシー設定キーのマイグレーション

設定に非推奨キーが含まれる場合、他のコマンドは実行を拒否し、`openclaw doctor` の実行を求めます。

Doctor は以下を行います。

- 検出されたレガシー キーを説明。
- 適用したマイグレーションを表示。
- 更新後のスキーマで `~/.openclaw/openclaw.json` を書き換え。

また、Gateway（ゲートウェイ）は起動時にレガシーな設定形式を検出すると Doctor のマイグレーションを自動実行するため、手動操作なしで古い設定が修復されます。

現在のマイグレーション:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → トップレベルの `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*`（tools/elevated/exec/sandbox/subagents）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen プロバイダーの上書き

`models.providers.opencode`（または `opencode-zen`）を手動で追加している場合、`@mariozechner/pi-ai` の組み込み OpenCode Zen カタログを上書きします。これにより、すべてのモデルを単一の API に強制したり、コストをゼロにしたりする可能性があります。Doctor は警告を出し、上書きを削除してモデルごとの API ルーティングとコストを復元できるようにします。
は、すべてのモデルを単一のAPIに強制するか、またはコストをゼロにすることができます。 Doctor は警告を出し、オーバーライドを削除してモデルごとの API ルーティングとコストを復元できるようにします。

### 3. レガシー状態のマイグレーション（ディスク レイアウト）

Doctor は古いディスク上のレイアウトを現在の構造へ移行できます。

- セッション ストア + トランスクリプト:
  - `~/.openclaw/sessions/` から `~/.openclaw/agents/<agentId>/sessions/`
- エージェント ディレクトリ:
  - `~/.openclaw/agent/` から `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 認証状態（Baileys）:
  - レガシーな `~/.openclaw/credentials/*.json`（`oauth.json` を除く）
  - `~/.openclaw/credentials/whatsapp/<accountId>/...` へ（既定のアカウント ID: `default`）

これらの移行はベストエフォートであり、重要ではありません。
バックアップとしてレガシーフォルダを残す場合、医師は警告を発します。 Gateway/CLI は起動時にレガシーなセッションとエージェントディレクトリも自動移行するため、手動で Doctor を実行しなくても、履歴／認証／モデルがエージェントごとのパスに配置されます。 これらのマイグレーションはベストエフォートかつ冪等です。バックアップとしてレガシー フォルダーを残した場合、Doctor は警告を出します。Gateway/CLI も起動時にレガシーなセッション + エージェント ディレクトリを自動マイグレーションし、履歴 / 認証 / モデルがエージェントごとのパスに配置されるようにします。WhatsApp 認証は意図的に `openclaw doctor` 経由でのみマイグレーションされます。

### 4. 状態の整合性チェック（セッション永続化、ルーティング、安全性）

状態ディレクトリは、運用上の頭脳幹です。 消えた場合は、
セッション、資格情報、ログ、設定が失われます (他の場所にバックアップがない限り)。

Doctor のチェック項目:

- **状態ディレクトリが欠如**: 重大な状態損失について警告し、ディレクトリの再作成を促し、失われたデータは復旧できないことを注意喚起します。
- **状態ディレクトリの権限**: 書き込み可能性を検証し、権限修復を提案（所有者 / グループ不一致が検出された場合は `chown` のヒントを表示）。
- **セッション ディレクトリの欠如**: `sessions/` およびセッション ストア ディレクトリは履歴の永続化と `ENOENT` のクラッシュ回避に必須です。
- **トランスクリプト不一致**: 最近のセッション エントリに対応するトランスクリプト ファイルが欠如している場合に警告します。
- **メイン セッションの「1 行 JSONL」**: メインのトランスクリプトが 1 行のみの場合（履歴が蓄積されていない）に警告します。
- **複数の状態ディレクトリ**: 複数の `~/.openclaw` フォルダーがホーム ディレクトリ間に存在する場合、または `OPENCLAW_STATE_DIR` が別の場所を指している場合に警告します（履歴がインストール間で分断される可能性）。
- **リモート モードの注意喚起**: `gateway.mode=remote` の場合、Doctor はリモート ホストで実行するよう注意します（状態はそこに存在します）。
- **設定ファイルの権限**: `~/.openclaw/openclaw.json` がグループ / ワールド可読の場合に警告し、`600` へ厳格化する提案をします。

### 5. モデル認証の健全性（OAuth の有効期限）

Doctor は認証ストア内の OAuth プロファイルを検査し、トークンの期限切れ / 期限切れ間近を警告し、安全な場合は更新できます。Anthropic Claude Code のプロファイルが古い場合、`claude setup-token` の実行（または setup-token の貼り付け）を提案します。更新プロンプトは対話実行（TTY）の場合にのみ表示され、`--non-interactive` は更新試行をスキップします。 Anthropic Claude Code
プロファイルが古い場合、`claude setup-token` (または setup-tokenを貼り付ける) を実行することを示唆します。
リフレッシュプロンプトは対話型(TTY)の実行時にのみ表示されます。`--非対話型`
は更新の試行をスキップします。

また、以下の理由で一時的に使用不可な認証プロファイルも報告します。

- 短いクールダウン（レート制限 / タイムアウト / 認証失敗）
- 長期の無効化（請求 / クレジットの失敗）

### 6. Hooks モデルの検証

`hooks.gmail.model` が設定されている場合、Doctor はモデル参照をカタログおよび許可リストに対して検証し、解決できない、または許可されていない場合に警告します。

### 7. サンドボックス イメージの修復

サンドボックス化が有効な場合、Doctor は Docker イメージを確認し、現在のイメージが欠如している場合にビルドやレガシー名への切り替えを提案します。

### 8. ゲートウェイ サービスのマイグレーションとクリーンアップのヒント

Doctorはレガシーゲートウェイサービス（起動/システムタスク）を検出し、
はそれらを削除し、現在のゲートウェイ
ポートを使用してOpenClawサービスをインストールすることを提供しています。 さらにゲートウェイのようなサービスをスキャンし、クリーンアップのヒントを印刷することもできます。
プロファイル名付きの OpenClaw gateway サービスは第一級として扱われ、「extra」としてフラグ付けされません。

### 9. セキュリティ警告

Doctor は、許可リストなしで DM に公開されているプロバイダーや、危険な方法で構成されたポリシーに対して警告を出します。

### 10. systemd linger（Linux）

systemd ユーザー サービスとして実行されている場合、Doctor はログアウト後も ゲートウェイ が稼働し続けるよう linger が有効であることを確認します。

### 11. Skills の状態

Doctor は現在のワークスペースに対する対象 / 不足 / ブロックされた Skills の簡易サマリーを表示します。

### 12. ゲートウェイ 認証チェック（ローカル トークン）

ローカル ゲートウェイ で `gateway.auth` が欠如している場合、Doctor は警告し、トークン生成を提案します。自動化では `openclaw doctor --generate-gateway-token` を使用してトークン作成を強制できます。 自動化でトークン
を強制するには、`openclaw doctor --generate-gateway-token` を使用します。

### 13. ゲートウェイ のヘルスチェック + 再起動

Doctor はヘルスチェックを実行し、不健全に見える場合は ゲートウェイ の再起動を提案します。

### 14. チャンネル状態の警告

ゲートウェイ が健全な場合、Doctor はチャンネル状態のプローブを実行し、推奨される修正とともに警告を報告します。

### 15. スーパーバイザー設定の監査 + 修復

Doctor はインストール済みのスーパーバイザー設定（launchd/systemd/schtasks）を確認し、欠如または古い既定値（例: systemd の network-online 依存関係や再起動遅延）を検出します。不一致が見つかった場合、更新を推奨し、現在の既定値に合わせてサービス ファイル / タスクを書き換えることができます。 不一致を検出すると、更新を推奨し、サービスファイル／タスクを現在の既定値に書き換えることができます。

注記:

- `openclaw doctor` はスーパーバイザー設定を書き換える前に確認します。
- `openclaw doctor --yes` は既定の修復プロンプトを受け入れます。
- `openclaw doctor --repair` は推奨修正をプロンプトなしで適用します。
- `openclaw doctor --repair --force` はカスタムのスーパーバイザー設定を上書きします。
- `openclaw gateway install --force` でいつでも完全な書き換えを強制できます。

### 16. ゲートウェイ ランタイム + ポート診断

Doctor は、サービス ランタイム(PID、最後の終了ステータス)を検査し、
サービスがインストールされているが実際には実行されていない場合に警告します。 また、ゲートウェイポートでポート衝突
をチェックし(デフォルトは`18789`)、おそらく原因となる(ゲートウェイはすでに
SSHトンネルを実行している)ことを報告します。

### 17. ゲートウェイ ランタイムのベストプラクティス

Doctor は、ゲートウェイサービスが Bun 上またはバージョン管理ノードパス
(`nvm`、`fnm`、`volta`、`asdf`など) 上で実行されると警告します。 WhatsApp と Telegram のチャネルには Node が必要で、サービスはシェル初期化を読み込まないため、アップグレード後にバージョンマネージャのパスが壊れることがあります。 医師は、
利用可能な(Homebrew/apt/choco)時にシステムノードインストールに移行することを提供しています。

### 18. 設定の書き込み + ウィザード メタデータ

Doctor はすべての設定変更を保存し、Doctor 実行を記録するためのウィザード メタデータを付与します。

### 19. ワークスペースのヒント（バックアップ + メモリ システム）

Doctor は不足している場合にワークスペースのメモリ システムを提案し、ワークスペースがまだ git 管理下にない場合はバックアップのヒントを表示します。

ワークスペース構造と git バックアップ（推奨: 非公開の GitHub または GitLab）の完全なガイドについては、[/concepts/agent-workspace](/concepts/agent-workspace) を参照してください。
