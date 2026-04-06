xi---
read_when: - openclaw.ai/install.sh の仕組みを理解したい場合 - インストールを自動化したい場合（CI / ヘッドレス）- GitHubのチェックアウトからインストールしたい場合
summary: インストーラースクリプト（install.sh、install-cli.sh、install.ps1）の仕組み、フラグ、および自動化
title: インストーラーの内部構造
x-i18n:
generated_at: "2026-04-03T00:00:00Z"
model: claude-sonnet-4-6
provider: anthropic
source_hash: 908e800b58e7d5d7731ccc979714d49841f142ed0d909752846c9320a0927642
source_path: install/installer.md
workflow: 15

---

# インストーラーの内部構造

OpenClawは3つのインストーラースクリプトを提供しており、`openclaw.ai`から配信されています。

| スクリプト                         | プラットフォーム      | 機能                                                                                                               |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`install.sh`](#installsh)         | macOS / Linux / WSL   | 必要に応じてNodeをインストールし、npm（デフォルト）またはgitでOpenClawをインストール。オンボーディングも実行可能。 |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL   | Nodeと OpenClawをローカルプレフィックス（`~/.openclaw`）にインストール。rootは不要。                               |
| [`install.ps1`](#installps1)       | Windows（PowerShell） | 必要に応じてNodeをインストールし、npm（デフォルト）またはgitでOpenClawをインストール。オンボーディングも実行可能。 |

## クイックコマンド

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
インストールは成功したが新しいターミナルで `openclaw` が見つからない場合は、[Node.jsのトラブルシューティング](/install/node#troubleshooting)を参照してください。
</Note>

---

<a id="installsh"></a>

## install.sh

<Tip>
macOS/Linux/WSLでのほとんどの対話型インストールに推奨されます。
</Tip>

### フロー（install.sh）

<Steps>
  <Step title="OSを検出">
    macOSおよびLinux（WSLを含む）をサポートします。macOSが検出された場合、Homebrewがなければインストールします。
  </Step>
  <Step title="デフォルトでNode.js 24を確認">
    Nodeのバージョンを確認し、必要に応じてNode 24をインストールします（macOSではHomebrew、Linux apt/dnf/yumではNodeSourceセットアップスクリプトを使用）。OpenClawは互換性のためにNode 22 LTS（現在`22.14+`）もサポートしています。
  </Step>
  <Step title="Gitを確認">
    Gitがなければインストールします。
  </Step>
  <Step title="OpenClawをインストール">
    - `npm`方式（デフォルト）: グローバルnpmインストール
    - `git`方式: リポジトリをクローン/更新し、pnpmで依存関係をインストール、ビルドし、`~/.local/bin/openclaw`にラッパーをインストール
  </Step>
  <Step title="インストール後のタスク">
    - アップグレードおよびgitインストール時に`openclaw doctor --non-interactive`を実行（ベストエフォート）
    - 適切な場合にオンボーディングを試行（TTYが利用可能、オンボーディングが無効化されておらず、bootstrap/configチェックが通過した場合）
    - `SHARP_IGNORE_GLOBAL_LIBVIPS=1`をデフォルト設定
  </Step>
</Steps>

### ソースチェックアウトの検出

OpenClawのチェックアウト内（`package.json` + `pnpm-workspace.yaml`）で実行された場合、スクリプトは以下を提示します：

- チェックアウトを使用する（`git`）、または
- グローバルインストールを使用する（`npm`）

TTYが利用できず、インストール方式が設定されていない場合は、`npm`がデフォルトとなり、警告が表示されます。

スクリプトは無効な方式の選択または無効な`--install-method`の値に対してコード`2`で終了します。

### 例（install.sh）

<Tabs>
  <Tab title="デフォルト">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="オンボーディングをスキップ">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Gitインストール">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="GitHub mainをnpm経由で">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --version main
    ```
  </Tab>
  <Tab title="ドライラン">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="フラグリファレンス">

| フラグ                                | 説明                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `--install-method npm\|git`           | インストール方式を選択（デフォルト: `npm`）。エイリアス: `--method`         |
| `--npm`                               | npm方式のショートカット                                                     |
| `--git`                               | git方式のショートカット。エイリアス: `--github`                             |
| `--version <version\|dist-tag\|spec>` | npmバージョン、dist-tag、またはパッケージスペック（デフォルト: `latest`）   |
| `--beta`                              | 利用可能であればbeta dist-tagを使用し、なければ`latest`にフォールバック     |
| `--git-dir <path>`                    | チェックアウトディレクトリ（デフォルト: `~/openclaw`）。エイリアス: `--dir` |
| `--no-git-update`                     | 既存のチェックアウトの`git pull`をスキップ                                  |
| `--no-prompt`                         | プロンプトを無効化                                                          |
| `--no-onboard`                        | オンボーディングをスキップ                                                  |
| `--onboard`                           | オンボーディングを有効化                                                    |
| `--dry-run`                           | 変更を適用せずにアクションを表示                                            |
| `--verbose`                           | デバッグ出力を有効化（`set -x`、npmのnoticeレベルのログ）                   |
| `--help`                              | 使い方を表示（`-h`）                                                        |

  </Accordion>

  <Accordion title="環境変数リファレンス">

| 変数                                                    | 説明                                              |
| ------------------------------------------------------- | ------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`                      | インストール方式                                  |
| `OPENCLAW_VERSION=latest\|next\|main\|<semver>\|<spec>` | npmバージョン、dist-tag、またはパッケージスペック |
| `OPENCLAW_BETA=0\|1`                                    | 利用可能であればbetaを使用                        |
| `OPENCLAW_GIT_DIR=<path>`                               | チェックアウトディレクトリ                        |
| `OPENCLAW_GIT_UPDATE=0\|1`                              | gitアップデートの切り替え                         |
| `OPENCLAW_NO_PROMPT=1`                                  | プロンプトを無効化                                |
| `OPENCLAW_NO_ONBOARD=1`                                 | オンボーディングをスキップ                        |
| `OPENCLAW_DRY_RUN=1`                                    | ドライランモード                                  |
| `OPENCLAW_VERBOSE=1`                                    | デバッグモード                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice`             | npmのログレベル                                   |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`                      | sharp/libvipsの動作を制御（デフォルト: `1`）      |

  </Accordion>
</AccordionGroup>

---

<a id="install-clish"></a>

## install-cli.sh

<Info>
すべてをローカルプレフィックス（デフォルト`~/.openclaw`）以下に置き、システムNodeの依存関係をなくしたい環境向けに設計されています。
</Info>

### フロー（install-cli.sh）

<Steps>
  <Step title="ローカルNodeランタイムをインストール">
    固定されたサポート済みNode LTSのtarball（バージョンはスクリプトに埋め込まれており個別に更新）を`<prefix>/tools/node-v<version>`にダウンロードし、SHA-256で検証します。
  </Step>
  <Step title="Gitを確認">
    Gitがない場合、LinuxではaやDnf/yum、macOSではHomebrewでインストールを試みます。
  </Step>
  <Step title="プレフィックス以下にOpenClawをインストール">
    `--prefix <prefix>`を使用してnpmでインストールし、`<prefix>/bin/openclaw`にラッパーを書き込みます。
  </Step>
</Steps>

### 例（install-cli.sh）

<Tabs>
  <Tab title="デフォルト">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="カスタムプレフィックスとバージョン">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="自動化用JSON出力">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="オンボーディングを実行">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="フラグリファレンス">

| フラグ                 | 説明                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | インストールプレフィックス（デフォルト: `~/.openclaw`）                                       |
| `--version <ver>`      | OpenClawのバージョンまたはdist-tag（デフォルト: `latest`）                                    |
| `--node-version <ver>` | Nodeのバージョン（デフォルト: `22.22.0`）                                                     |
| `--json`               | NDJSONイベントを出力                                                                          |
| `--onboard`            | インストール後に`openclaw onboard`を実行                                                      |
| `--no-onboard`         | オンボーディングをスキップ（デフォルト）                                                      |
| `--set-npm-prefix`     | Linuxで現在のプレフィックスが書き込み不可の場合、npmプレフィックスを`~/.npm-global`に強制設定 |
| `--help`               | 使い方を表示（`-h`）                                                                          |

  </Accordion>

  <Accordion title="環境変数リファレンス">

| 変数                                        | 説明                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | インストールプレフィックス                                                                   |
| `OPENCLAW_VERSION=<ver>`                    | OpenClawのバージョンまたはdist-tag                                                           |
| `OPENCLAW_NODE_VERSION=<ver>`               | Nodeのバージョン                                                                             |
| `OPENCLAW_NO_ONBOARD=1`                     | オンボーディングをスキップ                                                                   |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npmのログレベル                                                                              |
| `OPENCLAW_GIT_DIR=<path>`                   | レガシークリーンアップの検索パス（古い`Peekaboo`サブモジュールのチェックアウト削除時に使用） |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvipsの動作を制御（デフォルト: `1`）                                                 |

  </Accordion>
</AccordionGroup>

---

<a id="installps1"></a>

## install.ps1

### フロー（install.ps1）

<Steps>
  <Step title="PowerShell + Windows環境を確認">
    PowerShell 5以上が必要です。
  </Step>
  <Step title="デフォルトでNode.js 24を確認">
    なければwinget、次にChocolatey、次にScoopでインストールを試みます。互換性のためにNode 22 LTS（現在`22.14+`）もサポートされています。
  </Step>
  <Step title="OpenClawをインストール">
    - `npm`方式（デフォルト）: 選択した`-Tag`を使用してグローバルnpmインストール
    - `git`方式: リポジトリをクローン/更新し、pnpmでインストール/ビルドし、`%USERPROFILE%\.local\bin\openclaw.cmd`にラッパーをインストール
  </Step>
  <Step title="インストール後のタスク">
    必要に応じてユーザーPATHに必要なbinディレクトリを追加し、アップグレードおよびgitインストール時に`openclaw doctor --non-interactive`を実行（ベストエフォート）。
  </Step>
</Steps>

### 例（install.ps1）

<Tabs>
  <Tab title="デフォルト">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Gitインストール">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="GitHub mainをnpm経由で">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag main
    ```
  </Tab>
  <Tab title="カスタムgitディレクトリ">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="ドライラン">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
  <Tab title="デバッグトレース">
    ```powershell
    # install.ps1にはまだ専用の-Verboseフラグがありません。
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="フラグリファレンス">

| フラグ                      | 説明                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `-InstallMethod npm\|git`   | インストール方式（デフォルト: `npm`）                                       |
| `-Tag <tag\|version\|spec>` | npmのdist-tag、バージョン、またはパッケージスペック（デフォルト: `latest`） |
| `-GitDir <path>`            | チェックアウトディレクトリ（デフォルト: `%USERPROFILE%\openclaw`）          |
| `-NoOnboard`                | オンボーディングをスキップ                                                  |
| `-NoGitUpdate`              | `git pull`をスキップ                                                        |
| `-DryRun`                   | アクションのみを表示                                                        |

  </Accordion>

  <Accordion title="環境変数リファレンス">

| 変数                               | 説明                       |
| ---------------------------------- | -------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | インストール方式           |
| `OPENCLAW_GIT_DIR=<path>`          | チェックアウトディレクトリ |
| `OPENCLAW_NO_ONBOARD=1`            | オンボーディングをスキップ |
| `OPENCLAW_GIT_UPDATE=0`            | git pullを無効化           |
| `OPENCLAW_DRY_RUN=1`               | ドライランモード           |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git`を使用してGitがない場合、スクリプトはGit for WindowsのリンクをGit for Windowsのリンクを表示して終了します。
</Note>

---

## CIと自動化

予測可能な実行のために非対話型フラグ/環境変数を使用してください。

<Tabs>
  <Tab title="install.sh（非対話型npm）">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh（非対話型git）">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh（JSON）">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1（オンボーディングをスキップ）">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## トラブルシューティング

<AccordionGroup>
  <Accordion title="なぜGitが必要なのか？">
    Gitは`git`インストール方式に必要です。`npm`インストールでも、依存関係がgit URLを使用する場合に`spawn git ENOENT`エラーを防ぐためにGitが確認/インストールされます。
  </Accordion>

  <Accordion title="LinuxでnpmがEACCESエラーになる理由">
    一部のLinux環境ではnpmのグローバルプレフィックスがroot所有のパスを指しています。`install.sh`はプレフィックスを`~/.npm-global`に切り替え、シェルrcファイル（存在する場合）にPATHのエクスポートを追加できます。
  </Accordion>

  <Accordion title="sharp/libvipsの問題">
    スクリプトはデフォルトで`SHARP_IGNORE_GLOBAL_LIBVIPS=1`を設定し、sharpがシステムのlibvipsに対してビルドされるのを防ぎます。上書きするには：

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windowsをインストールし、PowerShellを再起動してからインストーラーを再実行してください。
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix`を実行し、そのディレクトリをユーザーPATHに追加します（Windowsでは`\bin`サフィックスは不要）。その後PowerShellを再起動してください。
  </Accordion>

  <Accordion title="Windows: 詳細なインストーラー出力の取得方法">
    `install.ps1`は現在`-Verbose`スイッチを公開していません。
    スクリプトレベルの診断にはPowerShellトレースを使用してください：

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="インストール後にopenclaw が見つからない">
    通常PATHの問題です。[Node.jsのトラブルシューティング](/install/node#troubleshooting)を参照してください。
  </Accordion>
</AccordionGroup>
