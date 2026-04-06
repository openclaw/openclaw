---
read_when:
    - GitHub Copilot をモデルプロバイダーとして使用したい場合
    - \`openclaw models auth login-github-copilot\` フローが必要な場合
summary: デバイスフローを使用して OpenClaw から GitHub Copilot にサインインする
title: GitHub Copilot
x-i18n:
    generated_at: "2026-04-02T08:37:56Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 503e0496d92c921e2f7111b1b4ba16374f5b781643bfbc6cb69cea97d9395c25
    source_path: providers/github-copilot.md
    workflow: 15
---

# GitHub Copilot

## GitHub Copilot とは？

GitHub Copilot は GitHub の AI コーディングアシスタントです。GitHub アカウントとプランに応じた Copilot モデルへのアクセスを提供します。OpenClaw では2つの方法で Copilot をモデルプロバイダーとして使用できます。

## OpenClaw で Copilot を使用する2つの方法

### 1) 組み込み GitHub Copilot プロバイダー（`github-copilot`）

ネイティブのデバイスログインフローを使用して GitHub トークンを取得し、OpenClaw の実行時に Copilot API トークンと交換します。VS Code が不要なため、これが**デフォルト**かつ最もシンプルな方法です。

### 2) Copilot Proxy プラグイン（`copilot-proxy`）

**Copilot Proxy** VS Code 拡張機能をローカルブリッジとして使用します。OpenClaw はプロキシの `/v1` エンドポイントと通信し、そこで設定したモデルリストを使用します。既に VS Code で Copilot Proxy を実行している場合や、それを経由してルーティングする必要がある場合に選択してください。プラグインを有効にし、VS Code 拡張機能を実行したままにする必要があります。

GitHub Copilot をモデルプロバイダー（`github-copilot`）として使用します。ログインコマンドは GitHub デバイスフローを実行し、認証プロファイルを保存して、そのプロファイルを使用するように設定を更新します。

## CLI セットアップ

```bash
openclaw models auth login-github-copilot
```

URL にアクセスしてワンタイムコードを入力するよう求められます。完了するまでターミナルを開いたままにしてください。

### オプションフラグ

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## デフォルトモデルの設定

```bash
openclaw models set github-copilot/gpt-4o
```

### 設定スニペット

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 注意事項

- インタラクティブな TTY が必要です。ターミナルで直接実行してください。
- Copilot のモデル利用可否はプランに依存します。モデルが拒否された場合は、別の ID を試してください（例: `github-copilot/gpt-4.1`）。
- ログインは GitHub トークンを認証プロファイルストアに保存し、OpenClaw の実行時に Copilot API トークンと交換します。
