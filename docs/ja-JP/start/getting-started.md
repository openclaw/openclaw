---
summary: "OpenClawをインストールして、数分で最初のチャットを実行します。"
read_when:
  - ゼロからの初回セットアップ時
  - 動作するチャット環境への最短パスを知りたい場合
title: "Getting Started"
x-i18n:
  generated_at: "2026-02-19T02:00:00Z"
  model: human-verified
  provider: manual
  source_hash: 4ec86bd0345cc7a70236e566da2ccb9ff17764cc5a7c3b23eab8d5d558251520
  source_path: start/getting-started.md
  workflow: manual
---

# はじめに

目標: ゼロから最初のチャットが動作する状態まで、最小限のセットアップで到達する。

<Info>
最速のチャット: Control UIを開きます（チャネル設定は不要）。`openclaw dashboard`を実行してブラウザでチャットするか、
<Tooltip headline="Gatewayホスト" tip="OpenClaw gatewayサービスを実行しているマシン。">gatewayホスト</Tooltip>上で`http://127.0.0.1:18789/`を開きます。
ドキュメント: [ダッシュボード](/web/dashboard)および[Control UI](/web/control-ui)。
</Info>

## 前提条件

- Node 22以上

<Tip>
不明な場合は、`node --version`でNodeのバージョンを確認してください。
</Tip>

## クイックセットアップ (CLI)

<Steps>
  <Step title="OpenClawをインストール (推奨)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="インストールスクリプトのプロセス"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    その他のインストール方法と要件: [インストール](/install)。
    </Note>

  </Step>
  <Step title="オンボーディングウィザードを実行">
    ```bash
    openclaw onboard --install-daemon
    ```

    ウィザードは認証、gateway設定、オプションのチャネルを設定します。
    詳細は[オンボーディングウィザード](/start/wizard)を参照してください。

  </Step>
  <Step title="Gatewayを確認">
    サービスとしてインストールした場合、すでに実行されているはずです:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UIを開く">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UIが読み込まれれば、Gatewayを使用する準備が整っています。
</Check>

## オプションのチェックと追加機能

<AccordionGroup>
  <Accordion title="Gatewayをフォアグラウンドで実行">
    クイックテストやトラブルシューティングに便利です。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="テストメッセージを送信">
    設定済みのチャネルが必要です。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 便利な環境変数

OpenClawをサービスアカウントとして実行する場合や、設定/状態の場所をカスタマイズしたい場合:

- `OPENCLAW_HOME`: 内部パス解決に使用されるホームディレクトリを設定します。
- `OPENCLAW_STATE_DIR`: 状態ディレクトリをオーバーライドします。
- `OPENCLAW_CONFIG_PATH`: 設定ファイルパスをオーバーライドします。

環境変数の完全なリファレンス: [環境変数](/help/environment)。

## さらに詳しく

<Columns>
  <Card title="オンボーディングウィザード (詳細)" href="/start/wizard">
    完全なCLIウィザードリファレンスと高度なオプション。
  </Card>
  <Card title="macOSアプリのオンボーディング" href="/start/onboarding">
    macOSアプリの初回実行フロー。
  </Card>
</Columns>

## 得られるもの

- 実行中のGateway
- 設定済みの認証
- Control UIアクセスまたは接続されたチャネル

## 次のステップ

- DMの安全性と承認: [ペアリング](/channels/pairing)
- さらなるチャネルの接続: [チャネル](/channels)
- 高度なワークフローとソースからのビルド: [セットアップ](/start/setup)
