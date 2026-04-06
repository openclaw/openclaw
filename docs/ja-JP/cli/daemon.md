---
read_when:
    - スクリプトでまだ `openclaw daemon ...` を使用している場合
    - サービスライフサイクルコマンド（install/start/stop/restart/status）が必要な場合
summary: '`openclaw daemon` のCLIリファレンス（Gateway ゲートウェイサービス管理のレガシーエイリアス）'
title: daemon
x-i18n:
    generated_at: "2026-04-02T07:33:16Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: acedaa176d9cb038588def94e563ee649ff6bee3518eb1213f1434f2bf92abde
    source_path: cli/daemon.md
    workflow: 15
---

# `openclaw daemon`

Gateway ゲートウェイサービス管理コマンドのレガシーエイリアスです。

`openclaw daemon ...` は `openclaw gateway ...` サービスコマンドと同じサービス制御サーフェスにマッピングされます。

## 使い方

```bash
openclaw daemon status
openclaw daemon install
openclaw daemon start
openclaw daemon stop
openclaw daemon restart
openclaw daemon uninstall
```

## サブコマンド

- `status`：サービスのインストール状態を表示し、Gateway ゲートウェイの正常性をプローブ
- `install`：サービスをインストール（`launchd`/`systemd`/`schtasks`）
- `uninstall`：サービスを削除
- `start`：サービスを開始
- `stop`：サービスを停止
- `restart`：サービスを再起動

## 共通オプション

- `status`：`--url`、`--token`、`--password`、`--timeout`、`--no-probe`、`--require-rpc`、`--deep`、`--json`
- `install`：`--port`、`--runtime <node|bun>`、`--token`、`--force`、`--json`
- ライフサイクル（`uninstall|start|stop|restart`）：`--json`

注意事項：

- `status` は可能な場合、プローブ認証のために設定済みの認証SecretRefを解決します。
- このコマンドパスで必要な認証SecretRefが未解決の場合、`daemon status --json` はプローブの接続/認証が失敗した際に `rpc.authWarning` を報告します。`--token`/`--password` を明示的に渡すか、先にシークレットソースを解決してください。
- プローブが成功した場合、誤検知を避けるために未解決の認証ref警告は抑制されます。
- Linux systemdインストールでは、`status` のトークンドリフトチェックに `Environment=` と `EnvironmentFile=` の両方のユニットソースが含まれます。
- ドリフトチェックはマージされたランタイム環境（サービスコマンド環境を優先し、次にプロセス環境にフォールバック）を使用して `gateway.auth.token` のSecretRefを解決します。
- トークン認証が実質的にアクティブでない場合（`gateway.auth.mode` が明示的に `password`/`none`/`trusted-proxy` に設定されている、またはモード未設定でパスワードが優先されトークン候補が存在しない場合）、トークンドリフトチェックは設定トークンの解決をスキップします。
- トークン認証がトークンを必要とし、`gateway.auth.token` がSecretRef管理されている場合、`install` はSecretRefが解決可能であることを検証しますが、解決されたトークンをサービス環境メタデータに永続化しません。
- トークン認証がトークンを必要とし、設定されたトークンのSecretRefが未解決の場合、インストールはクローズドで失敗します。
- `gateway.auth.token` と `gateway.auth.password` の両方が設定されており、`gateway.auth.mode` が未設定の場合、モードが明示的に設定されるまでインストールはブロックされます。

## 推奨

最新のドキュメントと使用例については [`openclaw gateway`](/cli/gateway) を使用してください。
