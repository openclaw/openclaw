---
title: "Node.js"
summary: "OpenClaw用のNode.jsのインストールと設定 — バージョン要件、インストールオプション、PATHのトラブルシューティング"
read_when:
  - "OpenClawをインストールする前にNode.jsをインストールする必要がある場合"
  - "OpenClawをインストールしたが`openclaw`がcommand not foundになる場合"
  - "npm install -gがパーミッションやPATHの問題で失敗する場合"
---

# Node.js

OpenClawは**Node 22以上**が必要です。[インストーラースクリプト](/install#install-methods)はNodeを自動的に検出してインストールします。このページは、Nodeを自分でセットアップし、すべてが正しく設定されていることを確認したい場合（バージョン、PATH、グローバルインストール）のためのものです。

## バージョンの確認

```bash
node -v
```

`v22.x.x`以上が表示されれば準備完了です。Nodeがインストールされていないか、バージョンが古い場合は、以下のインストール方法を選択してください。

## Nodeのインストール

<Tabs>
  <Tab title="macOS">
    **Homebrew**（推奨）：

    ```bash
    brew install node
    ```

    または[nodejs.org](https://nodejs.org/)からmacOSインストーラーをダウンロードしてください。

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian：**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL：**

    ```bash
    sudo dnf install nodejs
    ```

    またはバージョンマネージャーを使用してください（以下を参照）。

  </Tab>
  <Tab title="Windows">
    **winget**（推奨）：

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey：**

    ```powershell
    choco install nodejs-lts
    ```

    または[nodejs.org](https://nodejs.org/)からWindowsインストーラーをダウンロードしてください。

  </Tab>
</Tabs>

<Accordion title="バージョンマネージャーの使用（nvm、fnm、mise、asdf）">
  バージョンマネージャーを使うとNodeのバージョンを簡単に切り替えることができます。人気のオプション：

- [**fnm**](https://github.com/Schniz/fnm) — 高速、クロスプラットフォーム
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linuxで広く使用
- [**mise**](https://mise.jdx.dev/) — 多言語対応（Node、Python、Rubyなど）

fnmの使用例：

```bash
fnm install 22
fnm use 22
```

  <Warning>
  バージョンマネージャーがシェルの起動ファイル（`~/.zshrc`または`~/.bashrc`）で初期化されていることを確認してください。初期化されていない場合、PATHにNodeのbinディレクトリが含まれないため、新しいターミナルセッションで`openclaw`が見つからない可能性があります。
  </Warning>
</Accordion>

## トラブルシューティング

### `openclaw: command not found`

これはほぼ間違いなく、npmのグローバルbinディレクトリがPATHに含まれていないことを意味します。

<Steps>
  <Step title="グローバルnpmプレフィックスを確認">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="PATHに含まれているか確認">
    ```bash
    echo "$PATH"
    ```

    出力に`<npm-prefix>/bin`（macOS/Linux）または`<npm-prefix>`（Windows）が含まれているか確認してください。

  </Step>
  <Step title="シェルの起動ファイルに追加">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc`または`~/.bashrc`に追加してください：

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        その後、新しいターミナルを開くか（またはzshで`rehash`、bashで`hash -r`を実行）してください。
      </Tab>
      <Tab title="Windows">
        `npm prefix -g`の出力を「設定 → システム → 環境変数」からシステムPATHに追加してください。
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g`でのパーミッションエラー（Linux）

`EACCES`エラーが発生する場合は、npmのグローバルプレフィックスをユーザーが書き込み可能なディレクトリに切り替えてください：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

永続化するには、`export PATH=...`の行を`~/.bashrc`または`~/.zshrc`に追加してください。
