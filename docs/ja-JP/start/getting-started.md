---
read_when:
  - ゼロからの初回セットアップ
  - 動作するチャットへの最短ルートを知りたい
summary: OpenClawをインストールし、数分で最初のチャットを実行しましょう。
title: はじめに
x-i18n:
  generated_at: "2026-02-08T17:15:16Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 27aeeb3d18c495380e94e6b011b0df3def518535c9f1eee504f04871d8a32269
  source_path: start/getting-started.md
  workflow: 15
---

# はじめに

目標：ゼロから最小限のセットアップで最初の動作するチャットを実現する。

<Info>
最速のチャット方法：Control UIを開く（チャンネル設定は不要）。`openclaw dashboard`を実行してブラウザでチャットするか、<Tooltip headline="Gatewayホスト" tip="OpenClaw Gatewayサービスを実行しているマシン。">Gatewayホスト</Tooltip>で`http://127.0.0.1:18789/`を開きます。
ドキュメント：[Dashboard](/web/dashboard)と[Control UI](/web/control-ui)。
</Info>

## 前提条件

- Node 22以降

<Tip>
不明な場合は`node --version`でNodeのバージョンを確認してください。
</Tip>

## クイックセットアップ（CLI）

<Steps>
  <Step title="OpenClawをインストール（推奨）">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    その他のインストール方法と要件：[インストール](/install)。
    </Note>

  </Step>
  <Step title="オンボーディングウィザードを実行">
    ```bash
    openclaw onboard --install-daemon
    ```

    ウィザードは認証、Gateway設定、およびオプションのチャンネルを構成します。
    詳細は[オンボーディングウィザード](/start/wizard)を参照してください。

  </Step>
  <Step title="Gatewayを確認">
    サービスをインストールした場合、すでに実行されているはずです：

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
Control UIが読み込まれれば、Gatewayは使用可能な状態です。
</Check>

## オプションの確認と追加機能

<AccordionGroup>
  <Accordion title="Gatewayをフォアグラウンドで実行">
    クイックテストやトラブルシューティングに便利です。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="テストメッセージを送信">
    構成済みのチャンネルが必要です。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## さらに詳しく

<Columns>
  <Card title="オンボーディングウィザード（詳細）" href="/start/wizard">
    完全なCLIウィザードリファレンスと高度なオプション。
  </Card>
  <Card title="macOSアプリのオンボーディング" href="/start/onboarding">
    macOSアプリの初回実行フロー。
  </Card>
</Columns>

## 完了後の状態

- 実行中のGateway
- 構成済みの認証
- Control UIアクセスまたは接続済みのチャンネル

## 次のステップ

- DMの安全性と承認：[ペアリング](/channels/pairing)
- さらにチャンネルを接続：[チャンネル](/channels)
- 高度なワークフローとソースからのビルド：[セットアップ](/start/setup)
