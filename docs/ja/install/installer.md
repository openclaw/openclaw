---
summary: "インストーラー スクリプト（install.sh、install-cli.sh、install.ps1）の仕組み、フラグ、オートメーションについて"
read_when:
  - "`openclaw.ai/install.sh` を理解したい場合"
  - インストールを自動化（CI / ヘッドレス）したい場合
  - GitHub のチェックアウトからインストールしたい場合
title: "インストーラーの内部"
---

# インストーラーの内部

OpenClaw には 3 つのインストーラー スクリプトが同梱されており、`openclaw.ai` から配信されます。

| スクリプト                              | プラットフォーム            | 何を行うか                                                                             |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL | 必要に応じて Node をインストールし、npm（デフォルト）または git 経由で OpenClaw をインストールし、オンボーディングを実行できます。     |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL | Node と OpenClaw をローカル プレフィックス（`~/.openclaw`）にインストールします。root 権限は不要です。 ルートは必要ありません。 |
| [`install.ps1`](#installps1)       | Windows（PowerShell） | 必要に応じて Node をインストールし、npm（デフォルト）または git 経由で OpenClaw をインストールし、オンボーディングを実行できます。     |

## クイック コマンド

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
インストールが成功しても、新しいターミナルで `openclaw` が見つからない場合は、[Node.js トラブルシューティング](/install/node#troubleshooting) を参照してください。
</Note>

---

## install.sh

<Tip>
macOS / Linux / WSL での対話的なインストールの多くに推奨されます。
</Tip>

### フロー（install.sh）

<Steps>
  <Step title="Detect OS">
    macOS と Linux (WSLを含む) に対応しています。 
    macOS と Linux（WSL を含む）をサポートします。macOS が検出された場合、Homebrew が未インストールであればインストールします。
  
  </Step>
  <Step title="Ensure Node.js 22+">
    Node のバージョンを確認し、必要に応じて Node 22 をインストールします（macOS は Homebrew、Linux の apt/dnf/yum は NodeSource のセットアップ スクリプトを使用）。
  </Step>
  <Step title="Ensure Git">
    Git が未インストールの場合はインストールします。
  </Step>
  <Step title="Install OpenClaw">
    - `npm` メソッド（デフォルト）: npm のグローバル インストール
    - `git` メソッド: リポジトリをクローン／更新し、pnpm で依存関係をインストール、ビルド後、`~/.local/bin/openclaw` にラッパーをインストール
  </Step>
  <Step title="Post-install tasks">
    - アップグレードおよび git インストール時に `openclaw doctor --non-interactive` を実行（ベスト エフォート）
    - 条件が整っている場合にオンボーディングを試行（TTY が利用可能、オンボーディングが無効化されていない、ブートストラップ／設定チェックに合格）
    - デフォルトで `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### ソース チェックアウトの検出

OpenClaw のチェックアウト内（`package.json` + `pnpm-workspace.yaml`）で実行された場合、スクリプトは次を提示します。

- チェックアウトを使用（`git`）、または
- グローバル インストールを使用（`npm`）

TTY が利用できず、かつインストール メソッドが設定されていない場合、`npm` がデフォルトになり、警告が表示されます。

無効なメソッド選択、または無効な `--install-method` 値の場合、スクリプトは終了コード `2` で終了します。

### 例（install.sh）

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| フラグ                               | 説明                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | インストール メソッドを選択（デフォルト: `npm`）。別名: `--method` エイリアス: `--method`  |
| `--npm`                           | npm メソッドのショートカット                                                                                               |
| `--git`                           | git メソッドのショートカット。別名: `--github` Alias: `--github`                              |
| `--version <version\\|dist-tag>` | npm バージョンまたは dist-tag（デフォルト: `latest`）                                                         |
| `--beta`                          | 利用可能であれば beta の dist-tag を使用し、なければ `latest` にフォールバック                                                           |
| `--git-dir <path>`                | チェックアウト ディレクトリ（デフォルト: `~/openclaw`）。別名: `--dir` Alias: `--dir` |
| `--no-git-update`                 | 既存のチェックアウトに対する `git pull` をスキップ                                                                                |
| `--no-prompt`                     | プロンプトを無効化                                                                                                      |
| `--no-onboard`                    | オンボーディングをスキップ                                                                                                  |
| `--onboard`                       | オンボーディングを有効化                                                                                                   |
| `--dry-run`                       | 変更を適用せずにアクションを印刷                                                                                               |
| `--verbose`                       | デバッグ出力を有効化（`set -x`、npm の notice レベル ログ）                                                                       |
| `--help`                          | 使用方法を表示（`-h`）                                                                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| 変数                                              | 説明                                               |
| ----------------------------------------------- | ------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | インストール メソッド                                      |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm バージョンまたは dist-tag                            |
| `OPENCLAW_BETA=0\\|1`                          | 利用可能であれば beta を使用                                |
| `OPENCLAW_GIT_DIR=<path>`                       | チェックアウト ディレクトリ                                   |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | git 更新の切り替え                                      |
| `OPENCLAW_NO_PROMPT=1`                          | プロンプトを無効化                                        |
| `OPENCLAW_NO_ONBOARD=1`                         | オンボーディングをスキップ                                    |
| `OPENCLAW_DRY_RUN=1`                            | ドライ ラン モード                                       |
| `OPENCLAW_VERBOSE=1`                            | デバッグ モード                                         |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm ログ レベル                                       |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips の挙動を制御（デフォルト: `1`） |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
すべてをローカル プレフィックス（デフォルト `~/.openclaw`）配下に配置し、システムの Node 依存を持たせたくない環境向けに設計されています。
</Info>

### フロー（install-cli.sh）

<Steps>
  <Step title="Install local Node runtime">
    Node の tarball（デフォルト `22.22.0`）を `<prefix>/tools/node-v<version>` にダウンロードし、SHA-256 を検証します。
  </Step>
  <Step title="Ensure Git">
    Git が未インストールの場合、Linux では apt/dnf/yum、macOS では Homebrew によるインストールを試みます。
  </Step>
  <Step title="Install OpenClaw under prefix">` を使用して npm でインストールし、その後 `<prefix>`、次にラッパーを`に書き込みます。<prefix>/bin/openclaw` にラッパーを書き込みます。
  </Step>
</Steps>

### 例（install-cli.sh）

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| フラグ                    | 説明                                                             |
| ---------------------- | -------------------------------------------------------------- |
| `--prefix <path>`      | インストール プレフィックス（デフォルト: `~/.openclaw`）           |
| `--version <ver>`      | OpenClaw のバージョンまたは dist-tag（デフォルト: `latest`）   |
| `--node-version <ver>` | Node バージョン（デフォルト: `22.22.0`）                   |
| `--json`               | NDJSON イベントを出力                                                 |
| `--onboard`            | インストール後に `openclaw onboard` を実行                                |
| `--no-onboard`         | オンボーディングをスキップ（デフォルト）                                           |
| `--set-npm-prefix`     | Linux で、現在のプレフィックスが書き込み不可の場合に npm プレフィックスを `~/.npm-global` に強制 |
| `--help`               | 使用方法を表示（`-h`）                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| 変数                                              | 説明                                                        |
| ----------------------------------------------- | --------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | インストール プレフィックス                                            |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw のバージョンまたは dist-tag                               |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node バージョン                                                |
| `OPENCLAW_NO_ONBOARD=1`                         | オンボーディングをスキップ                                             |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm ログ レベル                                                |
| `OPENCLAW_GIT_DIR=<path>`                       | レガシー クリーンアップの検索パス（古い `Peekaboo` サブモジュールのチェックアウトを削除する際に使用） |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips の挙動を制御（デフォルト: `1`）          |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### フロー（install.ps1）

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    PowerShell 5+ が必要です。
  </Step>
  <Step title="Ensure Node.js 22+">
    未インストールの場合、winget、次に Chocolatey、次に Scoop の順でインストールを試みます。
  </Step>
  <Step title="Install OpenClaw">
    - `npm` メソッド（デフォルト）: 選択した `-Tag` を使用した npm のグローバル インストール
    - `git` メソッド: リポジトリをクローン／更新し、pnpm でインストール／ビルド後、`%USERPROFILE%\.local\bin\openclaw.cmd` にラッパーをインストール
  </Step>
  <Step title="Post-install tasks">
    可能な場合は必要な bin ディレクトリをユーザーの PATH に追加し、その後アップグレードおよび git インストール時に `openclaw doctor --non-interactive` を実行します（ベスト エフォート）。
  </Step>
</Steps>

### 例（install.ps1）

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| フラグ                         | 説明                                                               |
| --------------------------- | ---------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | インストール メソッド（デフォルト: `npm`）                        |
| `-Tag <tag>`                | npm dist-tag（デフォルト: `latest`）                    |
| `-GitDir <path>`            | チェックアウト ディレクトリ（デフォルト: `%USERPROFILE%\openclaw`） |
| `-NoOnboard`                | オンボーディングをスキップ                                                    |
| `-NoGitUpdate`              | `git pull` をスキップ                                                 |
| `-DryRun`                   | 印刷アクションのみ                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| 変数                                   | 説明             |
| ------------------------------------ | -------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | インストール メソッド    |
| `OPENCLAW_GIT_DIR=<path>`            | チェックアウト ディレクトリ |
| `OPENCLAW_NO_ONBOARD=1`              | オンボーディングをスキップ  |
| `OPENCLAW_GIT_UPDATE=0`              | git pull を無効化  |
| `OPENCLAW_DRY_RUN=1`                 | ドライ ラン モード     |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git` が使用され、かつ Git が未インストールの場合、スクリプトは終了し、Git for Windows のリンクを表示します。
</Note>

---

## CI とオートメーション

予測可能な実行のために、非対話型のフラグ／環境変数を使用してください。

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## トラブルシューティング

<AccordionGroup>
  <Accordion title="Why is Git required?">
    `git`インストールメソッドにはGitが必要です。 
    Git は `git` インストール メソッドに必要です。`npm` インストールの場合でも、依存関係が git URL を使用する際の `spawn git ENOENT` 失敗を避けるため、Git の確認／インストールが行われます。
  
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    一部のLinuxでは、npm グローバルプレフィックスをルート所有のパスにポイントします。 
    一部の Linux 環境では、npm のグローバル プレフィックスが root 所有のパスを指しています。`install.sh` はプレフィックスを `~/.npm-global` に切り替え、（存在する場合）シェルの rc ファイルに PATH の export を追記できます。
  
  </Accordion>

  <Accordion title="sharp/libvips issues">
    
    スクリプトは、sharp がシステムの libvips に対してビルドされるのを避けるため、デフォルトで `SHARP_IGNORE_GLOBAL_LIBVIPS=1` を設定します。上書きするには次を使用してください。 上書きするには:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows をインストールし、PowerShell を再起動してからインストーラーを再実行してください。
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` を実行し、`\bin` を追記して、そのディレクトリをユーザーの PATH に追加後、PowerShell を再起動してください。
  </Accordion>

  <Accordion title="openclaw not found after install">
    通常はPATHの問題です。 
    多くの場合、PATH の問題です。[Node.js トラブルシューティング](/install/node#troubleshooting) を参照してください。
  
  </Accordion>
</AccordionGroup>
