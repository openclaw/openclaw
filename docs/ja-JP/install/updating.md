---
summary: "OpenClawの安全なアップデート（グローバルインストールまたはソース）、およびロールバック戦略"
read_when:
  - OpenClawをアップデートする場合
  - アップデート後に何かが壊れた場合
title: "アップデート"
---

# アップデート

OpenClawは高速に進化しています（「1.0」以前）。アップデートはインフラのシッピングと同様に扱ってください：アップデート → チェックを実行 → 再起動（または`openclaw update`を使用、再起動も実行されます）→ 検証。

## 推奨：Webサイトインストーラーの再実行（インプレースアップグレード）

**推奨**のアップデートパスは、Webサイトからインストーラーを再実行することです。既存のインストールを検出し、インプレースでアップグレードし、必要に応じて`openclaw doctor`を実行します。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注意：

- オンボーディングウィザードを再実行したくない場合は`--no-onboard`を追加してください。
- **ソースインストール**の場合：

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  インストーラーはリポジトリがクリーンな場合**のみ**`git pull --rebase`を実行します。

- **グローバルインストール**の場合、スクリプトは内部で`npm install -g openclaw@latest`を使用します。
- レガシーに関する注意：`clawdbot`は互換性シムとして引き続き利用可能です。

## アップデート前に

- インストール方法を確認：**グローバル**（npm/pnpm）対 **ソースから**（git clone）。
- Gatewayの実行方法を確認：**フォアグラウンドターミナル**対**スーパーバイズドサービス**（launchd/systemd）。
- カスタマイズのスナップショット：
  - 設定：`~/.openclaw/openclaw.json`
  - 認証情報：`~/.openclaw/credentials/`
  - ワークスペース：`~/.openclaw/workspace`

## アップデート（グローバルインストール）

グローバルインストール（いずれか1つを選択）：

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gatewayランタイムには Bunを**推奨しません**（WhatsApp/Telegramのバグがあります）。

アップデートチャンネルの切り替え（git + npmインストール）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

ワンオフのインストールタグ/バージョンには`--tag <dist-tag|version>`を使用してください。

チャンネルのセマンティクスとリリースノートについては、[開発チャンネル](/install/development-channels)を参照してください。

注意：npmインストールでは、Gatewayが起動時にアップデートヒントをログに記録します（現在のチャンネルタグをチェック）。`update.checkOnStart: false`で無効化できます。

### コア自動アップデーター（オプション）

自動アップデーターはデフォルトで**オフ**であり、コアGateway機能です（プラグインではありません）。

```json
{
  "update": {
    "channel": "stable",
    "auto": {
      "enabled": true,
      "stableDelayHours": 6,
      "stableJitterHours": 12,
      "betaCheckIntervalHours": 1
    }
  }
}
```

動作：

- `stable`：新しいバージョンが検出されると、OpenClawは`stableDelayHours`待機し、その後`stableJitterHours`内で決定論的なインストールごとのジッターを適用します（段階的ロールアウト）。
- `beta`：`betaCheckIntervalHours`の間隔でチェック（デフォルト：毎時）し、アップデートが利用可能な場合に適用します。
- `dev`：自動適用なし。手動で`openclaw update`を使用してください。

自動化を有効にする前にアップデートアクションをプレビューするには、`openclaw update --dry-run`を使用してください。

次に：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

注意：

- Gatewayがサービスとして実行されている場合、PIDをkillするよりも`openclaw gateway restart`が推奨されます。
- 特定のバージョンにピン留めしている場合は、以下の「ロールバック / ピン留め」を参照してください。

## アップデート（`openclaw update`）

**ソースインストール**（gitチェックアウト）の場合：

```bash
openclaw update
```

安全なアップデートフローを実行します：

- クリーンなワークツリーが必要です。
- 選択したチャンネル（タグまたはブランチ）にチェックアウトします。
- 設定されたアップストリーム（devチャンネル）に対してフェッチ + リベースします。
- 依存関係をインストール、ビルド、Control UIをビルドし、`openclaw doctor`を実行します。
- デフォルトでGatewayを再起動します（スキップするには`--no-restart`を使用）。

**npm/pnpm**でインストールした場合（gitメタデータなし）、`openclaw update`はパッケージマネージャー経由でアップデートを試みます。インストールを検出できない場合は、代わりに「アップデート（グローバルインストール）」を使用してください。

## アップデート（Control UI / RPC）

Control UIには**Update & Restart**（RPC：`update.run`）があります。以下を実行します：

1. `openclaw update`と同じソースアップデートフローを実行（gitチェックアウトのみ）。
2. 構造化レポート（stdout/stderrの末尾）とともにリスタートセンチネルを書き込み。
3. Gatewayを再起動し、最後のアクティブセッションにレポートをpingします。

リベースが失敗した場合、Gatewayはアップデートを適用せずに中止して再起動します。

## アップデート（ソースから）

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
pnpm ui:build # 初回実行時にUI依存関係を自動インストール
openclaw doctor
openclaw health
```

注意：

- パッケージ化された`openclaw`バイナリ（[`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)）を実行する場合やNodeで`dist/`を実行する場合、`pnpm build`は重要です。
- グローバルインストールなしでリポジトリチェックアウトから実行する場合、CLIコマンドには`pnpm openclaw ...`を使用してください。
- TypeScriptから直接実行する場合（`pnpm openclaw ...`）、リビルドは通常不要ですが、**設定マイグレーションは引き続き適用されます** → doctorを実行してください。
- グローバルインストールとgitインストールの切り替えは簡単です：もう一方をインストールし、`openclaw doctor`を実行すると、Gatewayサービスのエントリーポイントが現在のインストールに書き換えられます。

## 常に実行：`openclaw doctor`

Doctorは「安全なアップデート」コマンドです。意図的に地味です：修復 + マイグレーション + 警告。

注意：**ソースインストール**（gitチェックアウト）の場合、`openclaw doctor`は最初に`openclaw update`の実行を提案します。

一般的な処理：

- 非推奨の設定キー / レガシー設定ファイルの場所のマイグレーション。
- DMポリシーの監査と、リスクのある「open」設定への警告。
- Gatewayのヘルスチェックと再起動の提案。
- 古いGatewayサービス（launchd/systemd、レガシーschtasks）の検出と現在のOpenClawサービスへのマイグレーション。
- Linuxでは、systemdユーザーリンガリングの確保（Gatewayがログアウト後も維持されるように）。

詳細：[Doctor](/gateway/doctor)

## Gatewayの起動 / 停止 / 再起動

CLI（OSに関係なく動作）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

スーパーバイズドの場合：

- macOS launchd（アプリバンドルのLaunchAgent）：`launchctl kickstart -k gui/$UID/ai.openclaw.gateway`（`ai.openclaw.<profile>`を使用、レガシーの`com.openclaw.*`も動作）
- Linux systemdユーザーサービス：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows（WSL2）：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl`はサービスがインストールされている場合にのみ動作します。そうでない場合は`openclaw gateway install`を実行してください。

ランブック + 正確なサービスラベル：[Gatewayランブック](/gateway)

## ロールバック / ピン留め（何かが壊れた場合）

### ピン留め（グローバルインストール）

既知の動作するバージョンをインストールします（`<version>`を最後に動作したものに置き換え）：

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

ヒント：現在公開されているバージョンを確認するには、`npm view openclaw version`を実行してください。

その後、再起動 + doctorを再実行：

```bash
openclaw doctor
openclaw gateway restart
```

### ピン留め（ソース）日付指定

日付からコミットを選択（例：「2026-01-01時点のmainの状態」）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

その後、依存関係を再インストール + 再起動：

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

- `openclaw doctor`を再度実行し、出力を注意深く読んでください（修正方法が記載されていることが多いです）。
- 確認：[トラブルシューティング](/gateway/troubleshooting)
- Discordで質問：[https://discord.gg/clawd](https://discord.gg/clawd)
