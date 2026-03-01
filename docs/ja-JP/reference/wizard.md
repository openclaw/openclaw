---
summary: "CLI オンボーディングウィザードの完全リファレンス: すべてのステップ、フラグ、設定フィールド"
read_when:
  - 特定のウィザードのステップやフラグを調べるとき
  - 非インタラクティブモードでオンボーディングを自動化するとき
  - ウィザードの動作をデバッグするとき
title: "オンボーディングウィザードリファレンス"
sidebarTitle: "ウィザードリファレンス"
---

# オンボーディングウィザードリファレンス

これは `openclaw onboard` CLI ウィザードの完全リファレンスです。
高レベルの概要については [オンボーディングウィザード](/start/wizard) を参照してください。

## フローの詳細（ローカルモード）

<Steps>
  <Step title="既存の設定の検出">
    - `~/.openclaw/openclaw.json` が存在する場合は、**保持 / 変更 / リセット**を選択します。
    - ウィザードを再実行しても、明示的に**リセット**を選択（または `--reset` を渡す）しない限り何も消えません。
    - CLI の `--reset` はデフォルトで `config+creds+sessions` になります。ワークスペースも削除するには `--reset-scope full` を使用してください。
    - 設定が無効または廃止されたキーが含まれている場合、ウィザードは停止し、続行する前に `openclaw doctor` を実行するよう求めます。
    - リセットは `trash` を使用します（`rm` は使用しません）。次のスコープを提供します:
      - 設定のみ
      - 設定 + 認証情報 + セッション
      - フルリセット（ワークスペースも削除）
  </Step>
  <Step title="モデル/認証">
    - **Anthropic API キー（推奨）**: 存在する場合は `ANTHROPIC_API_KEY` を使用するか、キーを求めてデーモン使用のために保存します。
    - **Anthropic OAuth（Claude Code CLI）**: macOS ではウィザードがキーチェーンアイテム「Claude Code-credentials」を確認します（launchd の起動がブロックされないよう「常に許可」を選択してください）。Linux/Windows では、存在する場合は `~/.claude/.credentials.json` を再利用します。
    - **Anthropic トークン（setup-token の貼り付け）**: 任意のマシンで `claude setup-token` を実行し、トークンを貼り付けます（名前を付けることができます。空白 = デフォルト）。
    - **OpenAI Code（Codex）サブスクリプション（Codex CLI）**: `~/.codex/auth.json` が存在する場合、ウィザードはそれを再利用できます。
    - **OpenAI Code（Codex）サブスクリプション（OAuth）**: ブラウザフロー。`code#state` を貼り付けます。
      - モデルが未設定または `openai/*` の場合、`agents.defaults.model` を `openai-codex/gpt-5.2` に設定します。
    - **OpenAI API キー**: 存在する場合は `OPENAI_API_KEY` を使用するか、キーを求めて認証プロファイルに保存します。
    - **xAI（Grok）API キー**: `XAI_API_KEY` を求め、xAI をモデルプロバイダーとして設定します。
    - **OpenCode Zen（マルチモデルプロキシ）**: `OPENCODE_API_KEY`（または `OPENCODE_ZEN_API_KEY`、https://opencode.ai/auth で取得）を求めます。
    - **API キー**: キーを保存します。
    - **Vercel AI Gateway（マルチモデルプロキシ）**: `AI_GATEWAY_API_KEY` を求めます。
    - 詳細: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: アカウント ID、ゲートウェイ ID、`CLOUDFLARE_AI_GATEWAY_API_KEY` を求めます。
    - 詳細: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: 設定は自動的に書き込まれます。
    - 詳細: [MiniMax](/providers/minimax)
    - **Synthetic（Anthropic 互換）**: `SYNTHETIC_API_KEY` を求めます。
    - 詳細: [Synthetic](/providers/synthetic)
    - **Moonshot（Kimi K2）**: 設定は自動的に書き込まれます。
    - **Kimi Coding**: 設定は自動的に書き込まれます。
    - 詳細: [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
    - **スキップ**: 認証がまだ設定されていません。
    - 検出されたオプションからデフォルトモデルを選択します（またはプロバイダー/モデルを手動で入力）。
    - ウィザードはモデルチェックを実行し、設定されたモデルが不明または認証が欠落している場合に警告します。
    - API キーのストレージモードはデフォルトでプレーンテキストの認証プロファイル値になります。代わりに環境バックの参照を保存するには `--secret-input-mode ref` を使用してください（例: `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）。
    - OAuth 認証情報は `~/.openclaw/credentials/oauth.json` にあり、認証プロファイルは `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（API キー + OAuth）にあります。
    - 詳細: [/concepts/oauth](/concepts/oauth)
    <Note>
    ヘッドレス/サーバーのヒント: ブラウザがある機械で OAuth を完了し、
    `~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）を
    Gateway ホストにコピーしてください。
    </Note>
  </Step>
  <Step title="ワークスペース">
    - デフォルト `~/.openclaw/workspace`（設定可能）。
    - エージェントのブートストラップリチュアルに必要なワークスペースファイルをシードします。
    - 完全なワークスペースレイアウト + バックアップガイド: [エージェントワークスペース](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - ポート、バインド、認証モード、Tailscale 公開。
    - 認証の推奨: ローカル WS クライアントが認証を必要とするよう、ループバックでも**トークン**を保持してください。
    - 認証を無効にするのは、すべてのローカルプロセスを完全に信頼する場合のみです。
    - 非ループバックバインドは認証が必要です。
  </Step>
  <Step title="チャンネル">
    - [WhatsApp](/channels/whatsapp): オプションの QR ログイン。
    - [Telegram](/channels/telegram): ボットトークン。
    - [Discord](/channels/discord): ボットトークン。
    - [Google Chat](/channels/googlechat): サービスアカウント JSON + Webhook オーディエンス。
    - [Mattermost](/channels/mattermost)（プラグイン）: ボットトークン + ベース URL。
    - [Signal](/channels/signal): オプションの `signal-cli` インストール + アカウント設定。
    - [BlueBubbles](/channels/bluebubbles): **iMessage に推奨**。サーバー URL + パスワード + Webhook。
    - [iMessage](/channels/imessage): レガシーの `imsg` CLI パス + DB アクセス。
    - DM セキュリティ: デフォルトはペアリングです。最初の DM でコードを送信し、`openclaw pairing approve <channel> <code>` で承認するか、許可リストを使用してください。
  </Step>
  <Step title="デーモンのインストール">
    - macOS: LaunchAgent
      - ログインしているユーザーセッションが必要です。ヘッドレスの場合は、カスタム LaunchDaemon を使用してください（同梱されていません）。
    - Linux（および WSL2 経由の Windows）: systemd ユーザーユニット
      - ウィザードは `loginctl enable-linger <user>` でリンジャリングを有効にしようとします。これにより、ログアウト後も Gateway が起動し続けます。
      - sudo が必要な場合があります（`/var/lib/systemd/linger` に書き込みます）。まず sudo なしで試みます。
    - **ランタイム選択:** Node（推奨。WhatsApp/Telegram に必要）。Bun は**推奨されません**。
  </Step>
  <Step title="ヘルスチェック">
    - Gateway を起動し（必要な場合）、`openclaw health` を実行します。
    - ヒント: `openclaw status --deep` はステータス出力に Gateway ヘルスプローブを追加します（到達可能な Gateway が必要）。
  </Step>
  <Step title="スキル（推奨）">
    - 利用可能なスキルを読み込み、要件を確認します。
    - ノードマネージャーを選択できます: **npm / pnpm**（bun は推奨されません）。
    - オプションの依存関係をインストールします（macOS の一部は Homebrew を使用）。
  </Step>
  <Step title="完了">
    - サマリーと次のステップ（追加機能のための iOS/Android/macOS アプリを含む）。
  </Step>
</Steps>

<Note>
GUI が検出されない場合、ウィザードはブラウザを開く代わりにコントロール UI 用の SSH ポートフォワード手順を表示します。
コントロール UI のアセットが欠落している場合、ウィザードはビルドを試みます。フォールバックは `pnpm ui:build`（UI 依存関係を自動インストール）です。
</Note>

## 非インタラクティブモード

オンボーディングを自動化またはスクリプト化するには `--non-interactive` を使用してください:

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

機械可読なサマリーには `--json` を追加してください。

<Note>
`--json` は非インタラクティブモードを意味しません。スクリプトには `--non-interactive`（および `--workspace`）を使用してください。
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

### エージェントの追加（非インタラクティブ）

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway ウィザード RPC

Gateway はウィザードフローを RPC 経由で公開します（`wizard.start`、`wizard.next`、`wizard.cancel`、`wizard.status`）。
クライアント（macOS アプリ、コントロール UI）はオンボーディングロジックを再実装せずにステップをレンダリングできます。

## Signal のセットアップ（signal-cli）

ウィザードは GitHub リリースから `signal-cli` をインストールできます:

- 適切なリリースアセットをダウンロードします。
- `~/.openclaw/tools/signal-cli/<version>/` に保存します。
- 設定に `channels.signal.cliPath` を書き込みます。

注意:

- JVM ビルドには **Java 21** が必要です。
- 利用可能な場合はネイティブビルドが使用されます。
- Windows は WSL2 を使用します。signal-cli のインストールは WSL 内の Linux フローに従います。

## ウィザードが書き込む内容

`~/.openclaw/openclaw.json` の典型的なフィールド:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（Minimax を選択した場合）
- `gateway.*`（モード、バインド、認証、Tailscale）
- `session.dmScope`（動作の詳細: [CLI オンボーディングリファレンス](/start/wizard-cli-reference#outputs-and-internals)）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- プロンプト中に選択した場合のチャンネル許可リスト（Slack/Discord/Matrix/Microsoft Teams）（名前は可能な場合に ID に解決されます）。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` は `agents.list[]` とオプションの `bindings` を書き込みます。

WhatsApp の認証情報は `~/.openclaw/credentials/whatsapp/<accountId>/` に保存されます。
セッションは `~/.openclaw/agents/<agentId>/sessions/` に保存されます。

一部のチャンネルはプラグインとして提供されます。オンボーディング中にチャンネルを選択すると、ウィザードは設定できるようになる前にインストール（npm またはローカルパス）を促します。

## 関連ドキュメント

- ウィザードの概要: [オンボーディングウィザード](/start/wizard)
- macOS アプリのオンボーディング: [オンボーディング](/start/onboarding)
- 設定リファレンス: [Gateway の設定](/gateway/configuration)
- プロバイダー: [WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（レガシー）
- スキル: [スキル](/tools/skills)、[スキルの設定](/tools/skills-config)
