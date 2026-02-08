---
summary: "OpenClaw のインストール — インストーラースクリプト、npm/pnpm、ソースから、Docker など"
read_when:
  - 「はじめに」のクイックスタート以外のインストール方法が必要な場合
  - クラウドプラットフォームにデプロイしたい場合
  - 更新、移行、またはアンインストールが必要な場合
title: "インストール"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:20Z
---

# インストール

すでに［はじめに］(/start/getting-started) を完了していますか？ それで問題ありません — このページは、代替のインストール方法、プラットフォーム固有の手順、そしてメンテナンス向けです。

## システム要件

- **[Node 22+](/install/node)**（[インストール方法](#install-methods) のインストーラースクリプトが未インストールの場合に導入します）
- macOS、Linux、または Windows
- ソースからビルドする場合のみ `pnpm`

<Note>
Windows では、[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 上で OpenClaw を実行することを強く推奨します。
</Note>

## インストール方法

<Tip>
**インストーラースクリプト**は、OpenClaw をインストールする推奨方法です。Node の検出、インストール、オンボーディングを 1 ステップで処理します。
</Tip>

<AccordionGroup>
  <Accordion title="インストーラースクリプト" icon="rocket" defaultOpen>
    CLI をダウンロードし、npm でグローバルにインストールして、オンボーディングウィザードを起動します。

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows（PowerShell）">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    以上です — スクリプトが Node の検出、インストール、オンボーディングを処理します。

    オンボーディングをスキップしてバイナリのみをインストールする場合：

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows（PowerShell）">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    すべてのフラグ、環境変数、CI/自動化オプションについては、［Installer internals］(/install/installer) を参照してください。

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    すでに Node 22+ があり、インストールを自分で管理したい場合：

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp のビルドエラー？">
          libvips をグローバルにインストールしている場合（macOS で Homebrew 経由の場合に一般的）、`sharp` が失敗したら、事前ビルド済みバイナリを強制してください：

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies` が表示される場合は、ビルドツール（macOS：Xcode CLT + `npm install -g node-gyp`）をインストールするか、上記の環境変数を使用してください。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm では、ビルドスクリプトを含むパッケージに対して明示的な承認が必要です。最初のインストールで「Ignored build scripts」の警告が表示されたら、`pnpm approve-builds -g` を実行し、一覧のパッケージを選択してください。
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="ソースから" icon="github">
    コントリビューター、またはローカルチェックアウトから実行したい方のための方法です。

    <Steps>
      <Step title="クローンとビルド">
        [OpenClaw リポジトリ](https://github.com/openclaw/openclaw) をクローンしてビルドします：

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI をリンク">
        `openclaw` コマンドをグローバルで利用可能にします：

        ```bash
        pnpm link --global
        ```

        あるいは、リンクを省略して、リポジトリ内から `pnpm openclaw ...` 経由でコマンドを実行できます。
      </Step>
      <Step title="オンボーディングを実行">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    より高度な開発ワークフローについては、［セットアップ］(/start/setup) を参照してください。

  </Accordion>
</AccordionGroup>

## その他のインストール方法

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    コンテナ化またはヘッドレスなデプロイ。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix による宣言的インストール。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    フリートの自動プロビジョニング。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun ランタイムによる CLI のみの利用。
  </Card>
</CardGroup>

## インストール後

動作確認を行います：

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## トラブルシューティング：`openclaw` が見つからない

<Accordion title="PATH の診断と修正">
  クイック診断：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin`（macOS/Linux）または `$(npm prefix -g)`（Windows）が **`$PATH`** に含まれていない場合、シェルは npm のグローバルバイナリ（`openclaw` を含む）を見つけられません。

修正 — シェルの起動ファイル（`~/.zshrc` または `~/.bashrc`）に追加します：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows では、`npm prefix -g` の出力を PATH に追加してください。

その後、新しいターミナルを開く（または zsh では `rehash`、bash では `hash -r` を実行）してください。
</Accordion>

## 更新 / アンインストール

<CardGroup cols={3}>
  <Card title="更新" href="/install/updating" icon="refresh-cw">
    OpenClaw を最新の状態に保ちます。
  </Card>
  <Card title="移行" href="/install/migrating" icon="arrow-right">
    新しいマシンへ移行します。
  </Card>
  <Card title="アンインストール" href="/install/uninstall" icon="trash-2">
    OpenClaw を完全に削除します。
  </Card>
</CardGroup>
