---
summary: "CLIオンボーディングウィザード：gateway、ワークスペース、チャネル、スキルのガイド付きセットアップ"
read_when:
  - オンボーディングウィザードの実行または設定時
  - 新しいマシンのセットアップ時
title: "オンボーディングウィザード (CLI)"
sidebarTitle: "Onboarding (CLI)"
x-i18n:
  generated_at: "2026-02-19T02:00:00Z"
  model: human-verified
  provider: manual
  source_hash: 381ed1422a371c4b7484612166505c18564c6f869d155c32966d998aa3b5942f
  source_path: start/wizard.md
  workflow: manual
---

# オンボーディングウィザード (CLI)

オンボーディングウィザードは、macOS、Linux、またはWindows（WSL2経由、強く推奨）でOpenClawをセットアップするための**推奨**される方法です。
ローカルGatewayまたはリモートGateway接続、さらにチャネル、Skills、ワークスペースのデフォルトを1つのガイド付きフローで設定します。

```bash
openclaw onboard
```

<Info>
最速の最初のチャット: Control UIを開きます（チャネル設定は不要）。
`openclaw dashboard`を実行してブラウザでチャットします。ドキュメント: [ダッシュボード](/web/dashboard)。
</Info>

後で再設定するには:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`は非対話モードを意味しません。スクリプトの場合は、`--non-interactive`を使用してください。
</Note>

<Tip>
推奨: エージェントが`web_search`を使用できるように、Brave Search APIキーを設定します
（`web_fetch`はキーなしで動作します）。最も簡単なパス: `openclaw configure --section web`
で`tools.web.search.apiKey`を保存します。ドキュメント: [Webツール](/tools/web)。
</Tip>

## クイックスタート vs 詳細設定 (Advanced)

ウィザードは、**クイックスタート**（デフォルト）か**詳細設定**（完全な制御）かを選択することから始まります。

<Tabs>
  <Tab title="クイックスタート (デフォルト)">
    - ローカルgateway (ループバック)
    - ワークスペースのデフォルト (または既存のワークスペース)
    - Gatewayポート **18789**
    - Gateway認証 **トークン** (自動生成、ループバックでも)
    - Tailscale公開 **オフ**
    - Telegram + WhatsApp DMはデフォルトで**許可リスト** (電話番号の入力を求められます)
  </Tab>
  <Tab title="詳細設定 (完全な制御)">
    - すべてのステップを公開 (モード、ワークスペース、gateway、チャネル、デーモン、Skills)。
  </Tab>
</Tabs>

## ウィザードが設定する項目

**ローカルモード (デフォルト)** では、以下の手順を実行します:

1. **モデル/認証** — Anthropic APIキー（推奨）、OpenAI、またはカスタムプロバイダー
   （OpenAI互換、Anthropic互換、または不明な自動検出）。デフォルトモデルを選択します。
2. **ワークスペース** — エージェントファイルの場所（デフォルト `~/.openclaw/workspace`）。ブートストラップファイルをシードします。
3. **Gateway** — ポート、バインドアドレス、認証モード、Tailscale公開。
4. **チャネル** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles、またはiMessage。
5. **デーモン** — LaunchAgent (macOS) またはsystemdユーザーユニット (Linux/WSL2) をインストールします。
6. **ヘルスチェック** — Gatewayを起動し、実行されていることを確認します。
7. **Skills** — 推奨Skillsとオプションの依存関係をインストールします。

<Note>
ウィザードを再実行しても、明示的に**リセット**を選択（または`--reset`を渡す）しない限り、何も消去されません。
設定が無効であったり、レガシーキーが含まれている場合、ウィザードは最初に`openclaw doctor`を実行するように求めます。
</Note>

**リモートモード**は、他の場所にあるGatewayに接続するようにローカルクライアントを設定するだけです。
リモートホスト上の何かをインストールしたり変更したりすることは**ありません**。

## 別のエージェントを追加

`openclaw agents add <name>`を使用して、独自のワークスペース、セッション、認証プロファイルを持つ別のエージェントを作成します。
`--workspace`なしで実行すると、ウィザードが起動します。

設定される項目:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意:

- デフォルトのワークスペースは `~/.openclaw/workspace-<agentId>` に従います。
- 受信メッセージをルーティングするために `bindings` を追加します（ウィザードでこれを行えます）。
- 非対話型フラグ: `--model`, `--agent-dir`, `--bind`, `--non-interactive`。

## 完全なリファレンス

詳細なステップバイステップの内訳、非対話型スクリプト、Signalセットアップ、RPC API、およびウィザードが書き込む設定フィールドの完全なリストについては、
[ウィザードリファレンス](/reference/wizard)を参照してください。

## 関連ドキュメント

- CLIコマンドリファレンス: [`openclaw onboard`](/cli/onboard)
- オンボーディング概要: [オンボーディング概要](/start/onboarding-overview)
- macOSアプリのオンボーディング: [オンボーディング](/start/onboarding)
- エージェントの初回実行の儀式: [エージェントのブートストラップ](/start/bootstrapping)
