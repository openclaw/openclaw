---
read_when:
    - 特定のオンボーディングステップやフラグを調べたいとき
    - 非対話モードでオンボーディングを自動化したいとき
    - オンボーディングの動作をデバッグしたいとき
sidebarTitle: Onboarding Reference
summary: CLIオンボーディングの完全リファレンス：すべてのステップ、フラグ、設定フィールド
title: オンボーディング リファレンス
x-i18n:
    generated_at: "2026-04-02T07:55:03Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 589537463678b12e28b3fd31be2cac8f72bcd65a9cf69a95ace37094806e2bac
    source_path: reference/wizard.md
    workflow: 15
---

# オンボーディング リファレンス

これは `openclaw onboard` の完全リファレンスです。
概要については[オンボーディング（CLI）](/start/wizard)を参照してください。

## フローの詳細（ローカルモード）

<Steps>
  <Step title="既存設定の検出">
    - `~/.openclaw/openclaw.json` が存在する場合、**保持 / 変更 / リセット**を選択します。
    - オンボーディングを再実行しても、明示的に**リセット**を選択（または `--reset` を指定）しない限り、何も消去されません。
    - CLI の `--reset` はデフォルトで `config+creds+sessions` をリセットします。ワークスペースも削除するには `--reset-scope full` を使用してください。
    - 設定が無効であったりレガシーキーが含まれている場合、ウィザードは停止し、続行前に `openclaw doctor` の実行を求めます。
    - リセットには `trash` を使用し（`rm` は使用しません）、以下のスコープを提供します：
      - 設定のみ
      - 設定 + 認証情報 + セッション
      - 完全リセット（ワークスペースも削除）
  </Step>
  <Step title="モデル/認証">
    - **Anthropic APIキー**：`ANTHROPIC_API_KEY` が存在する場合はそれを使用し、存在しない場合はキーの入力を求め、デーモン用に保存します。
    - **Anthropic Claude CLI**：macOSのオンボーディングではKeychain項目「Claude Code-credentials」を確認します（launchdの起動がブロックされないよう「常に許可」を選択してください）。Linux/Windowsでは `~/.claude/.credentials.json` が存在する場合はそれを再利用し、モデル選択を `claude-cli/...` に切り替えます。
    - **Anthropicトークン（setup-tokenの貼り付け）**：任意のマシンで `claude setup-token` を実行し、トークンを貼り付けます（名前を付けられます。空欄 = デフォルト）。
    - **OpenAI Code（Codex）サブスクリプション（Codex CLI）**：`~/.codex/auth.json` が存在する場合、オンボーディングはそれを再利用できます。
    - **OpenAI Code（Codex）サブスクリプション（OAuth）**：ブラウザフロー。`code#state` を貼り付けてください。
      - モデルが未設定または `openai/*` の場合、`agents.defaults.model` を `openai-codex/gpt-5.2` に設定します。
    - **OpenAI APIキー**：`OPENAI_API_KEY` が存在する場合はそれを使用し、存在しない場合はキーの入力を求め、認証プロファイルに保存します。
    - **xAI（Grok）APIキー**：`XAI_API_KEY` の入力を求め、xAIをモデルプロバイダーとして設定します。
    - **OpenCode**：`OPENCODE_API_KEY`（または `OPENCODE_ZEN_API_KEY`、https://opencode.ai/auth で取得）の入力を求め、ZenまたはGoカタログを選択できます。
    - **Ollama**：OllamaのベースURLの入力を求め、**クラウド + ローカル**または**ローカル**モードを選択し、利用可能なモデルを検出し、必要に応じて選択したローカルモデルを自動プルします。
    - 詳細：[Ollama](/providers/ollama)
    - **APIキー**：キーを保存します。
    - **Vercel AI Gateway（マルチモデルプロキシ）**：`AI_GATEWAY_API_KEY` の入力を求めます。
    - 詳細：[Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：アカウントID、Gateway ゲートウェイ ID、`CLOUDFLARE_AI_GATEWAY_API_KEY` の入力を求めます。
    - 詳細：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax**：設定は自動的に書き込まれます。ホストされたデフォルトは `MiniMax-M2.7` です。
    - 詳細：[MiniMax](/providers/minimax)
    - **Synthetic（Anthropic互換）**：`SYNTHETIC_API_KEY` の入力を求めます。
    - 詳細：[Synthetic](/providers/synthetic)
    - **Moonshot（Kimi K2）**：設定は自動的に書き込まれます。
    - **Kimi Coding**：設定は自動的に書き込まれます。
    - 詳細：[Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
    - **スキップ**：認証はまだ設定されません。
    - 検出されたオプションからデフォルトモデルを選択します（またはプロバイダー/モデルを手動で入力）。最高の品質とプロンプトインジェクションリスクの低減のため、プロバイダースタックで利用可能な最新世代の最も強力なモデルを選択してください。
    - オンボーディングはモデルチェックを実行し、設定されたモデルが不明または認証が不足している場合に警告します。
    - APIキーの保存モードはデフォルトでプレーンテキスト認証プロファイル値です。環境変数バックの参照を保存するには `--secret-input-mode ref` を使用してください（例：`keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）。
    - OAuth認証情報は `~/.openclaw/credentials/oauth.json` に、認証プロファイルは `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（APIキー + OAuth）に保存されます。
    - 詳細：[/concepts/oauth](/concepts/oauth)
    <Note>
    ヘッドレス/サーバーのヒント：ブラウザのあるマシンでOAuthを完了し、
    `~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）を
    Gateway ゲートウェイホストにコピーしてください。
    </Note>
  </Step>
  <Step title="ワークスペース">
    - デフォルトは `~/.openclaw/workspace`（設定可能）。
    - エージェントブートストラップリチュアルに必要なワークスペースファイルをシードします。
    - ワークスペースの完全なレイアウト + バックアップガイド：[エージェントワークスペース](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway ゲートウェイ">
    - ポート、バインド、認証モード、Tailscale公開。
    - 認証の推奨事項：ローカルWSクライアントも認証が必要になるよう、ループバックでも**トークン**を維持してください。
    - トークンモードでは、対話型セットアップで以下を提供します：
      - **プレーンテキストトークンの生成/保存**（デフォルト）
      - **SecretRefを使用**（オプトイン）
      - クイックスタートは、オンボーディングプローブ/ダッシュボードブートストラップのために、`env`、`file`、`exec` プロバイダー間で既存の `gateway.auth.token` SecretRefを再利用します。
      - そのSecretRefが設定されているが解決できない場合、ランタイム認証がサイレントに劣化するのではなく、明確な修正メッセージと共にオンボーディングが早期に失敗します。
    - パスワードモードでは、対話型セットアップもプレーンテキストまたはSecretRefの保存をサポートします。
    - 非対話トークンSecretRefパス：`--gateway-token-ref-env <ENV_VAR>`。
      - オンボーディングプロセス環境で空でない環境変数が必要です。
      - `--gateway-token` と併用できません。
    - すべてのローカルプロセスを完全に信頼する場合にのみ認証を無効にしてください。
    - ループバック以外のバインドでは認証が必須です。
  </Step>
  <Step title="チャネル">
    - [WhatsApp](/channels/whatsapp)：オプションのQRログイン。
    - [Telegram](/channels/telegram)：ボットトークン。
    - [Discord](/channels/discord)：ボットトークン。
    - [Google Chat](/channels/googlechat)：サービスアカウントJSON + Webhookオーディエンス。
    - [Mattermost](/channels/mattermost)（プラグイン）：ボットトークン + ベースURL。
    - [Signal](/channels/signal)：オプションの `signal-cli` インストール + アカウント設定。
    - [BlueBubbles](/channels/bluebubbles)：**iMessageに推奨**。サーバーURL + パスワード + Webhook。
    - [iMessage](/channels/imessage)：レガシー `imsg` CLIパス + DBアクセス。
    - ダイレクトメッセージのセキュリティ：デフォルトはペアリングです。最初のダイレクトメッセージでコードが送信されます。`openclaw pairing approve <channel> <code>` で承認するか、許可リストを使用してください。
  </Step>
  <Step title="Web検索">
    - プロバイダーを選択：Perplexity、Brave、Gemini、Grok、またはKimi（またはスキップ）。
    - APIキーを貼り付けます（クイックスタートは環境変数または既存の設定からキーを自動検出します）。
    - `--skip-search` でスキップできます。
    - 後から設定：`openclaw configure --section web`。
  </Step>
  <Step title="デーモンインストール">
    - macOS：LaunchAgent
      - ログイン済みのユーザーセッションが必要です。ヘッドレスの場合は、カスタムLaunchDaemon（同梱されません）を使用してください。
    - Linux（およびWSL2経由のWindows）：systemdユーザーユニット
      - オンボーディングは `loginctl enable-linger <user>` を通じてリンガリングの有効化を試み、ログアウト後もGateway ゲートウェイが稼働し続けるようにします。
      - sudo を要求する場合があります（`/var/lib/systemd/linger` に書き込みます）。まずsudoなしで試行します。
    - **ランタイム選択：** Node（推奨。WhatsApp/Telegramに必要）。Bunは**推奨されません**。
    - トークン認証がトークンを必要とし、`gateway.auth.token` がSecretRefで管理されている場合、デーモンインストールはそれを検証しますが、解決されたプレーンテキストトークン値をスーパーバイザーサービスの環境メタデータに永続化しません。
    - トークン認証がトークンを必要とし、設定されたトークンSecretRefが未解決の場合、デーモンインストールは対処方法のガイダンスと共にブロックされます。
    - `gateway.auth.token` と `gateway.auth.password` の両方が設定されていて `gateway.auth.mode` が未設定の場合、モードが明示的に設定されるまでデーモンインストールはブロックされます。
  </Step>
  <Step title="ヘルスチェック">
    - Gateway ゲートウェイを起動し（必要な場合）、`openclaw health` を実行します。
    - ヒント：`openclaw status --deep` はステータス出力にGateway ゲートウェイのヘルスプローブを追加します（到達可能なGateway ゲートウェイが必要です）。
  </Step>
  <Step title="Skills（推奨）">
    - 利用可能なSkillsを読み取り、要件を確認します。
    - ノードマネージャーを選択できます：**npm / pnpm**（bunは推奨されません）。
    - オプションの依存関係をインストールします（一部はmacOSでHomebrewを使用します）。
  </Step>
  <Step title="完了">
    - サマリー + 次のステップ。追加機能のためのiOS/Android/macOSアプリを含みます。
  </Step>
</Steps>

<Note>
GUIが検出されない場合、オンボーディングはブラウザを開く代わりにコントロールUI用のSSHポートフォワード手順を表示します。
コントロールUIアセットが見つからない場合、オンボーディングはビルドを試みます。フォールバックは `pnpm ui:build`（UI依存関係を自動インストール）です。
</Note>

## 非対話モード

`--non-interactive` を使用してオンボーディングを自動化またはスクリプト化できます：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

`--json` を追加すると、機械可読なサマリーが出力されます。

非対話モードでのGateway ゲートウェイトークンSecretRef：

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN
```

`--gateway-token` と `--gateway-token-ref-env` は排他的です。

<Note>
`--json` は非対話モードを暗黙的に有効に**しません**。スクリプトには `--non-interactive`（および `--workspace`）を使用してください。
</Note>

プロバイダー固有のコマンド例は[CLI自動化](/start/wizard-cli-automation#provider-specific-examples)にあります。
フラグのセマンティクスとステップの順序についてはこのリファレンスページを使用してください。

### エージェントの追加（非対話）

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway ゲートウェイウィザードRPC

Gateway ゲートウェイはRPC経由でオンボーディングフローを公開します（`wizard.start`、`wizard.next`、`wizard.cancel`、`wizard.status`）。
クライアント（macOSアプリ、コントロールUI）はオンボーディングロジックを再実装することなくステップを描画できます。

## Signalセットアップ（signal-cli）

オンボーディングはGitHubリリースから `signal-cli` をインストールできます：

- 適切なリリースアセットをダウンロードします。
- `~/.openclaw/tools/signal-cli/<version>/` に保存します。
- 設定に `channels.signal.cliPath` を書き込みます。

注意：

- JVMビルドには**Java 21**が必要です。
- 利用可能な場合はネイティブビルドが使用されます。
- WindowsではWSL2を使用します。signal-cliのインストールはWSL内のLinuxフローに従います。

## ウィザードが書き込む内容

`~/.openclaw/openclaw.json` の一般的なフィールド：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（Minimax選択時）
- `tools.profile`（ローカルオンボーディングでは未設定時にデフォルトで `"coding"` を設定します。既存の明示的な値は保持されます）
- `gateway.*`（mode、bind、auth、tailscale）
- `session.dmScope`（動作の詳細：[CLI セットアップ リファレンス](/start/wizard-cli-reference#outputs-and-internals)）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.matrix.*`、`channels.signal.*`、`channels.imessage.*`
- チャネル許可リスト（Slack/Discord/Matrix/Microsoft Teams）プロンプト中にオプトインした場合（可能な場合、名前はIDに解決されます）。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` は `agents.list[]` およびオプションの `bindings` を書き込みます。

WhatsAppの認証情報は `~/.openclaw/credentials/whatsapp/<accountId>/` に保存されます。
セッションは `~/.openclaw/agents/<agentId>/sessions/` に保存されます。

一部のチャネルはプラグインとして提供されます。セットアップ中にそれらを選択すると、オンボーディングは
設定の前にインストール（npmまたはローカルパス）を促します。

## 関連ドキュメント

- オンボーディングの概要：[オンボーディング（CLI）](/start/wizard)
- macOSアプリのオンボーディング：[オンボーディング](/start/onboarding)
- 設定リファレンス：[Gateway ゲートウェイの設定](/gateway/configuration)
- プロバイダー：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（レガシー）
- Skills：[Skills](/tools/skills)、[Skills 設定](/tools/skills-config)
