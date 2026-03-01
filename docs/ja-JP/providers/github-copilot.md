---
summary: "デバイスフローを使ってOpenClawからGitHub Copilotにサインインする"
read_when:
  - GitHub CopilotをモデルプロバイダーとしてOpenClawで使いたい場合
  - `openclaw models auth login-github-copilot` フローが必要な場合
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilotとは

GitHub CopilotはGitHubのAIコーディングアシスタントです。GitHubアカウントとプランに応じてCopilotモデルへのアクセスを提供します。OpenClawは2つの異なる方法でCopilotをモデルプロバイダーとして利用できます。

## OpenClawでCopilotを使う2つの方法

### 1) 組み込みGitHub Copilotプロバイダー（`github-copilot`）

ネイティブのデバイスログインフローを使用してGitHubトークンを取得し、OpenClaw実行時にCopilot APIトークンと交換します。VS Codeが不要なため、これが**デフォルト**で最もシンプルな方法です。

### 2) Copilot Proxyプラグイン（`copilot-proxy`）

**Copilot Proxy** VS Code拡張機能をローカルブリッジとして使用します。OpenClawはプロキシの `/v1` エンドポイントと通信し、そこで設定したモデルリストを使用します。すでにVS CodeでCopilot Proxyを実行しているか、それを通じてルーティングする必要がある場合に選択してください。プラグインを有効にしてVS Code拡張機能を実行し続ける必要があります。

GitHub CopilotをモデルプロバイダーとしてOpenClawで使用します（`github-copilot`）。ログインコマンドはGitHubデバイスフローを実行し、認証プロファイルを保存し、そのプロファイルを使用するように設定を更新します。

## CLIセットアップ

```bash
openclaw models auth login-github-copilot
```

URLにアクセスしてワンタイムコードを入力するよう求められます。完了するまでターミナルを開いたままにしてください。

### オプションフラグ

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## デフォルトモデルを設定する

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

- インタラクティブなTTYが必要です。ターミナルで直接実行してください。
- Copilotモデルの利用可能性はプランによって異なります。モデルが拒否された場合は別のIDを試してください（例: `github-copilot/gpt-4.1`）。
- ログインはGitHubトークンを認証プロファイルストアに保存し、OpenClaw実行時にCopilot APIトークンと交換します。
