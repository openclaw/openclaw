---
summary: "数分で OpenClaw をインストールし、最初のチャットを実行できます。"
read_when:
  - ゼロからの初回セットアップ
  - 動作するチャットへの最短ルートを求めている場合
title: "はじめに"
---

# はじめに

目的: 最小限のセットアップで、ゼロから最初の動作するチャットまで進むことです。

<Info>

最速でチャットする方法: Control UI を開きます（チャンネル設定は不要）。`openclaw dashboard` を実行して
ブラウザーでチャットするか、 `openclaw dashboard`
を実行してブラウザーでチャットするか、 `http://127.0.0.1:18789/` を開きます。
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">ゲートウェイ ホスト</Tooltip>.
 上で
`http://127.0.0.1:18789/` を開いてください。
ドキュメント: [Dashboard](/web/dashboard) および [Control UI](/web/control-ui)。

</Info>

## Prereq

- Node 22 以上

<Tip>
不明な場合は、`node --version` で Node のバージョンを確認してください。
</Tip>

## クイックセットアップ（CLI）

<Steps>
  <Step title="Install OpenClaw (recommended)">
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

    ```
    <Note>
    その他のインストール方法と要件: [Install](/install)。
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    ウィザードは、認証、ゲートウェイ設定、および任意のチャンネルを設定します。
    詳細は [Onboarding Wizard](/start/wizard) を参照してください。
    ```

  </Step>
  <Step title="Check the Gateway">
    サービスをインストールしている場合、すでに実行中のはずです。

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI がロードされた場合、ゲートウェイを使用する準備が整いました。
</Check>

## 任意の確認事項と追加機能

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    簡単なテストやトラブルシューティングに便利です。

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    設定済みのチャンネルが必要です。

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## もっと深く

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    CLI ウィザードの完全なリファレンスと高度なオプション。
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    macOS アプリの初回起動フロー。
  </Card>
</Columns>

## あなたが持っているもの

- 実行中の Gateway
- 設定済みの認証
- Control UI へのアクセス、または接続されたチャンネル

## 次のステップ

- DM の安全性と承認: [Pairing](/channels/pairing)
- さらにチャンネルを接続: [Channels](/channels)
- 高度なワークフローおよびソースからの実行: [Setup](/start/setup)
