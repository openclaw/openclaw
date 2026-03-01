---
summary: "OpenClawのインストール — インストーラースクリプト、npm/pnpm、ソースからのビルド、Docker など"
read_when:
  - Getting Startedのクイックスタート以外のインストール方法が必要な場合
  - クラウドプラットフォームにデプロイしたい場合
  - アップデート、移行、またはアンインストールが必要な場合
title: "インストール"
---

# インストール

すでに[Getting Started](/start/getting-started)を完了していますか？それで準備は完了です。このページは代替のインストール方法、プラットフォーム固有の手順、およびメンテナンスについて説明しています。

## システム要件

- **[Node 22+](/install/node)**（[インストーラースクリプト](#install-methods)が未インストールの場合は自動でインストールします）
- macOS、Linux、または Windows
- ソースからビルドする場合のみ `pnpm` が必要

<Note>
Windowsでは、[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)上でOpenClawを実行することを強く推奨します。
</Note>

## インストール方法

<Tip>
**インストーラースクリプト**はOpenClawをインストールする推奨方法です。Nodeの検出、インストール、およびオンボーディングを1ステップで処理します。
</Tip>

<Warning>
VPS/クラウドホストの場合、可能な限りサードパーティの「ワンクリック」マーケットプレイスイメージは避けてください。クリーンなベースOSイメージ（例：Ubuntu LTS）を選択し、インストーラースクリプトでOpenClawを自分でインストールすることをお勧めします。
</Warning>

<AccordionGroup>
  <Accordion title="インストーラースクリプト" icon="rocket" defaultOpen>
    CLIをダウンロードし、npmでグローバルにインストールし、オンボーディングウィザードを起動します。

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
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

    これだけです。スクリプトがNodeの検出、インストール、およびオンボーディングを処理します。

    オンボーディングをスキップしてバイナリのみをインストールするには：

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    すべてのフラグ、環境変数、CI/自動化オプションについては、[インストーラーの内部構造](/install/installer)を参照してください。

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    すでにNode 22+がインストール済みで、インストールを自分で管理したい場合：

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharpのビルドエラーが発生する場合">
          libvipsがグローバルにインストールされている場合（macOSでHomebrewを使用している場合によくあります）、`sharp`が失敗することがあります。プリビルドバイナリを強制的に使用してください：

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies`と表示される場合は、ビルドツールをインストールするか（macOS: Xcode CLT + `npm install -g node-gyp`）、上記の環境変数を使用してください。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # openclaw、node-llama-cpp、sharpなどを承認
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpmはビルドスクリプトを含むパッケージに対して明示的な承認が必要です。最初のインストールで「Ignored build scripts」の警告が表示された後、`pnpm approve-builds -g`を実行してリストされたパッケージを選択してください。
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="ソースから" icon="github">
    コントリビューターやローカルチェックアウトから実行したい方向けです。

    <Steps>
      <Step title="クローンしてビルド">
        [OpenClawリポジトリ](https://github.com/openclaw/openclaw)をクローンしてビルドします：

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLIをリンク">
        `openclaw`コマンドをグローバルで使用可能にします：

        ```bash
        pnpm link --global
        ```

        または、リンクをスキップして、リポジトリ内から`pnpm openclaw ...`でコマンドを実行することもできます。
      </Step>
      <Step title="オンボーディングを実行">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    より詳しい開発ワークフローについては、[セットアップ](/start/setup)を参照してください。

  </Accordion>
</AccordionGroup>

## その他のインストール方法

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    コンテナ化またはヘッドレスデプロイメント。
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    ルートレスコンテナ：`setup-podman.sh`を一度実行し、その後起動スクリプトを実行します。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nixによる宣言的インストール。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自動化されたフリートプロビジョニング。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bunランタイムを使用したCLI専用の使い方。
  </Card>
</CardGroup>

## インストール後

すべてが正常に動作していることを確認します：

```bash
openclaw doctor         # 設定の問題をチェック
openclaw status         # Gatewayのステータス
openclaw dashboard      # ブラウザUIを開く
```

カスタムランタイムパスが必要な場合は、以下を使用してください：

- `OPENCLAW_HOME` - ホームディレクトリベースの内部パス用
- `OPENCLAW_STATE_DIR` - 可変状態の保存場所用
- `OPENCLAW_CONFIG_PATH` - 設定ファイルの場所用

優先順位と詳細については、[環境変数](/help/environment)を参照してください。

## トラブルシューティング：`openclaw`が見つからない

<Accordion title="PATHの診断と修正">
  クイック診断：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin`（macOS/Linux）または`$(npm prefix -g)`（Windows）が`$PATH`に含まれていない場合、シェルがグローバルnpmバイナリ（`openclaw`を含む）を見つけることができません。

修正 — シェルの起動ファイル（`~/.zshrc`または`~/.bashrc`）に追加してください：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windowsの場合は、`npm prefix -g`の出力をPATHに追加してください。

その後、新しいターミナルを開くか（またはzshで`rehash`、bashで`hash -r`を実行）してください。
</Accordion>

## アップデート / アンインストール

<CardGroup cols={3}>
  <Card title="アップデート" href="/install/updating" icon="refresh-cw">
    OpenClawを最新の状態に保ちます。
  </Card>
  <Card title="移行" href="/install/migrating" icon="arrow-right">
    新しいマシンへの移行。
  </Card>
  <Card title="アンインストール" href="/install/uninstall" icon="trash-2">
    OpenClawを完全に削除します。
  </Card>
</CardGroup>
