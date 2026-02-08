---
summary: "数分で OpenClaw をインストールし、最初のチャットを実行できます。"
read_when:
  - ゼロからの初回セットアップ
  - 動作するチャットへの最短ルートを求めている場合
title: "はじめに"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:11Z
---

# はじめに

目的: 最小限のセットアップで、ゼロから最初の動作するチャットまで進むことです。

<Info>
最速でチャットする方法: Control UI を開きます（チャンネル設定は不要）。`openclaw dashboard` を実行して
ブラウザーでチャットするか、<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">ゲートウェイ ホスト</Tooltip> 上で
`http://127.0.0.1:18789/` を開いてください。
ドキュメント: [Dashboard](/web/dashboard) および [Control UI](/web/control-ui)。
</Info>

## 前提条件

- Node 22 以上

<Tip>
不明な場合は、`node --version` で Node のバージョンを確認してください。
</Tip>

## クイックセットアップ（CLI）

<Steps>
  <Step title="OpenClaw をインストール（推奨）">
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
    その他のインストール方法と要件: [Install](/install)。
    </Note>

  </Step>
  <Step title="オンボーディング ウィザードを実行">
    ```bash
    openclaw onboard --install-daemon
    ```

    ウィザードは、認証、ゲートウェイ設定、および任意のチャンネルを設定します。
    詳細は [Onboarding Wizard](/start/wizard) を参照してください。

  </Step>
  <Step title="Gateway を確認">
    サービスをインストールしている場合、すでに実行中のはずです。

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI を開く">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI が読み込まれれば、Gateway は使用可能な状態です。
</Check>

## 任意の確認事項と追加機能

<AccordionGroup>
  <Accordion title="Gateway をフォアグラウンドで実行">
    簡単なテストやトラブルシューティングに便利です。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="テストメッセージを送信">
    設定済みのチャンネルが必要です。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## さらに詳しく

<Columns>
  <Card title="オンボーディング ウィザード（詳細）" href="/start/wizard">
    CLI ウィザードの完全なリファレンスと高度なオプション。
  </Card>
  <Card title="macOS アプリのオンボーディング" href="/start/onboarding">
    macOS アプリの初回起動フロー。
  </Card>
</Columns>

## 得られるもの

- 実行中の Gateway
- 設定済みの認証
- Control UI へのアクセス、または接続されたチャンネル

## 次のステップ

- DM の安全性と承認: [Pairing](/channels/pairing)
- さらにチャンネルを接続: [Channels](/channels)
- 高度なワークフローおよびソースからの実行: [Setup](/start/setup)
