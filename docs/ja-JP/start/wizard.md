---
read_when:
    - CLIオンボーディングの実行または設定
    - 新しいマシンのセットアップ
sidebarTitle: 'Onboarding: CLI'
summary: 'CLIオンボーディング: Gateway ゲートウェイ、ワークスペース、チャネル、Skillsのガイド付きセットアップ'
title: オンボーディング（CLI）
x-i18n:
    generated_at: "2026-04-02T08:38:49Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d00b28b4333e4cc0dfc448b8859c4cfd5f965954b50ce499a76dc260eebe1ffa
    source_path: start/wizard.md
    workflow: 15
---

# オンボーディング（CLI）

CLIオンボーディングは、macOS、Linux、またはWindows（WSL2経由、強く推奨）でOpenClawをセットアップするための**推奨される**方法です。
ローカルのGateway ゲートウェイまたはリモートのGateway ゲートウェイ接続に加え、チャネル、Skills、
ワークスペースのデフォルト設定を1つのガイド付きフローで構成します。

```bash
openclaw onboard
```

<Info>
最速で最初のチャットを始めるには: Control UI を開きます（チャネルのセットアップは不要）。
`openclaw dashboard` を実行してブラウザでチャットしてください。ドキュメント: [Dashboard](/web/dashboard)。
</Info>

後から再設定するには:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` はノンインタラクティブモードを意味しません。スクリプトでは `--non-interactive` を使用してください。
</Note>

<Tip>
CLIオンボーディングにはWeb検索ステップが含まれており、プロバイダー
（Perplexity、Brave、Gemini、Grok、またはKimi）を選択してAPIキーを貼り付けることで、エージェントが
`web_search` を使用できるようになります。後から
`openclaw configure --section web` で設定することもできます。ドキュメント: [Webツール](/tools/web)。
</Tip>

## クイックスタート vs アドバンスド

オンボーディングは**クイックスタート**（デフォルト）と**アドバンスド**（完全制御）から始まります。

<Tabs>
  <Tab title="クイックスタート（デフォルト）">
    - ローカルGateway ゲートウェイ（loopback）
    - デフォルトワークスペース（または既存のワークスペース）
    - Gateway ゲートウェイポート **18789**
    - Gateway ゲートウェイ認証 **トークン**（local loopbackでも自動生成）
    - 新しいローカルセットアップのデフォルトツールポリシー: `tools.profile: "coding"`（既存の明示的なプロファイルは保持されます）
    - ダイレクトメッセージ分離のデフォルト: ローカルオンボーディングは未設定時に `session.dmScope: "per-channel-peer"` を書き込みます。詳細: [CLI セットアップ リファレンス](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale公開 **オフ**
    - TelegramとWhatsAppのダイレクトメッセージはデフォルトで**許可リスト**（電話番号の入力が求められます）
  </Tab>
  <Tab title="アドバンスド（完全制御）">
    - すべてのステップ（モード、ワークスペース、Gateway ゲートウェイ、チャネル、デーモン、Skills）を公開します。
  </Tab>
</Tabs>

## オンボーディングで設定される内容

**ローカルモード（デフォルト）** では以下のステップを順に進めます:

1. **モデル/認証** — サポートされている任意のプロバイダー/認証フロー（APIキー、OAuth、またはセットアップトークン）から選択します。カスタムプロバイダー
   （OpenAI互換、Anthropic互換、またはUnknown自動検出）も含みます。デフォルトモデルを選択します。
   セキュリティに関する注意: このエージェントがツールを実行したりwebhook/hooksコンテンツを処理する場合、利用可能な最新世代の最も強力なモデルを選び、ツールポリシーを厳格に保ってください。弱い/古いティアはプロンプトインジェクションを受けやすくなります。
   ノンインタラクティブ実行では、`--secret-input-mode ref` により認証プロファイルにプレーンテキストのAPIキー値ではなく環境変数ベースの参照が保存されます。
   ノンインタラクティブの `ref` モードでは、プロバイダーの環境変数が設定されている必要があります。その環境変数なしでインラインキーフラグを渡すと即座に失敗します。
   インタラクティブ実行では、シークレットリファレンスモードを選択すると、環境変数または設定済みのプロバイダー参照（`file` または `exec`）を指定でき、保存前に高速な事前検証が行われます。
2. **ワークスペース** — エージェントファイルの場所（デフォルト `~/.openclaw/workspace`）。ブートストラップファイルをシードします。
3. **Gateway ゲートウェイ** — ポート、バインドアドレス、認証モード、Tailscale公開。
   インタラクティブのトークンモードでは、デフォルトのプレーンテキストトークン保存またはSecretRefへのオプトインを選択します。
   ノンインタラクティブのトークンSecretRefパス: `--gateway-token-ref-env <ENV_VAR>`。
4. **チャネル** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles、またはiMessage。
5. **デーモン** — LaunchAgent（macOS）またはsystemdユーザーユニット（Linux/WSL2）をインストールします。
   トークン認証がトークンを必要とし、`gateway.auth.token` がSecretRef管理されている場合、デーモンのインストールはそれを検証しますが、解決済みトークンをスーパーバイザーサービスの環境メタデータに永続化しません。
   トークン認証がトークンを必要とし、設定済みのトークンSecretRefが未解決の場合、デーモンのインストールは実行可能なガイダンスとともにブロックされます。
   `gateway.auth.token` と `gateway.auth.password` の両方が設定されていて `gateway.auth.mode` が未設定の場合、モードが明示的に設定されるまでデーモンのインストールはブロックされます。
6. **ヘルスチェック** — Gateway ゲートウェイを起動し、実行中であることを確認します。
7. **Skills** — 推奨されるSkillsとオプションの依存関係をインストールします。

<Note>
オンボーディングを再実行しても、明示的に**リセット**を選択（または `--reset` を渡す）しない限り、何も消去されません。
CLI `--reset` はデフォルトで設定、認証情報、セッションが対象です。ワークスペースを含めるには `--reset-scope full` を使用してください。
設定が無効またはレガシーキーを含む場合、オンボーディングはまず `openclaw doctor` の実行を求めます。
</Note>

**リモートモード** は、ローカルクライアントを別の場所にあるGateway ゲートウェイに接続するためだけに設定します。
リモートホスト上での何かのインストールや変更は**行いません**。

## 別のエージェントを追加する

`openclaw agents add <name>` を使用して、独自のワークスペース、
セッション、認証プロファイルを持つ個別のエージェントを作成します。`--workspace` なしで実行するとオンボーディングが起動します。

設定される内容:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意事項:

- デフォルトのワークスペースは `~/.openclaw/workspace-<agentId>` に従います。
- 受信メッセージをルーティングするために `bindings` を追加してください（オンボーディングで設定可能）。
- ノンインタラクティブフラグ: `--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完全なリファレンス

詳細なステップバイステップの解説と設定出力については、
[CLI セットアップ リファレンス](/start/wizard-cli-reference)を参照してください。
ノンインタラクティブの例については、[CLI自動化](/start/wizard-cli-automation)を参照してください。
RPC詳細を含むより深い技術リファレンスについては、
[オンボーディングリファレンス](/reference/wizard)を参照してください。

## 関連ドキュメント

- CLIコマンドリファレンス: [`openclaw onboard`](/cli/onboard)
- オンボーディング概要: [オンボーディング概要](/start/onboarding-overview)
- macOSアプリのオンボーディング: [オンボーディング](/start/onboarding)
- エージェント初回実行の手順: [エージェントブートストラップ](/start/bootstrapping)
