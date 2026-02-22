---
summary: "OpenClawの安全なアップデート方法（グローバルインストール・ソース）とロールバック戦略"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "アップデート"
---

# アップデート

OpenClawは高速に開発が進んでいます（pre 1.0）。アップデートはインフラのデプロイと同じ要領で: アップデート → チェック実行 → 再起動（または `openclaw update` で自動再起動） → 動作確認。

## 推奨: Webサイトのインストーラーを再実行（インプレースアップグレード）

推奨されるアップデート方法は、Webサイトのインストーラーを再実行することです。既存のインストールを検出し、インプレースでアップグレードし、必要に応じて `openclaw doctor` を実行します。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

補足:

- オンボーディングウィザードを再度実行したくない場合は `--no-onboard` を追加してください。
- ソースインストールの場合は以下を使用:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  リポジトリがクリーンな状態の場合のみ `git pull --rebase` が実行されます。

- グローバルインストールの場合、内部的に `npm install -g openclaw@latest` が使用されます。

## アップデート前の準備

- インストール方法を確認: **グローバル**（npm/pnpm）vs **ソース**（git clone）。
- Gatewayの実行方法を確認: **フォアグラウンドターミナル** vs **サービス管理**（launchd/systemd）。
- カスタマイズ設定のスナップショットを取得:
  - 設定: `~/.openclaw/openclaw.json`
  - 認証情報: `~/.openclaw/credentials/`
  - ワークスペース: `~/.openclaw/workspace`

## アップデート（グローバルインストール）

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

その後:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

## ロールバック / バージョン固定（問題が発生した場合）

動作確認済みのバージョンをインストール（`<version>`を正常動作していたバージョンに置き換えてください）:

```bash
npm i -g openclaw@<version>
```

再起動 + doctorを再実行:

```bash
openclaw doctor
openclaw gateway restart
```

## 困ったときは

- `openclaw doctor` を再度実行し、出力を注意深く確認してください。
- 参照: [トラブルシューティング](/gateway/troubleshooting)
- Discordで質問: [https://discord.gg/clawd](https://discord.gg/clawd)
