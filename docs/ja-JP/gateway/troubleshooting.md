---
summary: "Gateway、チャンネル、自動化、ノード、ブラウザーの詳細なトラブルシューティングランブック"
read_when:
  - トラブルシューティングハブからより詳細な診断のためにここへ誘導された場合
  - 正確なコマンドを含む症状別ランブックセクションが必要な場合
title: "トラブルシューティング"
---

# Gateway トラブルシューティング

このページは詳細なランブックです。
まず高速なトリアージフローを確認したい場合は、[/help/troubleshooting](/help/troubleshooting) から始めてください。

## コマンドラダー

最初にこの順序でこれらのコマンドを実行してください。

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

正常な状態のシグナル:

- `openclaw gateway status` で `Runtime: running` および `RPC probe: ok` が表示される。
- `openclaw doctor` でブロッキングする設定/サービスの問題が報告されない。
- `openclaw channels status --probe` で接続済み/準備完了のチャンネルが表示される。

## 返信がない

チャンネルが稼働しているのに何も応答しない場合は、何かを再接続する前にルーティングとポリシーを確認してください。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

確認事項:

- DM 送信者のペアリングが保留中になっていないか。
- グループメンション制限 (`requireMention`、`mentionPatterns`) が有効になっていないか。
- チャンネル/グループの許可リストが一致していないか。

よくあるシグナル:

- `drop guild message (mention required` → メンションするまでグループメッセージが無視される。
- `pairing request` → 送信者の承認が必要。
- `blocked` / `allowlist` → 送信者/チャンネルがポリシーによりフィルタリングされた。

関連:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## ダッシュボードコントロール UI の接続

ダッシュボード/コントロール UI が接続できない場合は、URL、認証モード、セキュアコンテキストの前提条件を検証してください。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

確認事項:

- プローブ URL とダッシュボード URL が正しいか。
- クライアントと Gateway 間の認証モード/トークンの不一致がないか。
- デバイス識別が必要な箇所で HTTP を使用していないか。

よくあるシグナル:

- `device identity required` → セキュアでないコンテキスト、またはデバイス認証が欠落している。
- `device nonce required` / `device nonce mismatch` → クライアントがチャレンジベースのデバイス認証フロー (`connect.challenge` + `device.nonce`) を完了していない。
- `device signature invalid` / `device signature expired` → クライアントが現在のハンドシェイクに対して誤ったペイロード（またはタイムスタンプが古い）で署名している。
- `unauthorized` / 再接続ループ → トークン/パスワードが一致しない。
- `gateway connect failed:` → ホスト/ポート/URL ターゲットが誤っている。

デバイス認証 v2 移行チェック:

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

ログに nonce/シグネチャーエラーが表示される場合は、接続クライアントを更新し、以下を確認してください:

1. `connect.challenge` を待機している
2. チャレンジに紐づいたペイロードに署名している
3. 同じチャレンジ nonce を持つ `connect.params.device.nonce` を送信している

関連:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway サービスが起動しない

サービスはインストールされているがプロセスが起動し続けない場合に使用してください。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

確認事項:

- 終了ヒントを含む `Runtime: stopped` が表示されていないか。
- サービス設定の不一致 (`Config (cli)` vs `Config (service)`) がないか。
- ポート/リスナーの競合がないか。

よくあるシグナル:

- `Gateway start blocked: set gateway.mode=local` → ローカル Gateway モードが有効になっていない。修正: 設定で `gateway.mode="local"` を設定する（または `openclaw configure` を実行）。Podman を使用して専用の `openclaw` ユーザーで OpenClaw を実行している場合、設定は `~openclaw/.openclaw/openclaw.json` にあります。
- `refusing to bind gateway ... without auth` → トークン/パスワードなしでループバック以外のバインドを実行しようとしている。
- `another gateway instance is already listening` / `EADDRINUSE` → ポートの競合。

関連:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## チャンネルは接続済みだがメッセージが流れない

チャンネルの状態は接続済みだがメッセージフローが停止している場合は、ポリシー、権限、チャンネル固有の配信ルールに焦点を当ててください。

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

確認事項:

- DM ポリシー (`pairing`、`allowlist`、`open`、`disabled`)。
- グループの許可リストとメンション要件。
- チャンネル API の権限/スコープが欠落していないか。

よくあるシグナル:

- `mention required` → グループメンションポリシーによりメッセージが無視された。
- `pairing` / 承認待ちのトレース → 送信者が承認されていない。
- `missing_scope`、`not_in_channel`、`Forbidden`、`401/403` → チャンネルの認証/権限の問題。

関連:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron とハートビートの配信

Cron またはハートビートが実行されなかった、または配信されなかった場合は、まずスケジューラーの状態を確認し、次に配信ターゲットを確認してください。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

確認事項:

- Cron が有効で次の起動時刻が設定されているか。
- ジョブ実行履歴のステータス (`ok`、`skipped`、`error`)。
- ハートビートのスキップ理由 (`quiet-hours`、`requests-in-flight`、`alerts-disabled`)。

よくあるシグナル:

- `cron: scheduler disabled; jobs will not run automatically` → Cron が無効になっている。
- `cron: timer tick failed` → スケジューラーのティックが失敗した。ファイル/ログ/ランタイムのエラーを確認してください。
- `heartbeat skipped` と `reason=quiet-hours` → アクティブ時間帯の外。
- `heartbeat: unknown accountId` → ハートビート配信ターゲットのアカウント ID が無効。
- `heartbeat skipped` と `reason=dm-blocked` → ハートビートターゲットが DM 形式の宛先に解決されたが、`agents.defaults.heartbeat.directPolicy`（またはエージェントごとのオーバーライド）が `block` に設定されている。

関連:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## ノードのペアリング済みツールが失敗する

ノードがペアリングされているがツールが失敗する場合は、フォアグラウンド状態、権限、承認状態を切り分けてください。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

確認事項:

- ノードが期待される機能でオンラインになっているか。
- カメラ/マイク/位置情報/画面に対する OS 権限の付与。
- 実行承認と許可リストの状態。

よくあるシグナル:

- `NODE_BACKGROUND_UNAVAILABLE` → ノードアプリをフォアグラウンドにする必要がある。
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 権限が欠落している。
- `SYSTEM_RUN_DENIED: approval required` → 実行承認が保留中。
- `SYSTEM_RUN_DENIED: allowlist miss` → コマンドが許可リストによりブロックされた。

関連:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## ブラウザーツールが失敗する

Gateway 自体は正常だがブラウザーツールのアクションが失敗する場合に使用してください。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

確認事項:

- ブラウザーの実行可能ファイルパスが有効か。
- CDP プロファイルの到達可能性。
- `profile="chrome"` の拡張機能リレータブのアタッチメント。

よくあるシグナル:

- `Failed to start Chrome CDP on port` → ブラウザープロセスの起動に失敗した。
- `browser.executablePath not found` → 設定されたパスが無効。
- `Chrome extension relay is running, but no tab is connected` → 拡張機能リレーがアタッチされていない。
- `Browser attachOnly is enabled ... not reachable` → アタッチ専用プロファイルに到達可能なターゲットがない。

関連:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## アップグレード後に突然問題が発生した場合

アップグレード後の問題のほとんどは、設定のずれや、より厳格なデフォルト値が適用されるようになったことが原因です。

### 1) 認証と URL オーバーライドの動作が変わった

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

確認事項:

- `gateway.mode=remote` の場合、ローカルサービスが正常でも CLI 呼び出しがリモートをターゲットにしている可能性がある。
- 明示的な `--url` 呼び出しは保存された認証情報にフォールバックしない。

よくあるシグナル:

- `gateway connect failed:` → URL ターゲットが誤っている。
- `unauthorized` → エンドポイントには到達できるが認証が誤っている。

### 2) バインドと認証のガードレールがより厳格になった

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

確認事項:

- ループバック以外のバインド (`lan`、`tailnet`、`custom`) には認証の設定が必要。
- `gateway.token` などの古いキーは `gateway.auth.token` の代わりにはならない。

よくあるシグナル:

- `refusing to bind gateway ... without auth` → バインドと認証の設定が一致しない。
- `RPC probe: failed`（ランタイムは起動中）→ Gateway は稼働しているが現在の認証/URL ではアクセスできない。

### 3) ペアリングとデバイス識別の状態が変わった

```bash
openclaw devices list
openclaw pairing list --channel <channel> [--account <id>]
openclaw logs --follow
openclaw doctor
```

確認事項:

- ダッシュボード/ノードのデバイス承認が保留中でないか。
- ポリシーまたは識別の変更後に DM ペアリング承認が保留中でないか。

よくあるシグナル:

- `device identity required` → デバイス認証が満たされていない。
- `pairing required` → 送信者/デバイスの承認が必要。

確認後もサービス設定とランタイムが一致しない場合は、同じプロファイル/状態ディレクトリからサービスメタデータを再インストールしてください:

```bash
openclaw gateway install --force
openclaw gateway restart
```

関連:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
