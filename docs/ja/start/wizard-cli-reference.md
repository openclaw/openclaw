---
summary: "CLI オンボーディングフロー、認証／モデル設定、出力、内部仕様の完全リファレンス"
read_when:
  - openclaw のオンボードに関する詳細な挙動が必要な場合
  - オンボーディング結果のデバッグやオンボーディングクライアントの統合を行う場合
title: "CLI オンボーディング リファレンス"
sidebarTitle: "CLI reference"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:36Z
---

# CLI オンボーディング リファレンス

このページは `openclaw onboard` の完全なリファレンスです。
簡易ガイドについては [Onboarding Wizard (CLI)](/start/wizard) を参照してください。

## ウィザードの動作内容

ローカルモード（デフォルト）では、次の内容を順に案内します。

- モデルおよび認証のセットアップ（OpenAI Code サブスクリプション OAuth、Anthropic API キーまたはセットアップトークン、加えて MiniMax、GLM、Moonshot、AI Gateway の各オプション）
- ワークスペースの場所とブートストラップファイル
- Gateway 設定（ポート、バインド、認証、 Tailscale）
- チャンネルとプロバイダー（Telegram、WhatsApp、Discord、Google Chat、Mattermost プラグイン、Signal）
- デーモンのインストール（LaunchAgent または systemd ユーザーユニット）
- ヘルスチェック
- Skills のセットアップ

リモートモードでは、このマシンを別の場所にあるゲートウェイへ接続するよう構成します。
リモートホストへのインストールや変更は行いません。

## ローカルフローの詳細

<Steps>
  <Step title="既存設定の検出">
    - `~/.openclaw/openclaw.json` が存在する場合、「保持」「変更」「リセット」から選択します。
    - 明示的に「リセット」を選択（または `--reset` を指定）しない限り、ウィザードを再実行しても内容は消去されません。
    - 設定が無効、またはレガシーキーを含む場合、ウィザードは停止し、続行前に `openclaw doctor` を実行するよう求めます。
    - リセットは `trash` を使用し、次のスコープを選択できます。
      - 設定のみ
      - 設定 + 資格情報 + セッション
      - 完全リセット（ワークスペースも削除）
  </Step>
  <Step title="モデルと認証">
    - 完全な選択肢一覧は [認証とモデルのオプション](#auth-and-model-options) を参照してください。
  </Step>
  <Step title="ワークスペース">
    - デフォルトは `~/.openclaw/workspace`（設定可能）です。
    - 初回実行時のブートストラップ儀式に必要なワークスペースファイルを生成します。
    - ワークスペース構成: [Agent ワークスペース](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway">
    - ポート、バインド、認証モード、 Tailscale 公開について入力を求められます。
    - 推奨: ループバックであってもトークン認証を有効にし、ローカル WS クライアントにも認証を要求してください。
    - すべてのローカルプロセスを完全に信頼できる場合にのみ、認証を無効化してください。
    - ループバック以外へのバインドでは、引き続き認証が必要です。
  </Step>
  <Step title="チャンネル">
    - [WhatsApp](/channels/whatsapp): 任意の QR ログイン
    - [Telegram](/channels/telegram): ボットトークン
    - [Discord](/channels/discord): ボットトークン
    - [Google Chat](/channels/googlechat): サービスアカウント JSON + Webhook オーディエンス
    - [Mattermost](/channels/mattermost) プラグイン: ボットトークン + ベース URL
    - [Signal](/channels/signal): 任意の `signal-cli` インストール + アカウント設定
    - [BlueBubbles](/channels/bluebubbles): iMessage 用に推奨；サーバー URL + パスワード + Webhook
    - [iMessage](/channels/imessage): レガシー `imsg` CLI パス + DB アクセス
    - DM のセキュリティ: デフォルトはペアリングです。最初の DM でコードを送信し、
      `openclaw pairing approve <channel> <code>` で承認するか、許可リストを使用します。
  </Step>
  <Step title="デーモンのインストール">
    - macOS: LaunchAgent
      - ログイン中のユーザーセッションが必要です。ヘッドレスの場合は、カスタム LaunchDaemon（同梱なし）を使用してください。
    - Linux および Windows（WSL2 経由）: systemd ユーザーユニット
      - ログアウト後もゲートウェイを維持するため、ウィザードは `loginctl enable-linger <user>` を試行します。
      - sudo を求められる場合があります（`/var/lib/systemd/linger` を書き込みます）。まず sudo なしで試行します。
    - ランタイム選択: Node（推奨。WhatsApp と Telegram で必須）。 Bun は推奨されません。
  </Step>
  <Step title="ヘルスチェック">
    - 必要に応じてゲートウェイを起動し、 `openclaw health` を実行します。
    - `openclaw status --deep` は、ゲートウェイのヘルスプローブをステータス出力に追加します。
  </Step>
  <Step title="Skills">
    - 利用可能な Skills を読み取り、要件を確認します。
    - node マネージャー（ npm または pnpm）を選択できます（ bun は推奨されません）。
    - 任意の依存関係をインストールします（macOS では Homebrew を使用するものがあります）。
  </Step>
  <Step title="完了">
    - iOS、Android、macOS アプリの選択肢を含む要約と次のステップを表示します。
  </Step>
</Steps>

<Note>
GUI が検出されない場合、ウィザードはブラウザーを開く代わりに Control UI 用の SSH ポートフォワード手順を表示します。
Control UI アセットが存在しない場合、ウィザードはビルドを試行します。フォールバックは `pnpm ui:build`（UI 依存関係の自動インストール）です。
</Note>

## リモートモードの詳細

リモートモードでは、このマシンを別の場所にあるゲートウェイへ接続するよう構成します。

<Info>
リモートモードでは、リモートホストへのインストールや変更は行いません。
</Info>

設定する内容:

- リモートゲートウェイ URL（`ws://...`）
- リモートゲートウェイで認証が必要な場合のトークン（推奨）

<Note>
- ゲートウェイがループバック専用の場合は、 SSH トンネルまたは tailnet を使用してください。
- 検出のヒント:
  - macOS: Bonjour（`dns-sd`）
  - Linux: Avahi（`avahi-browse`）
</Note>

## 認証とモデルのオプション

<AccordionGroup>
  <Accordion title="Anthropic API キー（推奨）">
    `ANTHROPIC_API_KEY` が存在する場合はそれを使用し、なければキーの入力を求め、デーモン利用のために保存します。
  </Accordion>
  <Accordion title="Anthropic OAuth（Claude Code CLI）">
    - macOS: キーチェーン項目「Claude Code-credentials」を確認します
    - Linux および Windows: `~/.claude/.credentials.json` が存在すれば再利用します

    macOS では、「常に許可」を選択し、 launchd 起動時にブロックされないようにしてください。

  </Accordion>
  <Accordion title="Anthropic トークン（セットアップトークン貼り付け）">
    任意のマシンで `claude setup-token` を実行し、そのトークンを貼り付けます。
    名前を付けることができます。空欄の場合はデフォルトを使用します。
  </Accordion>
  <Accordion title="OpenAI Code サブスクリプション（Codex CLI の再利用）">
    `~/.codex/auth.json` が存在する場合、ウィザードで再利用できます。
  </Accordion>
  <Accordion title="OpenAI Code サブスクリプション（OAuth）">
    ブラウザーフローを実行し、 `code#state` を貼り付けます。

    モデルが未設定、または `openai/*` の場合、 `agents.defaults.model` を `openai-codex/gpt-5.3-codex` に設定します。

  </Accordion>
  <Accordion title="OpenAI API キー">
    `OPENAI_API_KEY` が存在する場合はそれを使用し、なければキーの入力を求め、
    launchd が読み取れるよう `~/.openclaw/.env` に保存します。

    モデルが未設定、 `openai/*`、または `openai-codex/*` の場合、
    `agents.defaults.model` を `openai/gpt-5.1-codex` に設定します。

  </Accordion>
  <Accordion title="xAI（Grok）API キー">
    `XAI_API_KEY` の入力を求め、 xAI をモデルプロバイダーとして構成します。
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY`（または `OPENCODE_ZEN_API_KEY`）の入力を求めます。
    セットアップ URL: [opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="API キー（汎用）">
    キーを保存します。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` の入力を求めます。
    詳細: [Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    アカウント ID、ゲートウェイ ID、 `CLOUDFLARE_AI_GATEWAY_API_KEY` の入力を求めます。
    詳細: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.1">
    設定は自動的に書き込まれます。
    詳細: [MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic（Anthropic 互換）">
    `SYNTHETIC_API_KEY` の入力を求めます。
    詳細: [Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Moonshot と Kimi Coding">
    Moonshot（Kimi K2）および Kimi Coding の設定は自動的に書き込まれます。
    詳細: [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)。
  </Accordion>
  <Accordion title="スキップ">
    認証を未設定のままにします。
  </Accordion>
</AccordionGroup>

モデルの挙動:

- 検出された選択肢からデフォルトモデルを選択するか、プロバイダーとモデルを手動で入力します。
- ウィザードはモデルチェックを実行し、設定されたモデルが不明、または認証が不足している場合に警告します。

資格情報およびプロファイルのパス:

- OAuth 資格情報: `~/.openclaw/credentials/oauth.json`
- 認証プロファイル（API キー + OAuth）: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
ヘッドレスおよびサーバー向けのヒント: ブラウザーのあるマシンで OAuth を完了し、
`~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
をゲートウェイホストへコピーしてください。
</Note>

## 出力と内部仕様

`~/.openclaw/openclaw.json` に含まれる代表的なフィールド:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（ MiniMax を選択した場合）
- `gateway.*`（モード、バインド、認証、 Tailscale）
- `channels.telegram.botToken`、 `channels.discord.token`、 `channels.signal.*`、 `channels.imessage.*`
- プロンプト中に同意した場合のチャンネル許可リスト（ Slack、 Discord、 Matrix、 Microsoft Teams）。可能な場合は名前が ID に解決されます。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` は `agents.list[]` と、任意で `bindings` を書き込みます。

WhatsApp の資格情報は `~/.openclaw/credentials/whatsapp/<accountId>/` 配下に保存されます。
セッションは `~/.openclaw/agents/<agentId>/sessions/` 配下に保存されます。

<Note>
一部のチャンネルはプラグインとして提供されます。オンボーディング中に選択すると、
チャンネル設定の前にプラグイン（ npm またはローカルパス）のインストールを求められます。
</Note>

Gateway ウィザード RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

クライアント（ macOS アプリおよび Control UI）は、オンボーディングロジックを再実装せずに手順を描画できます。

Signal セットアップの挙動:

- 適切なリリースアセットをダウンロードします
- `~/.openclaw/tools/signal-cli/<version>/` 配下に保存します
- 設定内に `channels.signal.cliPath` を書き込みます
- JVM ビルドには Java 21 が必要です
- 利用可能な場合はネイティブビルドが使用されます
- Windows では WSL2 を使用し、 WSL 内で Linux の signal-cli フローに従います

## 関連ドキュメント

- オンボーディング ハブ: [Onboarding Wizard (CLI)](/start/wizard)
- 自動化とスクリプト: [CLI Automation](/start/wizard-cli-automation)
- コマンド リファレンス: [`openclaw onboard`](/cli/onboard)
