---
summary: "ゲートウェイ、チャンネル、自動化、ノード、ブラウザーに関する詳細なトラブルシューティングのランブック"
read_when:
  - トラブルシューティング ハブから、より深い診断のためにここを参照するよう案内された場合
  - 正確なコマンドを含む、症状ベースで安定したランブック セクションが必要な場合
title: "トラブルシューティング"
---

# ゲートウェイのトラブルシューティング

このページは深いランブックです。
高速なトリアージフローを最初にしたい場合は、[/help/troubleshooting](/help/troubleshooting) から開始します。

## コマンド ラダー

まず以下を、この順序で実行してください。

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

期待される正常なシグナル:

- `openclaw gateway status` に `Runtime: running` と `RPC probe: ok` が表示される。
- `openclaw doctor` で、ブロックしている設定やサービスの問題が報告されない。
- `openclaw channels status --probe` に、接続済み／準備完了のチャンネルが表示される。

## 返信がない

チャンネルが起動しているのに応答がない場合は、何かを再接続する前に、ルーティングとポリシーを確認してください。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

検索対象:

- DM送信者のペア設定待ちです。
- グループ メンションのゲーティング（`requireMention`、`mentionPatterns`）。
- チャンネル／グループの許可リスト不一致。

一般的なシグネチャ:

- `drop guild message (mention required` → メンションされるまでグループ メッセージが無視される。
- `pairing request` → 送信者に承認が必要。
- `blocked` / `allowlist` → 送信者またはチャンネルがポリシーによりフィルタリングされた。

関連:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## ダッシュボード／コントロール UI の接続性

ダッシュボード／コントロール UI が接続できない場合は、URL、認証モード、セキュア コンテキストの前提を検証してください。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

検索対象:

- 正しいプローブ URL とダッシュボード URL。
- クライアントとゲートウェイ間の認証モード／トークンの不一致。
- デバイス ID が必要な場面での HTTP 利用。

一般的なシグネチャ:

- `device identity required` → 非セキュア コンテキスト、またはデバイス認証の欠如。
- `unauthorized` / 再接続ループ → トークン／パスワードの不一致。
- `gateway connect failed:` → ホスト／ポート／URL の指定誤り。

関連:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## ゲートウェイ サービスが起動しない

サービスはインストールされているが、プロセスが継続して起動しない場合に使用します。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

検索対象:

- 終了ヒント付きの `Runtime: stopped`。
- サービス設定の不一致（`Config (cli)` と `Config (service)`）。
- ポート／リスナーの競合。

一般的なシグネチャ:

- `Gateway start blocked: set gateway.mode=local` → ローカル ゲートウェイ モードが有効になっていない。
- `refusing to bind gateway ... without auth` → トークン／パスワードなしでの非 loopback バインド。
- `another gateway instance is already listening` / `EADDRINUSE` → ポート競合。

関連:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## チャンネルは接続済みだがメッセージが流れない

チャンネルの状態が接続済みなのにメッセージ フローが停止している場合は、ポリシー、権限、チャンネル固有の配信ルールに注目してください。

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

検索対象:

- ダイレクトメッセージ ポリシー（`pairing`、`allowlist`、`open`、`disabled`）。
- グループの許可リストおよびメンション要件。
- チャンネル API の権限／スコープ不足。

一般的なシグネチャ:

- `mention required` → グループ メンション ポリシーによりメッセージが無視された。
- `pairing` / 承認保留のトレース → 送信者が未承認。
- `missing_scope`、`not_in_channel`、`Forbidden`、`401/403` → チャンネルの認証／権限の問題。

関連:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron とハートビートの配信

cron またはハートビートが実行されない、あるいは配信されない場合は、まずスケジューラーの状態を確認し、その後に配信先を確認してください。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

検索対象:

- cron が有効で、次回の起動が存在する。
- ジョブ実行履歴のステータス（`ok`、`skipped`、`error`）。
- ハートビートがスキップされた理由（`quiet-hours`、`requests-in-flight`、`alerts-disabled`）。

一般的なシグネチャ:

- `cron: scheduler disabled; jobs will not run automatically` → cron が無効。
- `cron: timer tick failed` → スケジューラーのティックに失敗。ファイル／ログ／ランタイム エラーを確認。
- `heartbeat skipped` と `reason=quiet-hours` → アクティブ時間帯の外。
- `heartbeat: unknown accountId` → ハートビート配信先のアカウント ID が無効。

関連:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## ペアリング済みノードのツールが失敗する

ノードがペアリングされているがツールが失敗する場合は、フォアグラウンド状態、権限、承認状態を切り分けてください。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

検索対象:

- ノードがオンラインで、期待される機能を備えている。
- カメラ／マイク／位置情報／画面に対する OS 権限の付与。
- 実行承認と許可リストの状態。

一般的なシグネチャ:

- `NODE_BACKGROUND_UNAVAILABLE` → ノード アプリはフォアグラウンドである必要がある。
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 権限が不足している。
- `SYSTEM_RUN_DENIED: approval required` → 実行承認が保留中。
- `SYSTEM_RUN_DENIED: allowlist miss` → コマンドが許可リストによりブロックされた。

関連:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## ブラウザー ツールが失敗する

ゲートウェイ自体は正常にもかかわらず、ブラウザー ツールのアクションが失敗する場合に使用します。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

検索対象:

- 有効なブラウザー実行ファイルのパス。
- CDP プロファイルへの到達性。
- `profile="chrome"` 用の拡張機能リレー タブのアタッチ。

一般的なシグネチャ:

- `Failed to start Chrome CDP on port` → ブラウザー プロセスの起動に失敗。
- `browser.executablePath not found` → 設定されたパスが無効。
- `Chrome extension relay is running, but no tab is connected` → 拡張機能リレーがアタッチされていない。
- `Browser attachOnly is enabled ... not reachable` → アタッチ専用プロファイルに到達可能なターゲットがない。

関連:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## アップグレード後に突然問題が発生した場合

アップグレード後の問題の多くは、設定のドリフト、またはより厳格になったデフォルト設定が適用されたことによるものです。

### 1. 認証と URL 上書きの挙動が変更された

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

確認する内容:

- `gateway.mode=remote` の場合、CLI 呼び出しがリモートを指しており、ローカル サービス自体は正常な可能性があります。
- 明示的な `--url` 呼び出しは、保存された認証情報にフォールバックしません。

一般的なシグネチャ:

- `gateway connect failed:` → URL の指定誤り。
- `unauthorized` → エンドポイントには到達できるが、認証が誤っている。

### 2. バインドと認証のガードレールがより厳格になった

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

確認する内容:

- 非 loopback バインド（`lan`、`tailnet`、`custom`）では、認証の設定が必要です。
- `gateway.token` のような古いキーは、`gateway.auth.token` を置き換えません。

一般的なシグネチャ:

- `refusing to bind gateway ... without auth` → バインドと認証の不一致。
- ランタイムが稼働中にもかかわらず `RPC probe: failed` → ゲートウェイは生きているが、現在の認証／URL ではアクセスできない。

### 3. ペアリングおよびデバイス ID の状態が変更された

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

確認する内容:

- ダッシュボード／ノード向けのデバイス承認が保留中でないか。
- ポリシーまたは ID 変更後に、ダイレクトメッセージのペアリング承認が保留中でないか。

一般的なシグネチャ:

- `device identity required` → デバイス認証が満たされていない。
- `pairing required` → 送信者／デバイスの承認が必要。

これらを確認してもサービス設定とランタイムが一致しない場合は、同じプロファイル／状態ディレクトリからサービス メタデータを再インストールしてください。

```bash
openclaw gateway install --force
openclaw gateway restart
```

関連:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
