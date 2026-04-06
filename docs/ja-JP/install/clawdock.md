---
read_when:
    - Docker で OpenClaw を頻繁に実行しており、日常的なコマンドを短くしたい
    - ダッシュボード、ログ、トークン設定、ペアリングフローのヘルパーレイヤーが欲しい
summary: Docker ベースの OpenClaw インストール用 ClawDock シェルヘルパー
title: ClawDock
x-i18n:
    generated_at: "2026-04-02T07:44:48Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f8065bc7ae087532733ce548517693fee701a73116a3c8681f2b4f7180c76d4b
    source_path: install/clawdock.md
    workflow: 15
---

# ClawDock

ClawDock は、Docker ベースの OpenClaw インストール用の小さなシェルヘルパーレイヤーです。

長い `docker compose ...` の呼び出しの代わりに、`clawdock-start`、`clawdock-dashboard`、`clawdock-fix-token` のような短いコマンドを使用できます。

まだ Docker をセットアップしていない場合は、[Docker](/install/docker) から始めてください。

## インストール

正規のヘルパーパスを使用してください：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

以前 `scripts/shell-helpers/clawdock-helpers.sh` から ClawDock をインストールしていた場合は、新しい `scripts/clawdock/clawdock-helpers.sh` パスから再インストールしてください。古い raw GitHub パスは削除されました。

## 提供されるコマンド

### 基本操作

| コマンド             | 説明                       |
| ------------------ | ---------------------- |
| `clawdock-start`   | Gateway ゲートウェイを起動する      |
| `clawdock-stop`    | Gateway ゲートウェイを停止する       |
| `clawdock-restart` | Gateway ゲートウェイを再起動する    |
| `clawdock-status`  | コンテナのステータスを確認する |
| `clawdock-logs`    | Gateway ゲートウェイのログをフォローする    |

### コンテナアクセス

| コマンド                      | 説明                                   |
| ------------------------- | --------------------------------------------- |
| `clawdock-shell`          | Gateway ゲートウェイコンテナ内でシェルを開く     |
| `clawdock-cli <command>`  | Docker 内で OpenClaw CLI コマンドを実行する           |
| `clawdock-exec <command>` | コンテナ内で任意のコマンドを実行する |

### Web UI とペアリング

| コマンド                  | 説明                  |
| ----------------------- | ---------------------------- |
| `clawdock-dashboard`    | コントロール UI の URL を開く      |
| `clawdock-devices`      | 保留中のデバイスペアリングを一覧表示する |
| `clawdock-approve <id>` | ペアリングリクエストを承認する    |

### セットアップとメンテナンス

| コマンド               | 説明                                      |
| -------------------- | ------------------------------------------------ |
| `clawdock-fix-token` | コンテナ内で Gateway ゲートウェイトークンを設定する |
| `clawdock-update`    | プル、リビルド、再起動を行う                       |
| `clawdock-rebuild`   | Docker イメージのみをリビルドする                    |
| `clawdock-clean`     | コンテナとボリュームを削除する                    |

### ユーティリティ

| コマンド                 | 説明                             |
| ---------------------- | --------------------------------------- |
| `clawdock-health`      | Gateway ゲートウェイのヘルスチェックを実行する              |
| `clawdock-token`       | Gateway ゲートウェイトークンを表示する                 |
| `clawdock-cd`          | OpenClaw プロジェクトディレクトリに移動する  |
| `clawdock-config`      | `~/.openclaw` を開く                      |
| `clawdock-show-config` | 値を秘匿化して設定ファイルを表示する |
| `clawdock-workspace`   | ワークスペースディレクトリを開く            |

## 初回フロー

```bash
clawdock-start
clawdock-fix-token
clawdock-dashboard
```

ブラウザでペアリングが必要と表示された場合：

```bash
clawdock-devices
clawdock-approve <request-id>
```

## 設定とシークレット

ClawDock は [Docker](/install/docker) で説明されているのと同じ Docker 設定の分割方式で動作します：

- `<project>/.env` - イメージ名、ポート、Gateway ゲートウェイトークンなどの Docker 固有の値
- `~/.openclaw/.env` - プロバイダーキーとボットトークン
- `~/.openclaw/openclaw.json` - 動作設定

これらのファイルをすばやく確認したい場合は `clawdock-show-config` を使用してください。出力では `.env` の値が秘匿化されます。

## 関連ページ

- [Docker](/install/docker)
- [Docker VM ランタイム](/install/docker-vm-runtime)
- [アップデート](/install/updating)
