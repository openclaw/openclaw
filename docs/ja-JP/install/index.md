---
summary: "OpenClawのインストール — インストーラースクリプト、npm/pnpm、ソースビルド、Docker など"
read_when:
  - You need an install method other than the Getting Started quickstart
  - You want to deploy to a cloud platform
  - You need to update, migrate, or uninstall
title: "インストール"
---

# インストール

すでに[はじめに](/start/getting-started)の手順を完了していますか？それなら準備万端です。このページは、別のインストール方法、プラットフォーム固有の手順、メンテナンスについて説明しています。

## システム要件

- **[Node 22+](/install/node)**（[インストーラースクリプト](#インストール方法)が未インストールの場合は自動でインストールします）
- macOS、Linux、または Windows
- ソースからビルドする場合のみ `pnpm` が必要

<Note>
Windowsでは、[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)上でOpenClawを実行することを強く推奨します。
</Note>

## インストール方法

<Tip>
**インストーラースクリプト**がOpenClawの推奨インストール方法です。Nodeの検出、インストール、オンボーディングをワンステップで処理します。
</Tip>

<AccordionGroup>
  <Accordion title="インストーラースクリプト" icon="rocket" defaultOpen>
    CLIをダウンロードし、npm経由でグローバルインストールし、オンボーディングウィザードを起動します。

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

    これだけです。スクリプトがNodeの検出、インストール、オンボーディングをすべて処理します。

    オンボーディングをスキップしてバイナリのみをインストールする場合：

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

    すべてのフラグ、環境変数、CI/自動化オプションについては、[インストーラの内部仕様](/install/installer)を参照してください。

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    すでにNode 22+がインストール済みで、自分でインストールを管理したい場合：

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharpのビルドエラーが出る場合">
          libvipsがグローバルにインストールされている場合（macOSではHomebrewでよくあります）、sharpが失敗することがあります。プリビルトバイナリを強制的に使用してください：

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies`というエラーが表示される場合は、ビルドツールをインストールするか（macOS: Xcode CLT + `npm install -g node-gyp`）、上記の環境変数を使用してください。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpmではビルドスクリプトを含むパッケージに対して明示的な承認が必要です。初回インストール時に「Ignored build scripts」の警告が表示されたら、`pnpm approve-builds -g`を実行して、表示されたパッケージを選択してください。
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="ソースからビルド" icon="github">
    コントリビューターや、ローカルチェックアウトから実行したい方向けです。

    <Steps>
      <Step title="クローンとビルド">
        OpenClawリポジトリをクローンしてビルドします：

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLIをリンク">
        `openclaw`コマンドをグローバルで使えるようにします：

        ```bash
        pnpm link --global
        ```

        リンクせずに、リポジトリ内から `pnpm openclaw ...` でコマンドを実行することもできます。
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
    コンテナ化されたデプロイやヘッドレスデプロイ向け。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nixによる宣言的インストール。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    フリートの自動プロビジョニング。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bunランタイムを使ったCLI専用の利用。
  </Card>
</CardGroup>

## インストール後の確認

すべてが正しく動作しているか確認します：

```bash
openclaw doctor         # 設定の問題をチェック
openclaw status         # Gatewayのステータス
openclaw dashboard      # ブラウザUIを開く
```

カスタムランタイムパスが必要な場合は、以下を使用してください：

- `OPENCLAW_HOME` — ホームディレクトリベースの内部パス
- `OPENCLAW_STATE_DIR` — 可変状態の保存場所
- `OPENCLAW_CONFIG_PATH` — 設定ファイルの場所

優先順位と詳細については、[環境変数](/help/environment)を参照してください。

## トラブルシューティング: `openclaw`が見つからない

<Accordion title="PATHの診断と修正">
  簡易診断：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin`（macOS/Linux）または `$(npm prefix -g)`（Windows）が`$PATH`に含まれていない場合、シェルはグローバルnpmバイナリ（`openclaw`を含む）を見つけることができません。

修正方法 — シェルの起動ファイル（`~/.zshrc` または `~/.bashrc`）に以下を追加します：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windowsの場合は、`npm prefix -g`の出力をPATHに追加してください。

その後、新しいターミナルを開いてください（またはzshでは`rehash` / bashでは`hash -r`を実行）。
</Accordion>

## アップデート / アンインストール

<CardGroup cols={3}>
  <Card title="アップデート" href="/install/updating" icon="refresh-cw">
    OpenClawを最新の状態に保つ。
  </Card>
  <Card title="移行" href="/install/migrating" icon="arrow-right">
    新しいマシンへの移行。
  </Card>
  <Card title="アンインストール" href="/install/uninstall" icon="trash-2">
    OpenClawを完全に削除。
  </Card>
</CardGroup>
