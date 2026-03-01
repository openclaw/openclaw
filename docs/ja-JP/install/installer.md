---
summary: "インストーラースクリプト（install.sh、install-cli.sh、install.ps1）の仕組み、フラグ、および自動化"
read_when:
  - openclaw.ai/install.shの仕組みを理解したい場合
  - インストールを自動化したい場合（CI / ヘッドレス）
  - GitHubチェックアウトからインストールしたい場合
title: "インストーラーの内部構造"
---

# インストーラーの内部構造

OpenClawは`openclaw.ai`から提供される3つのインストーラースクリプトを同梱しています。

| スクリプト                            | プラットフォーム       | 機能                                                                                         |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | 必要に応じてNodeをインストールし、npm（デフォルト）またはgitでOpenClawをインストールし、オンボーディングを実行できます。 |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | ローカルプレフィックス（`~/.openclaw`）にNodeとOpenClawをインストールします。root権限は不要です。              |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | 必要に応じてNodeをインストールし、npm（デフォルト）またはgitでOpenClawをインストールし、オンボーディングを実行できます。 |

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
インストールは成功したが、新しいターミナルで`openclaw`が見つからない場合は、[Node.jsトラブルシューティング](/install/node#troubleshooting)を参照してください。
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSLでのほとんどの対話型インストールに推奨されます。
</Tip>

### フロー（install.sh）

<Steps>
  <Step title="OSの検出">
    macOSとLinux（WSLを含む）をサポートしています。macOSが検出された場合、Homebrewがなければインストールします。
  </Step>
  <Step title="Node.js 22+の確認">
    Nodeのバージョンを確認し、必要に応じてNode 22をインストールします（macOSではHomebrew、Linuxではapt/dnf/yum用のNodeSourceセットアップスクリプト）。
  </Step>
  <Step title="Gitの確認">
    Gitが未インストールの場合はインストールします。
  </Step>
  <Step title="OpenClawのインストール">
    - `npm`方式（デフォルト）：グローバルnpmインストール
    - `git`方式：リポジトリのクローン/更新、pnpmで依存関係をインストール、ビルド、その後`~/.local/bin/openclaw`にラッパーをインストール
  </Step>
  <Step title="インストール後のタスク">
    - アップグレードおよびgitインストール時に`openclaw doctor --non-interactive`を実行（ベストエフォート）
    - 適切な場合にオンボーディングを試行（TTYが利用可能、オンボーディングが無効化されていない、ブートストラップ/設定チェックに合格した場合）
    - デフォルトで`SHARP_IGNORE_GLOBAL_LIBVIPS=1`を設定
  </Step>
</Steps>

### ソースチェックアウトの検出

OpenClawチェックアウト内（`package.json` + `pnpm-workspace.yaml`）で実行された場合、スクリプトは以下を提案します：

- チェックアウトを使用（`git`）、または
- グローバルインストールを使用（`npm`）

TTYが利用できず、インストール方法が設定されていない場合、デフォルトで`npm`を使用し、警告を表示します。

無効な方法の選択や無効な`--install-method`値の場合、スクリプトはコード`2`で終了します。

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
  <Tab title="ドライラン">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="フラグリファレンス">

| フラグ                            | 説明                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `--install-method npm\|git`     | インストール方法を選択（デフォルト：`npm`）。エイリアス：`--method`  |
| `--npm`                         | npm方式のショートカット                                    |
| `--git`                         | git方式のショートカット。エイリアス：`--github`                 |
| `--version <version\|dist-tag>` | npmバージョンまたはdist-tag（デフォルト：`latest`）                |
| `--beta`                        | 利用可能であればbeta dist-tagを使用、なければ`latest`にフォールバック  |
| `--git-dir <path>`              | チェックアウトディレクトリ（デフォルト：`~/openclaw`）。エイリアス：`--dir` |
| `--no-git-update`               | 既存のチェックアウトで`git pull`をスキップ                      |
| `--no-prompt`                   | プロンプトを無効化                                            |
| `--no-onboard`                  | オンボーディングをスキップ                                    |
| `--onboard`                     | オンボーディングを有効化                                      |
| `--dry-run`                     | 変更を適用せずにアクションを表示                               |
| `--verbose`                     | デバッグ出力を有効化（`set -x`、npm notice-levelログ）      |
| `--help`                        | 使用方法を表示（`-h`）                                       |

  </Accordion>

  <Accordion title="環境変数リファレンス">

| 変数                                    | 説明                                   |
| ------------------------------------------- | --------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | インストール方法                                |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npmバージョンまたはdist-tag                       |
| `OPENCLAW_BETA=0\|1`                        | 利用可能であればbetaを使用                         |
| `OPENCLAW_GIT_DIR=<path>`                   | チェックアウトディレクトリ                            |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | git更新の切り替え                            |
| `OPENCLAW_NO_PROMPT=1`                      | プロンプトを無効化                               |
| `OPENCLAW_NO_ONBOARD=1`                     | オンボーディングをスキップ                               |
| `OPENCLAW_DRY_RUN=1`                        | ドライランモード                                  |
| `OPENCLAW_VERBOSE=1`                        | デバッグモード                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npmログレベル                                 |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvipsの動作制御（デフォルト：`1`） |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
ローカルプレフィックス（デフォルト`~/.openclaw`）にすべてをインストールし、システムNodeに依存しない環境向けに設計されています。
</Info>

### フロー（install-cli.sh）

<Steps>
  <Step title="ローカルNodeランタイムのインストール">
    Nodeのtarball（デフォルト`22.22.0`）を`<prefix>/tools/node-v<version>`にダウンロードし、SHA-256を検証します。
  </Step>
  <Step title="Gitの確認">
    Gitが未インストールの場合、Linuxではaptまたはdnfまたはyumで、macOSではHomebrewでインストールを試みます。
  </Step>
  <Step title="プレフィックス下にOpenClawをインストール">
    npmで`--prefix <prefix>`を使用してインストールし、`<prefix>/bin/openclaw`にラッパーを書き込みます。
  </Step>
</Steps>

### 例（install-cli.sh）

<Tabs>
  <Tab title="デフォルト">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="カスタムプレフィックス + バージョン">
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

| フラグ                   | 説明                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--prefix <path>`      | インストールプレフィックス（デフォルト：`~/.openclaw`）                                         |
| `--version <ver>`      | OpenClawのバージョンまたはdist-tag（デフォルト：`latest`）                                |
| `--node-version <ver>` | Nodeバージョン（デフォルト：`22.22.0`）                                               |
| `--json`               | NDJSONイベントを出力                                                              |
| `--onboard`            | インストール後に`openclaw onboard`を実行                                            |
| `--no-onboard`         | オンボーディングをスキップ（デフォルト）                                                       |
| `--set-npm-prefix`     | Linuxで、現在のプレフィックスが書き込み不可の場合、npmプレフィックスを`~/.npm-global`に強制 |
| `--help`               | 使用方法を表示（`-h`）                                                               |

  </Accordion>

  <Accordion title="環境変数リファレンス">

| 変数                                    | 説明                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | インストールプレフィックス                                                                    |
| `OPENCLAW_VERSION=<ver>`                    | OpenClawのバージョンまたはdist-tag                                                      |
| `OPENCLAW_NODE_VERSION=<ver>`               | Nodeバージョン                                                                      |
| `OPENCLAW_NO_ONBOARD=1`                     | オンボーディングをスキップ                                                                   |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npmログレベル                                                                     |
| `OPENCLAW_GIT_DIR=<path>`                   | レガシークリーンアップ参照パス（古い`Peekaboo`サブモジュールチェックアウトの削除時に使用） |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvipsの動作制御（デフォルト：`1`）                                     |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### フロー（install.ps1）

<Steps>
  <Step title="PowerShell + Windows環境の確認">
    PowerShell 5+が必要です。
  </Step>
  <Step title="Node.js 22+の確認">
    未インストールの場合、winget、次にChocolatey、最後にScoopでインストールを試みます。
  </Step>
  <Step title="OpenClawのインストール">
    - `npm`方式（デフォルト）：選択した`-Tag`を使用したグローバルnpmインストール
    - `git`方式：リポジトリのクローン/更新、pnpmでインストール/ビルド、`%USERPROFILE%\.local\bin\openclaw.cmd`にラッパーをインストール
  </Step>
  <Step title="インストール後のタスク">
    可能な場合、必要なbinディレクトリをユーザーPATHに追加し、アップグレードおよびgitインストール時に`openclaw doctor --non-interactive`を実行します（ベストエフォート）。
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
    # install.ps1にはまだ専用の-Verboseフラグはありません。
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="フラグリファレンス">

| フラグ                      | 説明                                            |
| ------------------------- | ------------------------------------------------------ |
| `-InstallMethod npm\|git` | インストール方法（デフォルト：`npm`）                        |
| `-Tag <tag>`              | npm dist-tag（デフォルト：`latest`）                       |
| `-GitDir <path>`          | チェックアウトディレクトリ（デフォルト：`%USERPROFILE%\openclaw`） |
| `-NoOnboard`              | オンボーディングをスキップ                                        |
| `-NoGitUpdate`            | `git pull`をスキップ                                        |
| `-DryRun`                 | アクションの表示のみ                                     |

  </Accordion>

  <Accordion title="環境変数リファレンス">

| 変数                           | 説明        |
| ---------------------------------- | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | インストール方法     |
| `OPENCLAW_GIT_DIR=<path>`          | チェックアウトディレクトリ |
| `OPENCLAW_NO_ONBOARD=1`            | オンボーディングをスキップ    |
| `OPENCLAW_GIT_UPDATE=0`            | git pullを無効化   |
| `OPENCLAW_DRY_RUN=1`               | ドライランモード       |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git`を使用してGitが未インストールの場合、スクリプトは終了し、Git for Windowsのリンクを表示します。
</Note>

---

## CIと自動化

予測可能な実行のために、非対話型フラグ/環境変数を使用してください。

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
  <Tab title="install.ps1（オンボーディングスキップ）">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## トラブルシューティング

<AccordionGroup>
  <Accordion title="Gitが必要な理由">
    Gitは`git`インストール方法に必要です。`npm`インストールの場合でも、依存関係がgit URLを使用する際の`spawn git ENOENT`エラーを避けるために、Gitのチェック/インストールが行われます。
  </Accordion>

  <Accordion title="LinuxでnpmがEACCESエラーを返す理由">
    一部のLinux環境では、npmのグローバルプレフィックスがroot所有のパスを指しています。`install.sh`はプレフィックスを`~/.npm-global`に切り替え、シェルrcファイル（存在する場合）にPATHのエクスポートを追加できます。
  </Accordion>

  <Accordion title="sharp/libvipsの問題">
    スクリプトはデフォルトで`SHARP_IGNORE_GLOBAL_LIBVIPS=1`を設定し、sharpがシステムのlibvipsに対してビルドすることを防ぎます。オーバーライドするには：

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows：「npm error spawn git / ENOENT」'>
    Git for Windowsをインストールし、PowerShellを再起動して、インストーラーを再実行してください。
  </Accordion>

  <Accordion title='Windows：「openclaw is not recognized」'>
    `npm config get prefix`を実行し、`\bin`を追加して、そのディレクトリをユーザーPATHに追加してから、PowerShellを再起動してください。
  </Accordion>

  <Accordion title="Windows：インストーラーの詳細出力を取得する方法">
    `install.ps1`は現在`-Verbose`スイッチを公開していません。
    スクリプトレベルの診断にはPowerShellトレースを使用してください：

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="インストール後にopenclaw が見つからない">
    通常はPATHの問題です。[Node.jsトラブルシューティング](/install/node#troubleshooting)を参照してください。
  </Accordion>
</AccordionGroup>
