---
read_when:
  - オンボーディングウィザードの実行または設定時
  - 新しいマシンのセットアップ時
sidebarTitle: Wizard (CLI)
summary: CLIオンボーディングウィザード：Gateway、ワークスペース、チャンネル、Skillsの対話式セットアップ
title: オンボーディングウィザード（CLI）
x-i18n:
  generated_at: "2026-02-08T17:15:18Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9a650d46044a930aa4aaec30b35f1273ca3969bf676ab67bf4e1575b5c46db4c
  source_path: start/wizard.md
  workflow: 15
---

# オンボーディングウィザード（CLI）

CLIオンボーディングウィザードは、macOS、Linux、Windows（WSL2経由）でOpenClawをセットアップする際の推奨パスです。ローカルGatewayまたはリモートGateway接続に加えて、ワークスペースのデフォルト設定、チャンネル、Skillsを構成します。

```bash
openclaw onboard
```

<Info>
最速で初回チャットを開始する方法：Control UI を開きます（チャンネル設定は不要）。`openclaw dashboard` を実行してブラウザでチャットできます。ドキュメント：[Dashboard](/web/dashboard)。
</Info>

## クイックスタート vs 詳細設定

ウィザードは**クイックスタート**（デフォルト設定）と**詳細設定**（完全な制御）のどちらかを選択して開始します。

<Tabs>
  <Tab title="クイックスタート（デフォルト設定）">
    - loopback上のローカルGateway
    - 既存のワークスペースまたはデフォルトワークスペース
    - Gatewayポート `18789`
    - Gateway認証トークンは自動生成（loopback上でも生成されます）
    - Tailscale公開はオフ
    - TelegramとWhatsAppのDMはデフォルトで許可リスト（電話番号の入力を求められる場合があります）
  </Tab>
  <Tab title="詳細設定（完全な制御）">
    - モード、ワークスペース、Gateway、チャンネル、デーモン、Skillsの完全なプロンプトフローを表示
  </Tab>
</Tabs>

## CLIオンボーディングの詳細

<Columns>
  <Card title="CLIリファレンス" href="/start/wizard-cli-reference">
    ローカルおよびリモートフローの完全な説明、認証とモデルマトリックス、設定出力、ウィザードRPC、signal-cliの動作。
  </Card>
  <Card title="自動化とスクリプト" href="/start/wizard-cli-automation">
    非対話式オンボーディングのレシピと自動化された `agents add` の例。
  </Card>
</Columns>

## よく使うフォローアップコマンド

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` は非対話モードを意味しません。スクリプトでは `--non-interactive` を使用してください。
</Note>

<Tip>
推奨：エージェントが `web_search` を使用できるように、Brave Search APIキーを設定してください（`web_fetch` はキーなしで動作します）。最も簡単な方法：`openclaw configure --section web` を実行すると `tools.web.search.apiKey` が保存されます。ドキュメント：[Webツール](/tools/web)。
</Tip>

## 関連ドキュメント

- CLIコマンドリファレンス：[`openclaw onboard`](/cli/onboard)
- macOSアプリのオンボーディング：[オンボーディング](/start/onboarding)
- エージェント初回起動の手順：[エージェントブートストラップ](/start/bootstrapping)
