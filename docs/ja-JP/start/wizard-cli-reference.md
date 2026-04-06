---
read_when:
    - openclaw onboardの詳細な動作を知りたいとき
    - オンボーディング結果のデバッグやオンボーディングクライアントの統合を行うとき
sidebarTitle: CLI reference
summary: CLIセットアップフローの完全リファレンス、認証・モデルセットアップ、出力、内部動作
title: CLI セットアップ リファレンス
x-i18n:
    generated_at: "2026-04-02T08:39:50Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 737f9b56c2f51910550784c483b9aaa918c4afb7741f6f0aadda8a0442472ba9
    source_path: start/wizard-cli-reference.md
    workflow: 15
---

# CLI セットアップ リファレンス

このページは`openclaw onboard`の完全リファレンスです。
簡易ガイドについては[オンボーディング（CLI）](/start/wizard)をご覧ください。

## ウィザードの動作

ローカルモード（デフォルト）では、以下の手順を案内します：

- モデルと認証のセットアップ（OpenAI Code サブスクリプション OAuth、Anthropic API キーまたはセットアップトークン、さらにMiniMax、GLM、Ollama、Moonshot、AI Gateway ゲートウェイオプション）
- ワークスペースの場所とブートストラップファイル
- Gateway ゲートウェイ設定（ポート、バインド、認証、Tailscale）
- チャネルとプロバイダー（Telegram、WhatsApp、Discord、Google Chat、Mattermostプラグイン、Signal）
- デーモンインストール（LaunchAgentまたはsystemdユーザーユニット）
- ヘルスチェック
- Skills セットアップ

リモートモードは、このマシンを別の場所にあるGateway ゲートウェイに接続するよう設定します。
リモートホスト上では何もインストールや変更を行いません。

## ローカルフローの詳細

<Steps>
  <Step title="既存設定の検出">
    - `~/.openclaw/openclaw.json`が存在する場合、保持、変更、またはリセットを選択します。
    - ウィザードの再実行では、明示的にリセットを選択（または`--reset`を指定）しない限り、何も消去しません。
    - CLI `--reset`のデフォルトは`config+creds+sessions`です。`--reset-scope full`を使用するとワークスペースも削除されます。
    - 設定が無効またはレガシーキーを含む場合、ウィザードは停止し、続行する前に`openclaw doctor`を実行するよう求めます。
    - リセットは`trash`を使用し、スコープを選択できます：
      - 設定のみ
      - 設定 + 認証情報 + セッション
      - 完全リセット（ワークスペースも削除）
  </Step>
  <Step title="モデルと認証">
    - オプションの完全なマトリックスは[認証とモデルオプション](#auth-and-model-options)にあります。
  </Step>
  <Step title="ワークスペース">
    - デフォルトは`~/.openclaw/workspace`（設定変更可能）。
    - 初回起動ブートストラップに必要なワークスペースファイルをシードします。
    - ワークスペースレイアウト：[エージェントワークスペース](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway ゲートウェイ">
    - ポート、バインド、認証モード、Tailscale公開について確認します。
    - 推奨：ローカルWSクライアントも認証が必要になるよう、local loopbackでもトークン認証を有効にしてください。
    - トークンモードでは、対話型セットアップで以下を選択できます：
      - **平文トークンの生成/保存**（デフォルト）
      - **SecretRefの使用**（オプトイン）
    - パスワードモードでも、対話型セットアップで平文またはSecretRefストレージをサポートします。
    - 非対話型トークンSecretRefパス：`--gateway-token-ref-env <ENV_VAR>`。
      - オンボーディングプロセス環境で空でない環境変数が必要です。
      - `--gateway-token`と併用できません。
    - すべてのローカルプロセスを完全に信頼する場合のみ、認証を無効にしてください。
    - 非local loopbackバインドでは認証が必須です。
  </Step>
  <Step title="チャネル">
    - [WhatsApp](/channels/whatsapp)：オプションのQRログイン
    - [Telegram](/channels/telegram)：ボットトークン
    - [Discord](/channels/discord)：ボットトークン
    - [Google Chat](/channels/googlechat)：サービスアカウントJSON + Webhookオーディエンス
    - [Mattermost](/channels/mattermost)プラグイン：ボットトークン + ベースURL
    - [Signal](/channels/signal)：オプションの`signal-cli`インストール + アカウント設定
    - [BlueBubbles](/channels/bluebubbles)：iMessageに推奨。サーバーURL + パスワード + Webhook
    - [iMessage](/channels/imessage)：レガシーの`imsg` CLIパス + DBアクセス
    - ダイレクトメッセージのセキュリティ：デフォルトはペアリングです。最初のダイレクトメッセージでコードが送信されます。`openclaw pairing approve <channel> <code>`で承認するか、許可リストを使用してください。
  </Step>
  <Step title="デーモンインストール">
    - macOS：LaunchAgent
      - ログイン中のユーザーセッションが必要です。ヘッドレスの場合はカスタムLaunchDaemon（同梱なし）を使用してください。
    - LinuxおよびWSL2経由のWindows：systemdユーザーユニット
      - ウィザードは`loginctl enable-linger <user>`を試みて、ログアウト後もGateway ゲートウェイが動作し続けるようにします。
      - sudoのプロンプトが表示される場合があります（`/var/lib/systemd/linger`に書き込み）。最初にsudoなしで試行します。
    - ランタイム選択：Node（推奨。WhatsAppとTelegramに必須）。Bunは推奨されません。
  </Step>
  <Step title="ヘルスチェック">
    - Gateway ゲートウェイを起動し（必要な場合）、`openclaw health`を実行します。
    - `openclaw status --deep`はステータス出力にGateway ゲートウェイヘルスプローブを追加します。
  </Step>
  <Step title="Skills">
    - 利用可能なSkillsを読み取り、要件をチェックします。
    - ノードマネージャーを選択できます：npmまたはpnpm（bunは推奨されません）。
    - オプションの依存関係をインストールします（macOSではHomebrewを使用するものもあります）。
  </Step>
  <Step title="完了">
    - 概要と次のステップ。iOS、Android、macOSアプリのオプションを含みます。
  </Step>
</Steps>

<Note>
GUIが検出されない場合、ウィザードはブラウザを開く代わりにControl UI用のSSHポートフォワード手順を表示します。
Control UIのアセットが見つからない場合、ウィザードはビルドを試みます。フォールバックは`pnpm ui:build`（UI依存関係を自動インストール）です。
</Note>

## リモートモードの詳細

リモートモードは、このマシンを別の場所にあるGateway ゲートウェイに接続するよう設定します。

<Info>
リモートモードはリモートホスト上で何もインストールや変更を行いません。
</Info>

設定する内容：

- リモートGateway ゲートウェイURL（`ws://...`）
- リモートGateway ゲートウェイ認証が必要な場合はトークン（推奨）

<Note>
- Gateway ゲートウェイがlocal loopbackのみの場合、SSHトンネリングまたはTailscaleネットワークを使用してください。
- ディスカバリーのヒント：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）
</Note>

## 認証とモデルオプション

<AccordionGroup>
  <Accordion title="Anthropic APIキー">
    `ANTHROPIC_API_KEY`が存在する場合はそれを使用し、なければキーの入力を求め、デーモン用に保存します。
  </Accordion>
  <Accordion title="Anthropic Claude CLI">
    Gateway ゲートウェイホスト上のローカルClaude CLIログインを再利用し、モデル選択を`claude-cli/...`に切り替えます。

    - macOS：キーチェーン項目「Claude Code-credentials」をチェック
    - LinuxおよびWindows：`~/.claude/.credentials.json`が存在する場合はそれを再利用

    macOSでは、launchdの起動がブロックされないように「常に許可」を選択してください。

  </Accordion>
  <Accordion title="Anthropicトークン（setup-tokenペースト）">
    任意のマシンで`claude setup-token`を実行し、トークンをペーストします。
    名前を付けることができます。空白の場合はデフォルトが使用されます。
  </Accordion>
  <Accordion title="OpenAI Codeサブスクリプション（Codex CLI再利用）">
    `~/.codex/auth.json`が存在する場合、ウィザードはそれを再利用できます。
  </Accordion>
  <Accordion title="OpenAI Codeサブスクリプション（OAuth）">
    ブラウザフロー。`code#state`をペーストします。

    モデルが未設定または`openai/*`の場合、`agents.defaults.model`を`openai-codex/gpt-5.4`に設定します。

  </Accordion>
  <Accordion title="OpenAI APIキー">
    `OPENAI_API_KEY`が存在する場合はそれを使用し、なければキーの入力を求め、認証プロファイルに資格情報を保存します。

    モデルが未設定、`openai/*`、または`openai-codex/*`の場合、`agents.defaults.model`を`openai/gpt-5.4`に設定します。

  </Accordion>
  <Accordion title="xAI (Grok) APIキー">
    `XAI_API_KEY`の入力を求め、xAIをモデルプロバイダーとして設定します。
  </Accordion>
  <Accordion title="OpenCode">
    `OPENCODE_API_KEY`（または`OPENCODE_ZEN_API_KEY`）の入力を求め、ZenまたはGoカタログを選択できます。
    セットアップURL：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="APIキー（汎用）">
    キーを保存します。
  </Accordion>
  <Accordion title="Vercel AI Gateway ゲートウェイ">
    `AI_GATEWAY_API_KEY`の入力を求めます。
    詳細：[Vercel AI Gateway ゲートウェイ](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway ゲートウェイ">
    アカウントID、Gateway ゲートウェイID、`CLOUDFLARE_AI_GATEWAY_API_KEY`の入力を求めます。
    詳細：[Cloudflare AI Gateway ゲートウェイ](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax">
    設定は自動的に書き込まれます。ホスティングのデフォルトは`MiniMax-M2.7`です。
    詳細：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic（Anthropic互換）">
    `SYNTHETIC_API_KEY`の入力を求めます。
    詳細：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Ollama（クラウドおよびローカルオープンモデル）">
    ベースURL（デフォルト`http://127.0.0.1:11434`）の入力を求め、クラウド + ローカルまたはローカルモードを選択できます。
    利用可能なモデルを検出し、デフォルトを提案します。
    詳細：[Ollama](/providers/ollama)。
  </Accordion>
  <Accordion title="MoonshotおよびKimi Coding">
    Moonshot（Kimi K2）およびKimi Coding設定は自動的に書き込まれます。
    詳細：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)。
  </Accordion>
  <Accordion title="カスタムプロバイダー">
    OpenAI互換およびAnthropic互換エンドポイントで動作します。

    対話型オンボーディングでは、他のプロバイダーAPIキーフローと同じAPIキーストレージの選択肢をサポートしています：
    - **APIキーをペースト**（平文）
    - **シークレット参照を使用**（環境変数参照または設定済みプロバイダー参照、プリフライト検証付き）

    非対話型フラグ：
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key`（オプション。フォールバックは`CUSTOM_API_KEY`）
    - `--custom-provider-id`（オプション）
    - `--custom-compatibility <openai|anthropic>`（オプション。デフォルトは`openai`）

  </Accordion>
  <Accordion title="スキップ">
    認証を未設定のままにします。
  </Accordion>
</AccordionGroup>

モデルの動作：

- 検出されたオプションからデフォルトモデルを選択するか、プロバイダーとモデルを手動で入力します。
- ウィザードはモデルチェックを実行し、設定されたモデルが不明または認証が不足している場合に警告します。

認証情報とプロファイルのパス：

- OAuth認証情報：`~/.openclaw/credentials/oauth.json`
- 認証プロファイル（APIキー + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

認証情報のストレージモード：

- デフォルトのオンボーディング動作は、APIキーを認証プロファイルに平文値として保存します。
- `--secret-input-mode ref`は平文キーストレージの代わりに参照モードを有効にします。
  対話型セットアップでは、以下のいずれかを選択できます：
  - 環境変数参照（例：`keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）
  - 設定済みプロバイダー参照（`file`または`exec`）プロバイダーエイリアス + id
- 対話型参照モードでは、保存前にプリフライト検証を高速実行します。
  - 環境変数参照：現在のオンボーディング環境で変数名と空でない値を検証します。
  - プロバイダー参照：プロバイダー設定を検証し、要求されたIDを解決します。
  - プリフライトが失敗した場合、オンボーディングはエラーを表示しリトライできます。
- 非対話型モードでは、`--secret-input-mode ref`は環境変数ベースのみです。
  - オンボーディングプロセス環境でプロバイダーの環境変数を設定してください。
  - インラインキーフラグ（例：`--openai-api-key`）はその環境変数が設定されている必要があります。設定されていない場合、オンボーディングは即座に失敗します。
  - カスタムプロバイダーの場合、非対話型`ref`モードは`models.providers.<id>.apiKey`を`{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`として保存します。
  - そのカスタムプロバイダーのケースでは、`--custom-api-key`は`CUSTOM_API_KEY`が設定されている必要があります。設定されていない場合、オンボーディングは即座に失敗します。
- Gateway ゲートウェイ認証情報は、対話型セットアップで平文とSecretRefの選択をサポートします：
  - トークンモード：**平文トークンの生成/保存**（デフォルト）または**SecretRefの使用**。
  - パスワードモード：平文またはSecretRef。
- 非対話型トークンSecretRefパス：`--gateway-token-ref-env <ENV_VAR>`。
- 既存の平文セットアップは変更なくそのまま動作します。

<Note>
ヘッドレスおよびサーバーのヒント：ブラウザのあるマシンでOAuthを完了してから、
`~/.openclaw/credentials/oauth.json`（または`$OPENCLAW_STATE_DIR/credentials/oauth.json`）を
Gateway ゲートウェイホストにコピーしてください。
</Note>

## 出力と内部動作

`~/.openclaw/openclaw.json`の一般的なフィールド：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（MiniMaxを選択した場合）
- `tools.profile`（ローカルオンボーディングでは未設定時にデフォルトで`"coding"`に設定。既存の明示的な値は保持されます）
- `gateway.*`（モード、バインド、認証、Tailscale）
- `session.dmScope`（ローカルオンボーディングでは未設定時にデフォルトで`per-channel-peer`に設定。既存の明示的な値は保持されます）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.matrix.*`、`channels.signal.*`、`channels.imessage.*`
- チャネル許可リスト（Slack、Discord、Matrix、Microsoft Teams）プロンプトでオプトインした場合（名前は可能な場合IDに解決されます）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`は`agents.list[]`とオプションの`bindings`を書き込みます。

WhatsApp認証情報は`~/.openclaw/credentials/whatsapp/<accountId>/`に保存されます。
セッションは`~/.openclaw/agents/<agentId>/sessions/`に保存されます。

<Note>
一部のチャネルはプラグインとして提供されます。セットアップ中に選択すると、ウィザードは
チャネル設定の前にプラグインのインストール（npmまたはローカルパス）を求めます。
</Note>

Gateway ゲートウェイウィザードRPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

クライアント（macOSアプリおよびControl UI）はオンボーディングロジックを再実装することなくステップを表示できます。

Signalセットアップの動作：

- 適切なリリースアセットをダウンロードします
- `~/.openclaw/tools/signal-cli/<version>/`に保存します
- 設定に`channels.signal.cliPath`を書き込みます
- JVMビルドにはJava 21が必要です
- ネイティブビルドは利用可能な場合に使用されます
- WindowsではWSL2を使用し、WSL内でLinuxのsignal-cliフローに従います

## 関連ドキュメント

- オンボーディングハブ：[オンボーディング（CLI）](/start/wizard)
- 自動化とスクリプト：[CLI自動化](/start/wizard-cli-automation)
- コマンドリファレンス：[`openclaw onboard`](/cli/onboard)
