---
summary: "CLI オンボーディング ウィザードの完全リファレンス。すべての手順、フラグ、設定フィールドを網羅"
read_when:
  - 特定のウィザード手順やフラグを調べるとき
  - 非対話モードでオンボーディングを自動化するとき
  - ウィザードの挙動をデバッグするとき
title: "オンボーディング ウィザード リファレンス"
sidebarTitle: "Wizard Reference"
---

# オンボーディング ウィザード リファレンス

これは `openclaw onboard` CLI ウィザードの完全リファレンスです。
概要については、[Onboarding Wizard](/start/wizard) を参照してください。
8. 概要については、[Onboarding Wizard](/start/wizard) を参照してください。

## フロー詳細（ローカルモード）

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json` が存在する場合は、**Keep / Modify / Reset**を選択します。
    - ウィザードを再実行すると、**リセット**
      を明示的に選択しない限り、何も消去しません** (または `--reset` を渡してください)
    - 設定が無効またはレガシーキーが含まれている場合、ウィザードは停止し、
      続行する前に`openclawドクター`を実行するように要求します。
    - リセットは`rm`ではない`を使用し、スコープを提供します:
      - コンフィグのみ
      - Config + credentials + セッション
      - フルリセット (ワークスペースも削除)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: `ANTHROPIC_API_KEY` を使用します。もし存在する場合やキーのプロンプトが表示された場合は、デーモンの使用のために保存します。
    - **Anthropic OAuth(Claude Code CLI)**: macOSの場合、ウィザードはキーチェーン項目「Claude Code-credentials」をチェックします (「Always Allow」を選択すると起動がブロックされません); Linux/Windows では `~/ を再利用します。 laude/.credentials.json`がある場合。
    - **Anthropic token (paste setup-token)**: `claude setup-token` を任意のマシンで実行し、トークンを貼り付けます (名前は空白の場合; default)。
    - **OpenAI Code (Codex) サブスクリプション (Codex CLI)**: `~/.codex/auth.json` が存在する場合、ウィザードはそれを再利用できます。
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`
      - モデルがアンセットされている場合、`agents.defaults.model` を `openai-codex/gpt-5.2` または `openai/*` に設定します。
    - **OpenAI API キー**: `OPENAI_API_KEY` を使用します。キーが存在する場合やプロンプトが表示された場合は、 `~/.openclaw/.env` に保存します。
    - **xAI (Grok) API キー**: `XAI_API_KEY` のプロンプトを表示し、xAI をモデルプロバイダとして設定します。
    - **OpenCode Zen (マルチモデル プロキシ)**: `OPENCODE_API_KEY` (または `OPENCODE_ZEN_API_KEY` のプロンプトを表示します。https://opencode.ai/auth)
    - **API キー**: キーを保存します。
    - **Vercel AI Gateway (マルチモデルプロキシ)**: `AI_GATEWAY_API_KEY` をプロンプトします。
    - 詳細: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: アカウント ID、ゲートウェイ ID、および `CLOUDFLARE_AI_GATEWAY_API_KEY` のプロンプトを表示します。
    - 詳細: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-write
    - 詳細: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY` .
    - 詳細: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config は自動的に書かれます。
    - **Kimi Coding**: config is auto-written
    - 詳細: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **スキップ**: 未設定です。
    - 検出されたオプションからデフォルトのモデルを選択します (またはプロバイダ/モデルを手動で入力します)。
    - ウィザードはモデルチェックを実行し、構成されたモデルが不明または認証がない場合に警告します。
    - OAuth 資格情報は `~/.openclaw/credentials/oauth.json` に保存されています。認証プロファイルは `~/.openclaw/agents/ にあります。<agentId>/agent/auth-profiles.json` に保存されます。
    - 詳細: [/concepts/oauth](/concepts/oauth)
    
    - 詳細: [/concepts/oauth](/concepts/oauth)    
<Note>
    ヘッドレス / サーバー向けのヒント: ブラウザーのあるマシンで OAuth を完了し、その後
    `~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）を
    Gateway ホストにコピーしてください。
    </Note>
  </Step>
  <Step title="Workspace">
    
    - デフォルトは `~/.openclaw/workspace`（設定可能）です。
    - 初回実行時のブートストラップ儀式に必要なワークスペースファイルを生成します。
    - ワークスペース構成: [Agent ワークスペース](/concepts/agent-workspace)。
  
    - エージェントのブートストラップの儀式に必要なワークスペースファイルを種別します。
    
    - デフォルトは `~/.openclaw/workspace`（変更可能）。
    - エージェントのブートストラップ儀式に必要なワークスペース ファイルをシードします。
    - 完全なワークスペース レイアウトとバックアップ ガイド: [Agent workspace](/concepts/agent-workspace)
    
</Step>
  <Step title="Gateway">
    - ポート、バインディング、認証モード、テールスケールの露出。
    
    - ポート、バインド、認証モード、Tailscale 公開。
    - 認証の推奨: ローカルループバックでも **Token** を維持し、ローカルの WS クライアントにも認証を必須にします。
    - すべてのローカル プロセスを完全に信頼できる場合にのみ、認証を無効化してください。
    - ループバック以外のバインドでは、引き続き認証が必要です。
  
    - すべてのローカルプロセスを完全に信頼している場合にのみ認証を無効にします。
    - ループバックではない結合にはオースが必要です。
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): オプションの QR ログイン。
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google チャット](/channels/googlechat): サービスアカウント JSON + webhook 利用者。
    - [Mattermost](/channels/mattermost) (plugin): botトークン + ベースURL。
    - [Signal](/channels/signal): オプションの `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **iMessage に推奨される; サーバーURL + パスワード + webhook。
    - [iMessage](/channels/imessage): レガシーの `imsg` CLI パス + DB アクセス。
    - DM のセキュリティ: デフォルトはペアリングです。 最初のDMがコードを送信します。`openclawペアリング承認を介して承認 <channel><code>` で承認するか、許可リストを使用します。
  </Step><code>` または許可リストを使用してください。
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - ログインしたユーザーセッションが必要です。ヘッドレスの場合、カスタムLaunchDaemon (出荷されていません) を使用してください。
    - Linux (および WSL2 経由の Windows ) : systemd ユーザユニット
      - ウィザードは `loginctl enable-linger <user>` 経由で長引くことを試みます。これにより、ゲートウェイはログアウト後もアップします。
      - sudo をプロンプトする可能性があります (`/var/lib/systemd/linger`); sudo を先に試行します。
    - **ランタイム選択:** ノード (推奨、WhatsApp/Telegramに必要) Bun は **推奨されません** 。
  </Step>
  <Step title="Health check">
    - 必要に応じてゲートウェイを開始し、`openclaw health` を実行します。
    - ヒント: `openclaw status --deep` はゲートウェイのヘルスプローブをステータス出力に追加します(到達可能なゲートウェイが必要です)。
  </Step>
  <Step title="Skills (recommended)">
    - 利用可能なスキルとチェック要件を読み取ります。
    - ノードマネージャーを選択できます: **npm / pnpm** (bun not recommended).
    - 任意の依存関係をインストールします (macOSでHomebrewを使用する人もいます)。
  </Step>
  <Step title="Finish">
    - 追加機能のためのiOS/Android/macOSアプリを含む次のステップ。
  </Step>
</Steps>

<Note>
GUIが検出されない場合、ウィザードはブラウザを開く代わりにControl UIのSSHポートフォワード命令を出力します。
Control UI アセットが欠落している場合、ウィザードはそれらをビルドしようとします。フォールバックは `pnpm ui:build` です(UI 深度を自動的にインストールします)。
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
 スクリプトには `--非対話型` (と `--workspace` )を使用します。
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
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
クライアント(macOSアプリ、Control UI)は、オンボーディングロジックを再実装せずにステップをレンダリングできます。

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
セッションは `~/.openclaw/agents/<agentId>/sessions/` の下に保存されます。

いくつかのチャンネルはプラグインとして配信されます。 オンボード中に選択すると、ウィザード
は設定する前にインストール(npm またはローカルパス)を要求します。

## 関連ドキュメント

- ウィザード概要: [Onboarding Wizard](/start/wizard)
- macOS アプリのオンボーディング: [Onboarding](/start/onboarding)
- 設定リファレンス: [Gateway configuration](/gateway/configuration)
- プロバイダー: [WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（レガシー）
- Skills: [Skills](/tools/skills)、[Skills config](/tools/skills-config)
