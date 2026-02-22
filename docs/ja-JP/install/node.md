---
title: "Node.js"
summary: "OpenClaw用のNode.jsのインストールと設定 — バージョン要件、インストール方法、PATHのトラブルシューティング"
read_when:
  - "You need to install Node.js before installing OpenClaw"
  - "You installed OpenClaw but openclaw is command not found"
  - "npm install -g fails with permissions or PATH issues"
---

# Node.js

OpenClawには**Node 22以降**が必要です。[インストーラースクリプト](/install#install-methods)はNodeを自動的に検出・インストールしますが、このページはNodeを自分でセットアップし、すべてが正しく設定されていること（バージョン、PATH、グローバルインストール）を確認したい場合のためのガイドです。

## バージョンを確認する

```bash
node -v
```

`v22.x.x`以上が表示されればOKです。Nodeがインストールされていない、またはバージョンが古い場合は、以下のインストール方法を選んでください。

## Nodeをインストールする

<Tabs>
  <Tab title="macOS">
    **Homebrew**（推奨）:

    ```bash
    brew install node
    ```

    または[nodejs.org](https://nodejs.org/)からmacOS用インストーラーをダウンロードしてください。

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    またはバージョンマネージャーを使用してください（下記参照）。

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

    または[nodejs.org](https://nodejs.org/)からWindows用インストーラーをダウンロードしてください。

  </Tab>
</Tabs>

<Accordion title="バージョンマネージャーを使う（nvm、fnm、mise、asdf）">
  バージョンマネージャーを使うと、Nodeのバージョンを簡単に切り替えられます。主な選択肢:

- [**fnm**](https://github.com/Schniz/fnm) — 高速、クロスプラットフォーム
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linuxで広く使われている
- [**mise**](https://mise.jdx.dev/) — 多言語対応（Node、Python、Rubyなど）

fnmの使用例:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  バージョンマネージャーがシェルの起動ファイル（`~/.zshrc`または`~/.bashrc`）で初期化されていることを確認してください。初期化されていない場合、PATHにNodeのbinディレクトリが含まれないため、新しいターミナルセッションで`openclaw`が見つからなくなります。
  </Warning>
</Accordion>

## トラブルシューティング

### `openclaw: command not found`

これはほぼ確実に、npmのグローバルbinディレクトリがPATHに含まれていないことが原因です。

<Steps>
  <Step title="グローバルnpmプレフィックスを確認する">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="PATHに含まれているか確認する">
    ```bash
    echo "$PATH"
    ```

    出力に`<npm-prefix>/bin`（macOS/Linux）または`<npm-prefix>`（Windows）が含まれているか確認してください。

  </Step>
  <Step title="シェルの起動ファイルに追加する">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc`または`~/.bashrc`に以下を追加:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        その後、新しいターミナルを開いてください（またはzshでは`rehash`、bashでは`hash -r`を実行）。
      </Tab>
      <Tab title="Windows">
        `npm prefix -g`の出力を、設定 → システム → 環境変数からシステムPATHに追加してください。
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g`でパーミッションエラーが出る（Linux）

EACCESエラーが表示される場合、npmのグローバルプレフィックスをユーザーが書き込み可能なディレクトリに変更してください:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

`export PATH=...`の行を`~/.bashrc`または`~/.zshrc`に追加して永続化してください。
