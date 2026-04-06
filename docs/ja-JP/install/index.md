---
read_when:
    - はじめにのクイックスタート以外のインストール方法が必要な場合
    - クラウドプラットフォームにデプロイしたい場合
    - 更新、移行、またはアンインストールが必要な場合
summary: OpenClawのインストール — インストーラースクリプト、npm/pnpm、ソースから、Docker、その他
title: インストール
x-i18n:
    generated_at: "2026-04-02T08:33:18Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: fc1a6c92b1f257d8c1ff49d1a621dce107b113165279941ba147b289e85f81b4
    source_path: install/index.md
    workflow: 15
---

# インストール

## 推奨: インストーラースクリプト

最も速いインストール方法です。OSを検出し、必要に応じてNodeをインストールし、OpenClawをインストールして、オンボーディングを起動します。

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

オンボーディングを実行せずにインストールするには:

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

すべてのフラグとCI/自動化オプションについては、[インストーラーの内部構造](/install/installer)を参照してください。

## システム要件

- **Node 24**（推奨）またはNode 22.14以上 — インストーラースクリプトが自動的に処理します
- **macOS、Linux、またはWindows** — ネイティブWindowsとWSL2の両方がサポートされています。WSL2の方がより安定しています。[Windows](/platforms/windows)を参照してください。
- `pnpm` はソースからビルドする場合にのみ必要です

## 代替インストール方法

### npmまたはpnpm

Nodeを既に自分で管理している場合:

<Tabs>
  <Tab title="npm">
    ```bash
    npm install -g openclaw@latest
    openclaw onboard --install-daemon
    ```
  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g openclaw@latest
    pnpm approve-builds -g
    openclaw onboard --install-daemon
    ```

    <Note>
    pnpmではビルドスクリプトを含むパッケージに対して明示的な承認が必要です。初回インストール後に `pnpm approve-builds -g` を実行してください。
    </Note>

  </Tab>
</Tabs>

<Accordion title="トラブルシューティング: sharpのビルドエラー（npm）">
  グローバルにインストールされたlibvipsが原因で `sharp` が失敗する場合:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
```

</Accordion>

### ソースから

コントリビューターやローカルチェックアウトから実行したい方向け:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install && pnpm ui:build && pnpm build
pnpm link --global
openclaw onboard --install-daemon
```

またはリンクをスキップして、リポジトリ内から `pnpm openclaw ...` を使用することもできます。完全な開発ワークフローについては[セットアップ](/start/setup)を参照してください。

### GitHubのmainからインストール

```bash
npm install -g github:openclaw/openclaw#main
```

### コンテナとパッケージマネージャー

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    コンテナ化またはヘッドレスデプロイ。
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    Dockerに代わるルートレスコンテナ。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix flakeによる宣言的インストール。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自動化されたフリートプロビジョニング。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bunランタイムを使用したCLI専用の利用。
  </Card>
</CardGroup>

## インストールの確認

```bash
openclaw --version      # CLIが利用可能か確認
openclaw doctor         # 設定の問題をチェック
openclaw gateway status # Gateway ゲートウェイが実行中か確認
```

## ホスティングとデプロイ

OpenClawをクラウドサーバーやVPSにデプロイ:

<CardGroup cols={3}>
  <Card title="VPS" href="/vps">任意のLinux VPS</Card>
  <Card title="Docker VM" href="/install/docker-vm-runtime">共有Docker手順</Card>
  <Card title="Kubernetes" href="/install/kubernetes">K8s</Card>
  <Card title="Fly.io" href="/install/fly">Fly.io</Card>
  <Card title="Hetzner" href="/install/hetzner">Hetzner</Card>
  <Card title="GCP" href="/install/gcp">Google Cloud</Card>
  <Card title="Azure" href="/install/azure">Azure</Card>
  <Card title="Railway" href="/install/railway">Railway</Card>
  <Card title="Render" href="/install/render">Render</Card>
  <Card title="Northflank" href="/install/northflank">Northflank</Card>
</CardGroup>

## 更新、移行、またはアンインストール

<CardGroup cols={3}>
  <Card title="更新" href="/install/updating" icon="refresh-cw">
    OpenClawを最新の状態に保つ。
  </Card>
  <Card title="移行" href="/install/migrating" icon="arrow-right">
    新しいマシンに移行する。
  </Card>
  <Card title="アンインストール" href="/install/uninstall" icon="trash-2">
    OpenClawを完全に削除する。
  </Card>
</CardGroup>

## トラブルシューティング: `openclaw` が見つからない

インストールは成功したのにターミナルで `openclaw` が見つからない場合:

```bash
node -v           # Nodeはインストールされている?
npm prefix -g     # グローバルパッケージはどこにある?
echo "$PATH"      # グローバルbinディレクトリはPATHに含まれている?
```

`$(npm prefix -g)/bin` が `$PATH` に含まれていない場合は、シェルのスタートアップファイル（`~/.zshrc` または `~/.bashrc`）に追加してください:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

その後、新しいターミナルを開いてください。詳細は[Nodeセットアップ](/install/node)を参照してください。
