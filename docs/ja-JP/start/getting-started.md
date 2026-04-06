---
read_when:
    - ゼロからの初回セットアップ
    - チャットが動作するまでの最短経路を知りたい
summary: OpenClawをインストールして、数分で最初のチャットを実行しましょう。
title: はじめに
x-i18n:
    generated_at: "2026-04-02T07:54:34Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 58ac8cdcdbaba45fa353ea46d6ac05d1b560cb9abd8a0bebe0e296d864e5c4f9
    source_path: start/getting-started.md
    workflow: 15
---

# はじめに

OpenClawをインストールし、オンボーディングを実行して、AIアシスタントとチャットしましょう — すべて約5分で完了します。最後には、稼働中のGateway ゲートウェイ、設定済みの認証、そして動作するチャットセッションが手に入ります。

## 必要なもの

- **Node.js** — Node 24推奨（Node 22.14以上もサポート）
- モデルプロバイダー（Anthropic、OpenAI、Googleなど）の**APIキー** — オンボーディング中にプロンプトが表示されます

<Tip>
`node --version`でNodeのバージョンを確認してください。
**Windowsユーザー:** ネイティブWindowsとWSL2の両方がサポートされています。WSL2の方が安定しており、フル機能の利用に推奨されます。[Windows](/platforms/windows)を参照してください。
Nodeのインストールが必要ですか？[Nodeセットアップ](/install/node)を参照してください。
</Tip>

## クイックセットアップ

<Steps>
  <Step title="OpenClawをインストール">
    <Tabs>
      <Tab title="macOS / Linux">
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
    その他のインストール方法（Docker、Nix、npm）: [インストール](/install)。
    </Note>

  </Step>
  <Step title="オンボーディングを実行">
    ```bash
    openclaw onboard --install-daemon
    ```

    ウィザードがモデルプロバイダーの選択、APIキーの設定、Gateway ゲートウェイの構成を案内します。約2分で完了します。

    完全なリファレンスは[セットアップウィザード（CLI）](/start/wizard)を参照してください。

  </Step>
  <Step title="Gateway ゲートウェイが稼働中か確認">
    ```bash
    openclaw gateway status
    ```

    Gateway ゲートウェイがポート18789でリッスンしていることが表示されるはずです。

  </Step>
  <Step title="ダッシュボードを開く">
    ```bash
    openclaw dashboard
    ```

    ブラウザでControl UIが開きます。読み込まれれば、すべて正常に動作しています。

  </Step>
  <Step title="最初のメッセージを送信">
    Control UIのチャットにメッセージを入力すると、AIの返信が表示されるはずです。

    代わりにスマートフォンからチャットしたいですか？最も素早くセットアップできるチャネルは
    [Telegram](/channels/telegram)です（ボットトークンだけで可能）。すべてのオプションは[チャネル](/channels)を参照してください。

  </Step>
</Steps>

## 次にやること

<Columns>
  <Card title="チャネルを接続" href="/channels" icon="message-square">
    WhatsApp、Telegram、Discord、iMessage、その他。
  </Card>
  <Card title="ペアリングと安全性" href="/channels/pairing" icon="shield">
    エージェントにメッセージを送信できる人を制御します。
  </Card>
  <Card title="Gateway ゲートウェイを設定" href="/gateway/configuration" icon="settings">
    モデル、ツール、サンドボックス、詳細設定。
  </Card>
  <Card title="ツールを探す" href="/tools" icon="wrench">
    ブラウザ、exec、ウェブ検索、Skills、プラグイン。
  </Card>
</Columns>

<Accordion title="上級者向け: 環境変数">
  OpenClawをサービスアカウントとして実行する場合やカスタムパスを使用したい場合：

- `OPENCLAW_HOME` — 内部パス解決用のホームディレクトリ
- `OPENCLAW_STATE_DIR` — ステートディレクトリのオーバーライド
- `OPENCLAW_CONFIG_PATH` — 設定ファイルパスのオーバーライド

完全なリファレンス: [環境変数](/help/environment)。
</Accordion>
