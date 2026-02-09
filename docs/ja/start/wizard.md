---
summary: "CLI オンボーディングウィザード：ゲートウェイ、ワークスペース、チャンネル、Skills のガイド付きセットアップ"
read_when:
  - オンボーディングウィザードを実行または設定する場合
  - 新しいマシンをセットアップする場合
title: "オンボーディングウィザード（CLI）"
sidebarTitle: "オンボーディング：CLI"
---

# オンボーディングウィザード（CLI）

オンボーディングウィザードは、macOS、
Linux、またはWindows(WSL2を介して強く推奨)でOpenClawを設定する**推奨**方法です。
ローカル ゲートウェイまたはリモート ゲートウェイ接続を構成し、チャネル、スキル、
およびワークスペースの既定値を 1 つのガイド付きフローで設定します。

```bash
openclaw onboard
```

<Info>

最速で最初のチャットを始める方法：Control UI を開いてください（チャンネル設定は不要です）。  
`openclaw dashboard` を実行し、ブラウザでチャットします。ドキュメント： [Dashboard](/web/dashboard)。
 
`openclawダッシュボード` を実行し、ブラウザーでチャットします。 ドキュメント: [Dashboard](/web/dashboard).
</Info>

後から再設定する場合：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>

`--json` は非対話モードを意味するものではありません。スクリプトでは `--non-interactive` を使用してください。
 スクリプトの場合は `--non-interactive` を使用します。
</Note>

<Tip>

推奨：エージェントが `web_search` を利用できるように、Brave Search API キーを設定してください
（`web_fetch` はキーなしでも動作します）。最も簡単な方法は `openclaw configure --section web` で、
`tools.web.search.apiKey` を保存します。ドキュメント： [Web tools](/tools/web)。
 最も簡単なパス: `openclaw configure --section web`
で tools.web.search.apiKey` を格納します。 Docs: [Web tools](/tools/web).
</Tip>

## クイックスタート vs 高度な設定

ウィザードは **クイックスタート**（デフォルト）と **高度な設定**（完全制御）から始まります。

<Tabs>
  <Tab title="QuickStart (defaults)">
    - ローカルゲートウェイ（loopback）
    - ワークスペースのデフォルト（または既存のワークスペース）
    - ゲートウェイポート **18789**
    - ゲートウェイ認証 **Token**（loopback でも自動生成）
    - Tailscale 公開 **オフ**
    - Telegram + WhatsApp のダイレクトメッセージは **許可リスト** がデフォルト（電話番号の入力を求められます）
  </Tab>
  <Tab title="Advanced (full control)">
    - すべての手順（モード、ワークスペース、ゲートウェイ、チャンネル、デーモン、Skills）を公開します。
  </Tab>
</Tabs>

## ウィザードが設定する内容

**ローカルモード（デフォルト）** では、次の手順を案内します：

1. **モデル／認証** — Anthropic API キー（推奨）、OAuth、OpenAI、またはその他のプロバイダー。デフォルトモデルを選択します。 デフォルトのモデルを選択します。
2. **ワークスペース** — エージェントファイルの保存場所（デフォルト `~/.openclaw/workspace`）。ブートストラップファイルを初期配置します。 種のブートストラップファイル。
3. **ゲートウェイ** — ポート、バインドアドレス、認証モード、Tailscale 公開。
4. **チャンネル** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles、または iMessage。
5. **デーモン** — LaunchAgent（macOS）または systemd ユーザーユニット（Linux/WSL2）をインストールします。
6. **ヘルスチェック** — Gateway を起動し、正常に動作していることを検証します。
7. **Skills** — 推奨 Skills と任意の依存関係をインストールします。

<Note>

ウィザードを再実行しても、**Reset** を明示的に選択しない限り（または `--reset` を渡さない限り）、何も消去されません。
設定が無効である場合やレガシーキーが含まれている場合、ウィザードはまず `openclaw doctor` を実行するよう促します。

設定が無効な場合、または古いキーが含まれている場合は、ウィザードは最初に `openclaw doctor` を実行するように要求します。
</Note>

**リモートモード** は、ローカルクライアントが別の場所にある Gateway に接続するための設定のみを行います。
リモートホスト上では、インストールや変更は **一切** 行いません。
リモートホスト上の何もインストールしたり変更したりしません。

## 別のエージェントを追加する

`openclaw agents add <name>` を使用すると、独自のワークスペース、セッション、認証プロファイルを持つ別のエージェントを作成できます。
`--workspace` を付けずに実行すると、ウィザードが起動します。 `--workspace` なしで実行すると、ウィザードが起動します。

設定される内容：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注記：

- デフォルトのワークスペースは `~/.openclaw/workspace-<agentId>` に従います。
- 受信メッセージをルーティングするには `bindings` を追加してください（ウィザードで設定できます）。
- 非対話フラグ： `--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完全リファレンス

詳細なステップごとの内訳、非対話スクリプト、Signal のセットアップ、
RPC API、およびウィザードが書き込む設定フィールドの完全な一覧については、
[Wizard Reference](/reference/wizard) を参照してください。

## 関連ドキュメント

- CLI コマンドリファレンス： [`openclaw onboard`](/cli/onboard)
- macOS アプリのオンボーディング： [Onboarding](/start/onboarding)
- エージェント初回実行の儀式： [Agent Bootstrapping](/start/bootstrapping)
