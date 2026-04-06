---
read_when:
    - OpenClawをインストールする前にNode.jsをインストールする必要がある場合
    - OpenClawをインストールしたが `openclaw` がコマンドが見つからない場合
    - npm install -g がパーミッションまたはPATHの問題で失敗する場合
summary: OpenClaw向けのNode.jsのインストールと設定 -- バージョン要件、インストールオプション、PATHのトラブルシューティング
title: Node.js
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 5e880f6132359dba8720638669df2d71cf857d516cbf5df2589ffeed269b5120
    source_path: install/node.md
    workflow: 15
---

# Node.js

OpenClawには**Node 22.14以降**が必要です。**Node 24がインストール、CI、リリースワークフローのデフォルト推奨ランタイム**です。Node 22はアクティブなLTSラインで引き続きサポートされています。[インストーラースクリプト](/install#alternative-install-methods)はNodeを自動的に検出してインストールします。このページは、自分でNodeをセットアップしてすべてが正しく設定されているか（バージョン、PATH、グローバルインストール）確認したい場合のためです。

## バージョンを確認

```bash
node -v
```

`v24.x.x`以上と表示される場合は推奨デフォルトです。`v22.14.x`以上と表示される場合はサポートされているNode 22 LTSパスですが、都合がつけばNode 24へのアップグレードを推奨します。Nodeがインストールされていないかバージョンが古すぎる場合は、以下のインストール方法を選んでください。

## Nodeをインストール

<Tabs>
  <Tab title="macOS">
    **Homebrew**（推奨）:

    ```bash
    brew install node
    ```

    または[nodejs.org](https://nodejs.org/)からmacOSインストーラーをダウンロードしてください。

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    またはバージョンマネージャーを使用（以下参照）。

  </Tab>
  <Tab title="Windows">
    **winget**（推奨）:

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    または[nodejs.org](https://nodejs.org/)からWindowsインストーラーをダウンロードしてください。

  </Tab>
</Tabs>

<Accordion title="バージョンマネージャーを使用する（nvm、fnm、mise、asdf）">
  バージョンマネージャーを使うとNodeのバージョンを簡単に切り替えられます。主なオプション：

- [**fnm**](https://github.com/Schniz/fnm) -- 高速、クロスプラットフォーム
- [**nvm**](https://github.com/nvm-sh/nvm) -- macOS/Linuxで広く使用
- [**mise**](https://mise.jdx.dev/) -- ポリグロット（Node、Python、Rubyなど）

fnmの例：

```bash
fnm install 24
fnm use 24
```

  <Warning>
  バージョンマネージャーがシェルのスタートアップファイル（`~/.zshrc`または`~/.bashrc`）で初期化されていることを確認してください。そうでないと、新しいターミナルセッションでPATHにNodeのbinディレクトリが含まれず、`openclaw`が見つからない場合があります。
  </Warning>
</Accordion>

## トラブルシューティング

### `openclaw: command not found`

これはほとんどの場合、npmのグローバルbinディレクトリがPATHにないことを意味します。

<Steps>
  <Step title="グローバルnpmプレフィックスを確認">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="PATHにあるか確認">
    ```bash
    echo "$PATH"
    ```

    出力に`<npm-prefix>/bin`（macOS/Linux）または`<npm-prefix>`（Windows）があるか確認してください。

  </Step>
  <Step title="シェルのスタートアップファイルに追加">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc`または`~/.bashrc`に追加：

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        その後、新しいターミナルを開く（またはzshで`rehash` / bashで`hash -r`を実行）。
      </Tab>
      <Tab title="Windows">
        `npm prefix -g`の出力を、設定 → システム → 環境変数からシステムPATHに追加してください。
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g` のパーミッションエラー（Linux）

`EACCES`エラーが出る場合は、npmのグローバルプレフィックスをユーザーが書き込み可能なディレクトリに切り替えてください：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

`export PATH=...`行を`~/.bashrc`または`~/.zshrc`に追加して永続化してください。

## 関連

- [インストール概要](/install) -- すべてのインストール方法
- [アップデート](/install/updating) -- OpenClawを最新に保つ
- [入門](/start/getting-started) -- インストール後の最初のステップ
