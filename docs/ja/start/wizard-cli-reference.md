---
summary: "CLI オンボーディングフロー、認証／モデル設定、出力、内部仕様の完全リファレンス"
read_when:
  - openclaw のオンボードに関する詳細な挙動が必要な場合
  - オンボーディング結果のデバッグやオンボーディングクライアントの統合を行う場合
title: "CLI オンボーディング リファレンス"
sidebarTitle: "CLI reference"
---

# CLI オンボーディング リファレンス

このページは `openclawオンボード` の完全な参照です。
ショートガイドについては、[オンボーディングウィザード (CLI)](/start/wizard)を参照してください。

## ウィザードが行うこと

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
リモートホストにインストールしたり変更したりすることはありません。

## ローカルフローの詳細

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json` が存在する場合は、Keep、Modify、Resetを選択します。
    - ウィザードを再実行すると、明示的に Reset (または `--reset` を渡す) を選択しない限り、何も消去されません。
    - 設定が無効な場合、または古いキーが含まれている場合、ウィザードは停止し、続行する前に `openclaw doctor` の実行を要求します。
    - Reset uses `trash` and provides scope:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model and auth">
    - 完全な選択肢一覧は [認証とモデルのオプション](#auth-and-model-options) を参照してください。
  </Step>
  <Step title="Workspace">
    
    - デフォルトは `~/.openclaw/workspace`（設定可能）です。
    - 初回実行時のブートストラップ儀式に必要なワークスペースファイルを生成します。
    - ワークスペース構成: [Agent ワークスペース](/concepts/agent-workspace)。
  
    - 最初に起動するブートストラップの儀式に必要なワークスペースファイルを種別します。
    - ワークスペース構成: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - ポート、バインディング、認証モード、およびテールスケールの露出に対するプロンプト。
    - 推奨:ローカルWSクライアントが認証する必要があるように、トークン認証をループバックでも有効にしておく。
    - すべてのローカルプロセスを完全に信頼している場合にのみ認証を無効にします。
    - Non-loopback バインディングはまだ認証が必要です。
  </Step>
  <Step title="Channels">
    
    - [WhatsApp](/channels/whatsapp): 任意の QR ログイン
    - [Telegram](/channels/telegram): ボットトークン
    - [Discord](/channels/discord): ボットトークン
    - [Google Chat](/channels/googlechat): サービスアカウント JSON + Webhook オーディエンス
    - [Mattermost](/channels/mattermost) プラグイン: ボットトークン + ベース URL
    - [Signal](/channels/signal): 任意の `signal-cli` インストール + アカウント設定
    - [BlueBubbles](/channels/bluebubbles): iMessage 用に推奨；サーバー URL + パスワード + Webhook
    - [iMessage](/channels/imessage): レガシー `imsg` CLI パス + DB アクセス
    - DM のセキュリティ: デフォルトはペアリングです。最初の DM でコードを送信し、
      `openclaw pairing approve  15. 最初の DM でコードが送信されます。次で承認してください:
      `openclaw pairing approve <channel><code>` で承認するか、許可リストを使用します。
  </Step><code>` または許可リストを使用してください。
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - ログインしたユーザーセッションが必要です。ヘッドレスの場合、カスタムLaunchDaemon (出荷されていません) を使用してください。
    - WSL2を介したLinuxとWindows: systemd ユーザユニット
      - ウィザードは `loginctl enable-linger <user>` を試みます。これにより、ゲートウェイはログアウト後も起動します。
      - sudo をプロンプトする可能性があります (`/var/lib/systemd/linger`); sudo を先に試行します。
    - ランタイム選択: ノード (推奨、WhatsAppとTelegramに必要)。 Bun は推奨されません。
  </Step>
  <Step title="Health check">
    - 必要に応じてゲートウェイを開始し、`openclaw health` を実行します。
    - `openclaw status --deep` はゲートウェイのヘルスプローブをステータス出力に追加します。
  </Step>
  <Step title="Skills">
    - 利用可能なスキルとチェック要件を読み取ります。
    - ノードマネージャーを選択できます: npm または pnpm (bunは推奨されません)
    - 任意の依存関係をインストールします (macOSでHomebrewを使用する人もいます)。
  </Step>
  <Step title="Finish">
    - iOS、Android、macOS アプリのオプションを含む概要と次のステップ。
  </Step>
</Steps>

<Note>
GUIが検出されない場合、ウィザードはブラウザを開く代わりにControl UIのSSHポートフォワード命令を出力します。
コントロールUIアセットが欠落している場合、ウィザードはそれらをビルドしようとします。フォールバックは`pnpm ui:build`です(UI深度を自動インストールします)。
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

- ディスカバリーヒント:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## 認証とモデルのオプション

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    `ANTHROPIC_API_KEY` が存在する場合はそれを使用し、なければキーの入力を求め、デーモン利用のために保存します。
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: キーチェーン項目「Claude Code-credentials」を確認します
    - Linux および Windows: `~/.claude/.credentials.json` が存在すれば再利用します

    ```
    macOS では、「常に許可」を選択し、 launchd 起動時にブロックされないようにしてください。
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    
    任意のマシンで `claude setup-token` を実行し、そのトークンを貼り付けます。
    名前を付けることができます。空欄の場合はデフォルトを使用します。
  
    名前を付けることができます。空白はデフォルトを使用します。
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    `~/.codex/auth.json` が存在する場合、ウィザードで再利用できます。
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    ブラウザーフローを実行し、 `code#state` を貼り付けます。

    ```
    モデルが未設定、または `openai/*` の場合、 `agents.defaults.model` を `openai-codex/gpt-5.3-codex` に設定します。
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    `OPENAI_API_KEY` が存在する場合はそれを使用し、なければキーの入力を求め、
    launchd が読み取れるよう `~/.openclaw/.env` に保存します。

    ```
    モデルが未設定、 `openai/*`、または `openai-codex/*` の場合、
    `agents.defaults.model` を `openai/gpt-5.1-codex` に設定します。
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY` の入力を求め、 xAI をモデルプロバイダーとして構成します。
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY` (または `OPENCODE_ZEN_API_KEY`) のプロンプトを表示します。
    
    `OPENCODE_API_KEY`（または `OPENCODE_ZEN_API_KEY`）の入力を求めます。
    セットアップ URL: [opencode.ai/auth](https://opencode.ai/auth)。
  
  </Accordion>
  <Accordion title="API key (generic)">
    キーを保存します。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` のプロンプト。
    
    `AI_GATEWAY_API_KEY` の入力を求めます。
    詳細: [Vercel AI Gateway](/providers/vercel-ai-gateway)。
  
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    
    アカウント ID、ゲートウェイ ID、 `CLOUDFLARE_AI_GATEWAY_API_KEY` の入力を求めます。
    詳細: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  
    16. 詳細: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.1">
    設定は自動的に書き込まれます。
    詳細: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY` のプロンプト。
    詳細: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    
    Moonshot（Kimi K2）および Kimi Coding の設定は自動的に書き込まれます。
    詳細: [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)。
  
    詳細: [ムーンショット AI (キミ+キミコーディング)] (/providers/moonshot)。
  </Accordion>
  <Accordion title="Skip">
    認証が設定されていません。
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
セッションは `~/.openclaw/agents/<agentId>/sessions/` の下に保存されます。

<Note>
いくつかのチャンネルはプラグインとして配信されます。 オンボーディング中に選択された場合、ウィザード
はチャンネル構成の前にプラグイン(npm または ローカル パス)をインストールするように促します。
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
