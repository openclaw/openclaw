---
summary: "CLI オンボーディング ウィザードの完全リファレンス。すべての手順、フラグ、設定フィールドを網羅"
read_when:
  - 特定のウィザード手順やフラグを調べるとき
  - 非対話モードでオンボーディングを自動化するとき
  - ウィザードの挙動をデバッグするとき
title: "オンボーディング ウィザード リファレンス"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:31Z
---

# オンボーディング ウィザード リファレンス

これは `openclaw onboard` CLI ウィザードの完全リファレンスです。
概要については、[Onboarding Wizard](/start/wizard) を参照してください。

## フロー詳細（ローカルモード）

<Steps>
  <Step title="既存設定の検出">
    - `~/.openclaw/openclaw.json` が存在する場合、**Keep / Modify / Reset** を選択します。
    - ウィザードを再実行しても、明示的に **Reset** を選択しない限り（または `--reset` を渡さない限り）、何も消去されません。
    - 設定が無効、またはレガシーキーを含む場合、ウィザードは停止し、続行前に `openclaw doctor` を実行するよう求めます。
    - Reset は `trash` を使用します（`rm` は使用しません）。スコープを選択できます:
      - 設定のみ
      - 設定 + 認証情報 + セッション
      - フルリセット（ワークスペースも削除）
  </Step>
  <Step title="モデル / 認証">
    - **Anthropic API キー（推奨）**: `ANTHROPIC_API_KEY` が存在すれば使用し、なければキーの入力を求め、デーモン用に保存します。
    - **Anthropic OAuth（Claude Code CLI）**: macOS ではキーチェーン項目「Claude Code-credentials」を確認します（launchd の起動がブロックされないよう「常に許可」を選択）。Linux/Windows では `~/.claude/.credentials.json` があれば再利用します。
    - **Anthropic トークン（setup-token を貼り付け）**: 任意のマシンで `claude setup-token` を実行し、トークンを貼り付けます（名前を付けられます。空白 = デフォルト）。
    - **OpenAI Code（Codex）サブスクリプション（Codex CLI）**: `~/.codex/auth.json` が存在する場合、ウィザードで再利用できます。
    - **OpenAI Code（Codex）サブスクリプション（OAuth）**: ブラウザーフローで `code#state` を貼り付けます。
      - モデルが未設定、または `openai/*` の場合、`agents.defaults.model` を `openai-codex/gpt-5.2` に設定します。
    - **OpenAI API キー**: `OPENAI_API_KEY` が存在すれば使用し、なければキーの入力を求め、launchd が読み取れるよう `~/.openclaw/.env` に保存します。
    - **xAI（Grok）API キー**: `XAI_API_KEY` の入力を求め、xAI をモデルプロバイダーとして設定します。
    - **OpenCode Zen（マルチモデル プロキシ）**: `OPENCODE_API_KEY`（または `OPENCODE_ZEN_API_KEY`、https://opencode.ai/auth で取得）の入力を求めます。
    - **API キー**: キーを保存します。
    - **Vercel AI Gateway（マルチモデル プロキシ）**: `AI_GATEWAY_API_KEY` の入力を求めます。
    - 詳細: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: アカウント ID、Gateway ID、`CLOUDFLARE_AI_GATEWAY_API_KEY` の入力を求めます。
    - 詳細: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: 設定は自動で書き込まれます。
    - 詳細: [MiniMax](/providers/minimax)
    - **Synthetic（Anthropic 互換）**: `SYNTHETIC_API_KEY` の入力を求めます。
    - 詳細: [Synthetic](/providers/synthetic)
    - **Moonshot（Kimi K2）**: 設定は自動で書き込まれます。
    - **Kimi Coding**: 設定は自動で書き込まれます。
    - 詳細: [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
    - **Skip**: まだ認証を設定しません。
    - 検出された選択肢からデフォルトモデルを選択します（またはプロバイダー / モデルを手動入力）。
    - ウィザードはモデルチェックを実行し、設定されたモデルが不明、または認証が不足している場合に警告します。
    - OAuth 認証情報は `~/.openclaw/credentials/oauth.json` に、認証プロファイル（API キー + OAuth）は `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` に保存されます。
    - 詳細: [/concepts/oauth](/concepts/oauth)
    <Note>
    ヘッドレス / サーバー向けのヒント: ブラウザーのあるマシンで OAuth を完了し、その後
    `~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）を
    Gateway ホストにコピーしてください。
    </Note>
  </Step>
  <Step title="ワークスペース">
    - デフォルトは `~/.openclaw/workspace`（変更可能）。
    - エージェントのブートストラップ儀式に必要なワークスペース ファイルをシードします。
    - 完全なワークスペース レイアウトとバックアップ ガイド: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - ポート、バインド、認証モード、Tailscale 公開。
    - 認証の推奨: ローカルループバックでも **Token** を維持し、ローカルの WS クライアントにも認証を必須にします。
    - すべてのローカル プロセスを完全に信頼できる場合にのみ、認証を無効化してください。
    - ループバック以外のバインドでは、引き続き認証が必要です。
  </Step>
  <Step title="チャンネル">
    - [WhatsApp](/channels/whatsapp): 任意の QR ログイン。
    - [Telegram](/channels/telegram): ボットトークン。
    - [Discord](/channels/discord): ボットトークン。
    - [Google Chat](/channels/googlechat): サービス アカウント JSON + webhook audience。
    - [Mattermost](/channels/mattermost)（プラグイン）: ボットトークン + ベース URL。
    - [Signal](/channels/signal): 任意の `signal-cli` インストール + アカウント設定。
    - [BlueBubbles](/channels/bluebubbles): **iMessage に推奨**。サーバー URL + パスワード + webhook。
    - [iMessage](/channels/imessage): レガシー `imsg` CLI パス + DB アクセス。
    - DM セキュリティ: デフォルトはペアリングです。最初の DM でコードを送信し、`openclaw pairing approve <channel> <code>` で承認するか、許可リストを使用します。
  </Step>
  <Step title="デーモンのインストール">
    - macOS: LaunchAgent
      - ログイン中のユーザー セッションが必要です。ヘッドレスの場合は、カスタム LaunchDaemon（未同梱）を使用してください。
    - Linux（および WSL2 経由の Windows）: systemd ユーザー ユニット
      - ログアウト後も Gateway を稼働させるため、`loginctl enable-linger <user>` による lingering の有効化を試みます。
      - sudo を要求する場合があります（`/var/lib/systemd/linger` を書き込み）。まずは sudo なしで試行します。
    - **ランタイム選択:** Node（推奨。WhatsApp / Telegram に必須）。Bun は **推奨されません**。
  </Step>
  <Step title="ヘルスチェック">
    - 必要に応じて Gateway を起動し、`openclaw health` を実行します。
    - ヒント: `openclaw status --deep` は、ステータス出力に Gateway のヘルス プローブを追加します（到達可能な Gateway が必要）。
  </Step>
  <Step title="Skills（推奨）">
    - 利用可能な Skills を読み取り、要件を確認します。
    - ノード マネージャーを選択します: **npm / pnpm**（bun は推奨されません）。
    - 任意の依存関係をインストールします（macOS では Homebrew を使用するものがあります）。
  </Step>
  <Step title="完了">
    - 追加機能のための iOS / Android / macOS アプリを含む、サマリーと次のステップを表示します。
  </Step>
</Steps>

<Note>
GUI が検出されない場合、ウィザードはブラウザーを開く代わりに、Control UI 用の SSH ポートフォワーディング手順を表示します。
Control UI アセットが見つからない場合、ウィザードはそれらのビルドを試みます。フォールバックは `pnpm ui:build` です（UI 依存関係を自動インストール）。
</Note>

## 非対話モード

オンボーディングを自動化またはスクリプト化するには `--non-interactive` を使用します:

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

機械可読なサマリーを得るには `--json` を追加してください。

<Note>
`--json` は非対話モードを **意味しません**。スクリプトでは `--non-interactive`（および `--workspace`）を使用してください。
</Note>

<AccordionGroup>
  <Accordion title="Gemini の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen の例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### エージェントの追加（非対話）

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway ウィザード RPC

Gateway は RPC（`wizard.start`、`wizard.next`、`wizard.cancel`、`wizard.status`）を介してウィザード フローを公開します。
クライアント（macOS アプリ、Control UI）は、オンボーディング ロジックを再実装することなく手順をレンダリングできます。

## Signal のセットアップ（signal-cli）

ウィザードは GitHub リリースから `signal-cli` をインストールできます:

- 適切なリリース アセットをダウンロードします。
- `~/.openclaw/tools/signal-cli/<version>/` 配下に保存します。
- 設定に `channels.signal.cliPath` を書き込みます。

注記:

- JVM ビルドには **Java 21** が必要です。
- 利用可能な場合はネイティブ ビルドを使用します。
- Windows は WSL2 を使用します。signal-cli のインストールは WSL 内で Linux フローに従います。

## ウィザードが書き込む内容

`~/.openclaw/openclaw.json` に含まれる一般的なフィールド:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（Minimax を選択した場合）
- `gateway.*`（モード、バインド、認証、Tailscale）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- プロンプト中にオプトインした場合のチャンネル許可リスト（Slack / Discord / Matrix / Microsoft Teams）。可能な場合、名前は ID に解決されます。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` は `agents.list[]` と、任意で `bindings` を書き込みます。

WhatsApp の認証情報は `~/.openclaw/credentials/whatsapp/<accountId>/` 配下に保存されます。
セッションは `~/.openclaw/agents/<agentId>/sessions/` 配下に保存されます。

一部のチャンネルはプラグインとして提供されます。オンボーディング中に選択すると、
設定前にインストール（npm またはローカル パス）を求められます。

## 関連ドキュメント

- ウィザード概要: [Onboarding Wizard](/start/wizard)
- macOS アプリのオンボーディング: [Onboarding](/start/onboarding)
- 設定リファレンス: [Gateway configuration](/gateway/configuration)
- プロバイダー: [WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（レガシー）
- Skills: [Skills](/tools/skills)、[Skills config](/tools/skills-config)
