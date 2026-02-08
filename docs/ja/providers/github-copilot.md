---
summary: "デバイスフローを使用して OpenClaw から GitHub Copilot にサインインします"
read_when:
  - GitHub Copilot をモデルプロバイダーとして使用したい場合
  - `openclaw models auth login-github-copilot` フローが必要な場合
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:47Z
---

# GitHub Copilot

## GitHub Copilot とは何ですか？

GitHub Copilot は、GitHub が提供する AI コーディングアシスタントです。GitHub アカウントおよびプランに基づいて Copilot モデルへのアクセスを提供します。OpenClaw は、2 つの異なる方法で Copilot をモデルプロバイダーとして使用できます。

## OpenClaw で Copilot を使用する 2 つの方法

### 1) 組み込みの GitHub Copilot プロバイダー（`github-copilot`）

ネイティブのデバイスログインフローを使用して GitHub トークンを取得し、OpenClaw の実行時にそれを Copilot API トークンと交換します。VS Code を必要としないため、これが**デフォルト**かつ最も簡単な方法です。

### 2) Copilot Proxy プラグイン（`copilot-proxy`）

**Copilot Proxy** の VS Code 拡張機能をローカルブリッジとして使用します。OpenClaw はプロキシの `/v1` エンドポイントと通信し、そこで設定したモデルリストを使用します。すでに VS Code で Copilot Proxy を実行している場合や、それを経由してルーティングする必要がある場合に選択してください。プラグインを有効にし、VS Code 拡張機能を起動したままにする必要があります。

GitHub Copilot をモデルプロバイダーとして使用します（`github-copilot`）。ログインコマンドは GitHub のデバイスフローを実行し、認証プロファイルを保存し、そのプロファイルを使用するように設定を更新します。

## CLI セットアップ

```bash
openclaw models auth login-github-copilot
```

URL にアクセスしてワンタイムコードを入力するように求められます。完了するまでターミナルを開いたままにしてください。

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

## 注記

- 対話型の TTY が必要です。ターミナルで直接実行してください。
- Copilot モデルの利用可否はプランによって異なります。モデルが拒否された場合は、別の ID（例: `github-copilot/gpt-4.1`）を試してください。
- ログインにより、GitHub トークンが認証プロファイルストアに保存され、OpenClaw の実行時に Copilot API トークンへ交換されます。
