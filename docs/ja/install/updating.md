---
summary: "OpenClaw を安全に更新する方法（グローバルインストールまたはソース）、およびロールバック戦略"
read_when:
  - OpenClaw を更新する場合
  - 更新後に問題が発生した場合
title: "更新"
---

# 更新

OpenClawは速く動いています(以下「1.0」とします)。 配送違反のような更新を扱う: 更新 → 小切手を実行 → 再起動する (または `openclaw update` を使用して再起動) → 確認する

## 推奨：Web サイトのインストーラーを再実行（インプレースアップグレード）

**preferred**の更新パスは、ウェブサイトからインストーラを再実行することです。 36. 既存のインストールを検出し、その場でアップグレードし、必要に応じて `openclaw doctor` を実行します。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注記：

- オンボーディングウィザードを再度実行したくない場合は、`--no-onboard` を追加してください。

- **ソースインストール** の場合は、次を使用します。

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  インストーラーは、リポジトリがクリーンな場合に **のみ** `git pull --rebase` を行います。

- **グローバルインストール** の場合、スクリプトは内部的に `npm install -g openclaw@latest` を使用します。

- レガシー注記：互換性シムとして `clawdbot` は引き続き利用可能です。

## 更新前に

- インストール方法を把握してください：**グローバル**（npm/pnpm）か **ソースから**（git clone）か。
- Gateway の実行方法を把握してください：**フォアグラウンドのターミナル** か **監視サービス**（launchd/systemd）か。
- カスタマイズのスナップショットを取得してください：
  - 設定：`~/.openclaw/openclaw.json`
  - 資格情報：`~/.openclaw/credentials/`
  - ワークスペース：`~/.openclaw/workspace`

## 更新（グローバルインストール）

グローバルインストール（いずれかを選択）：

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gateway のランタイムには Bun を **推奨しません**（WhatsApp / Telegram の不具合）。

更新チャンネルを切り替える場合（git + npm インストール）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

単発のインストールタグ／バージョンには `--tag <dist-tag|version>` を使用してください。

チャンネルの意味とリリースノートについては、[Development channels](/install/development-channels) を参照してください。

注記：npm インストールでは、Gateway は起動時に更新ヒントをログに出力します（現在のチャンネルタグを確認）。`update.checkOnStart: false` で無効化できます。 `update.checkOnStart: false` で無効にします。

その後：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

注記：

- Gateway がサービスとして動作している場合、PID を kill するよりも `openclaw gateway restart` が推奨されます。
- 特定のバージョンに固定している場合は、下記の「ロールバック／ピン留め」を参照してください。

## 更新（`openclaw update`）

**ソースインストール**（git checkout）の場合は、次を推奨します：

```bash
openclaw update
```

これは比較的安全な更新フローを実行します：

- クリーンな作業ツリーが必要です。
- 選択したチャンネル（タグまたはブランチ）に切り替えます。
- 設定された upstream（dev チャンネル）に対して取得＋リベースします。
- 依存関係のインストール、ビルド、Control UI のビルドを行い、`openclaw doctor` を実行します。
- 既定で Gateway を再起動します（スキップするには `--no-restart`）。

**npm/pnpm** でインストールしている場合（git メタデータなし）、`openclaw update` はパッケージマネージャー経由での更新を試みます。インストールを検出できない場合は、「更新（グローバルインストール）」を使用してください。 インストールが検出できない場合は、代わりに "Update (global install)" を使用してください。

## 更新（Control UI / RPC）

Control UI には **Update & Restart**（RPC：`update.run`）があります。これは次を行います： それ:

1. `openclaw update` と同じソース更新フローを実行します（git checkout のみ）。
2. 構造化レポート（stdout/stderr の末尾）を含む再起動センチネルを書き込みます。
3. Gateway を再起動し、最後にアクティブだったセッションにレポートを送信します。

リベースに失敗した場合、Gateway は更新を適用せずに中止し、再起動します。

## 更新（ソースから）

リポジトリのチェックアウトから：

推奨：

```bash
openclaw update
```

手動（ほぼ同等）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

注記：

- パッケージ化された `openclaw` バイナリ（[`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)）を実行する場合や、Node で `dist/` を実行する場合は、`pnpm build` が重要です。
- グローバルインストールなしでリポジトリのチェックアウトから実行する場合、CLI コマンドには `pnpm openclaw ...` を使用してください。
- TypeScript から直接実行する場合（`pnpm openclaw ...`）、通常は再ビルドは不要ですが、**設定マイグレーションは適用されます** → doctor を実行してください。
- グローバルと git インストールの切り替えは簡単です。もう一方をインストールしてから `openclaw doctor` を実行すると、Gateway サービスのエントリーポイントが現在のインストールに書き換えられます。

## 常に実行：`openclaw doctor`

Doctor は「安全な更新」コマンドです。意図的に地味で、修復＋移行＋警告を行います。 それは意図的に退屈です:修理+移行+警告。

注記：**ソースインストール**（git checkout）の場合、`openclaw doctor` は最初に `openclaw update` を実行する提案を行います。

典型的に行うこと：

- 非推奨の設定キー／レガシーな設定ファイル場所の移行。
- DM ポリシーを監査し、リスクのある「open」設定を警告。
- Gateway の健全性をチェックし、再起動を提案可能。
- 旧式の Gateway サービス（launchd/systemd；レガシー schtasks）を検出し、現在の OpenClaw サービスへ移行。
- Linux では、systemd のユーザー lingering を有効化（ログアウト後も Gateway が存続）。

詳細：[Doctor](/gateway/doctor)

## Gateway の起動／停止／再起動

CLI（OS に依存せず動作）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

監視下で実行している場合：

- macOS launchd（アプリ同梱の LaunchAgent）：`launchctl kickstart -k gui/$UID/bot.molt.gateway`（`bot.molt.<profile>` を使用；レガシーの `com.openclaw.*` も引き続き使用可能）
- Linux systemd ユーザーサービス：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows（WSL2）：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` は、サービスがインストールされている場合にのみ動作します。そうでない場合は `openclaw gateway install` を実行してください。

運用手順と正確なサービスラベル：[Gateway runbook](/gateway)

## ロールバック／ピン留め（問題が発生した場合）

### ピン留め（グローバルインストール）

既知の正常バージョンをインストールします（`<version>` を最後に動作していたものに置き換えてください）：

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

ヒント：現在公開されているバージョンを確認するには、`npm view openclaw version` を実行します。

その後、再起動して doctor を再実行します：

```bash
openclaw doctor
openclaw gateway restart
```

### 日付でピン留め（ソース）

日付からコミットを選択します（例：「2026-01-01 時点の main の状態」）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

次に依存関係を再インストールして再起動します：

```bash
pnpm install
pnpm build
openclaw gateway restart
```

後で最新に戻したい場合：

```bash
git checkout main
git pull
```

## 行き詰まった場合

- `openclaw doctor` を再度実行し、出力を注意深く読んでください（修正方法が示されることがよくあります）。
- 参照：[トラブルシューティング](/gateway/troubleshooting)
- Discord で質問：<https://discord.gg/clawd>
