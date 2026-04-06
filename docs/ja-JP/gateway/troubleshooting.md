---
read_when:
    - トラブルシューティングハブからより深い診断のためにここに案内された
    - 正確なコマンドを含む症状ベースの安定したランブックセクションが必要
summary: Gateway、チャネル、自動化、ノード、ブラウザの詳細なトラブルシューティングランブック
title: トラブルシューティング
x-i18n:
    generated_at: "2026-04-02T07:44:17Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 55cfe7b09d7599f81d776cb8aa5e397e98fd57646a4196294ad4a63158efe2d7
    source_path: gateway/troubleshooting.md
    workflow: 15
---

# Gateway ゲートウェイのトラブルシューティング

このページは詳細なランブックです。
まず高速なトリアージフローを確認したい場合は、[/help/troubleshooting](/help/troubleshooting) から始めてください。

## コマンドラダー

まず以下を順番に実行してください：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

正常時に期待されるシグナル：

- `openclaw gateway status` が `Runtime: running` および `RPC probe: ok` と表示される。
- `openclaw doctor` がブロッキングとなる設定/サービスの問題を報告しない。
- `openclaw channels status --probe` が接続済み/準備完了のチャネルを表示する。

## Anthropic 429 ロングコンテキストに追加使用量が必要

ログ/エラーに以下が含まれる場合に使用してください：
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`

```bash
openclaw logs --follow
openclaw models status
openclaw config get agents.defaults.models
```

確認するポイント：

- 選択された Anthropic Opus/Sonnet モデルに `params.context1m: true` が設定されている。
- 現在の Anthropic 認証情報がロングコンテキストの使用に対応していない。
- 1M ベータパスが必要な長いセッション/モデル実行でのみリクエストが失敗する。

修正オプション：

1. そのモデルの `context1m` を無効にして、通常のコンテキストウィンドウにフォールバックする。
2. 課金が有効な Anthropic API キーを使用するか、サブスクリプションアカウントで Anthropic Extra Usage を有効にする。
3. Anthropic のロングコンテキストリクエストが拒否された場合に実行を継続できるよう、フォールバックモデルを設定する。

関連：

- [/providers/anthropic](/providers/anthropic)
- [/reference/token-use](/reference/token-use)
- [/help/faq#why-am-i-seeing-http-429-ratelimiterror-from-anthropic](/help/faq#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)

## 応答がない

チャネルは稼働しているが何も応答しない場合、再接続する前にルーティングとポリシーを確認してください。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

確認するポイント：

- ダイレクトメッセージ送信者のペアリングが保留中。
- グループメンション制御（`requireMention`、`mentionPatterns`）。
- チャネル/グループの許可リストの不一致。

よくあるシグネチャ：

- `drop guild message (mention required` → メンションされるまでグループメッセージが無視される。
- `pairing request` → 送信者に承認が必要。
- `blocked` / `allowlist` → 送信者/チャネルがポリシーによりフィルタリングされた。

関連：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## ダッシュボード/コントロール UI の接続

ダッシュボード/コントロール UI が接続できない場合、URL、認証モード、セキュアコンテキストの前提を検証してください。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

確認するポイント：

- 正しいプローブ URL とダッシュボード URL。
- クライアントと Gateway ゲートウェイ間の認証モード/トークンの不一致。
- デバイス ID が必要な場面での HTTP 使用。

よくあるシグネチャ：

- `device identity required` → 非セキュアコンテキスト、またはデバイス認証の欠如。
- `device nonce required` / `device nonce mismatch` → クライアントがチャレンジベースのデバイス認証フロー（`connect.challenge` + `device.nonce`）を完了していない。
- `device signature invalid` / `device signature expired` → クライアントが現在のハンドシェイクに対して誤ったペイロード（またはタイムスタンプが古い）に署名した。
- `AUTH_TOKEN_MISMATCH` で `canRetryWithDeviceToken=true` → クライアントはキャッシュされたデバイストークンで1回だけ信頼されたリトライが可能。
- リトライ後も `unauthorized` が繰り返される → 共有トークン/デバイストークンのドリフト。トークン設定を更新し、必要に応じてデバイストークンの再承認/ローテーションを行う。
- `gateway connect failed:` → ホスト/ポート/URL のターゲットが間違っている。

### 認証詳細コードのクイックマップ

失敗した `connect` レスポンスの `error.details.code` を使用して次のアクションを選択してください：

| 詳細コード                   | 意味                                                     | 推奨アクション                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_MISSING`         | クライアントが必要な共有トークンを送信しなかった。       | クライアントにトークンを貼り付け/設定してリトライする。ダッシュボードパスの場合：`openclaw config get gateway.auth.token` を実行し、コントロール UI の設定に貼り付ける。 |
| `AUTH_TOKEN_MISMATCH`        | 共有トークンが Gateway ゲートウェイの認証トークンと一致しなかった。 | `canRetryWithDeviceToken=true` の場合、1回の信頼されたリトライを許可する。それでも失敗する場合は、[トークンドリフト回復チェックリスト](/cli/devices#token-drift-recovery-checklist)を実行する。 |
| `AUTH_DEVICE_TOKEN_MISMATCH` | キャッシュされたデバイスごとのトークンが古いか失効している。 | [devices CLI](/cli/devices) を使用してデバイストークンをローテーション/再承認し、再接続する。                                                                          |
| `PAIRING_REQUIRED`           | デバイス ID は既知だが、このロールに対して承認されていない。 | 保留中のリクエストを承認する：`openclaw devices list` の後に `openclaw devices approve <requestId>` を実行。                                                            |

デバイス認証 v2 移行チェック：

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

ログに nonce/署名エラーが表示される場合、接続元のクライアントを更新し、以下を確認してください：

1. `connect.challenge` を待つ
2. チャレンジバインドされたペイロードに署名する
3. 同じチャレンジ nonce で `connect.params.device.nonce` を送信する

関連：

- [/web/control-ui](/web/control-ui)
- [/gateway/configuration](/gateway/configuration)（Gateway ゲートウェイの認証モード）
- [/gateway/trusted-proxy-auth](/gateway/trusted-proxy-auth)
- [/gateway/remote](/gateway/remote)
- [/cli/devices](/cli/devices)

## Gateway ゲートウェイサービスが起動しない

サービスはインストールされているがプロセスが維持されない場合に使用してください。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

確認するポイント：

- 終了ヒント付きの `Runtime: stopped`。
- サービス設定の不一致（`Config (cli)` と `Config (service)` の差異）。
- ポート/リスナーの競合。

よくあるシグネチャ：

- `Gateway start blocked: set gateway.mode=local` → ローカル Gateway ゲートウェイモードが有効になっていない。修正：設定で `gateway.mode="local"` を設定する（または `openclaw configure` を実行する）。Podman 経由で OpenClaw を実行している場合、デフォルトの設定パスは `~/.openclaw/openclaw.json`。
- `refusing to bind gateway ... without auth` → 認証なしで非ループバックバインドを試行。
- `another gateway instance is already listening` / `EADDRINUSE` → ポート競合。

関連：

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## チャネルは接続済みだがメッセージが流れない

チャネルの状態は接続済みだがメッセージフローが停止している場合、ポリシー、権限、およびチャネル固有の配信ルールに注目してください。

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

確認するポイント：

- ダイレクトメッセージポリシー（`pairing`、`allowlist`、`open`、`disabled`）。
- グループの許可リストとメンション要件。
- チャネル API の権限/スコープの欠如。

よくあるシグネチャ：

- `mention required` → グループメンションポリシーによりメッセージが無視された。
- `pairing` / 承認保留トレース → 送信者が承認されていない。
- `missing_scope`、`not_in_channel`、`Forbidden`、`401/403` → チャネルの認証/権限の問題。

関連：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron とハートビートの配信

Cron またはハートビートが実行されなかった、または配信されなかった場合、まずスケジューラの状態を確認し、次に配信先を確認してください。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

確認するポイント：

- Cron が有効で次回の起動時間が存在する。
- ジョブ実行履歴のステータス（`ok`、`skipped`、`error`）。
- ハートビートのスキップ理由（`quiet-hours`、`requests-in-flight`、`alerts-disabled`）。

よくあるシグネチャ：

- `cron: scheduler disabled; jobs will not run automatically` → Cron が無効。
- `cron: timer tick failed` → スケジューラティックが失敗。ファイル/ログ/ランタイムエラーを確認。
- `heartbeat skipped` で `reason=quiet-hours` → アクティブ時間ウィンドウ外。
- `heartbeat: unknown accountId` → ハートビート配信先のアカウント ID が無効。
- `heartbeat skipped` で `reason=dm-blocked` → ハートビートのターゲットがダイレクトメッセージ形式の宛先に解決されたが、`agents.defaults.heartbeat.directPolicy`（またはエージェントごとのオーバーライド）が `block` に設定されている。

関連：

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## ノードはペアリング済みだがツールが失敗する

ノードがペアリング済みだがツールが失敗する場合、フォアグラウンド状態、権限、承認状態を切り分けてください。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

確認するポイント：

- ノードが期待される機能を持ってオンライン状態である。
- カメラ/マイク/位置情報/画面の OS 権限の付与。
- 実行承認と許可リストの状態。

よくあるシグネチャ：

- `NODE_BACKGROUND_UNAVAILABLE` → ノードアプリがフォアグラウンドである必要がある。
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS 権限が不足。
- `SYSTEM_RUN_DENIED: approval required` → 実行承認が保留中。
- `SYSTEM_RUN_DENIED: allowlist miss` → コマンドが許可リストによりブロックされた。

関連：

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## ブラウザツールが失敗する

Gateway ゲートウェイ自体は正常だがブラウザツールのアクションが失敗する場合に使用してください。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

確認するポイント：

- `plugins.allow` が設定されていて `browser` を含んでいるか。
- 有効なブラウザ実行ファイルのパス。
- CDP プロファイルの到達可能性。
- `existing-session` / `user` プロファイル用のローカル Chrome の可用性。

よくあるシグネチャ：

- `unknown command "browser"` または `unknown command 'browser'` → バンドルされたブラウザプラグインが `plugins.allow` により除外されている。
- `browser.enabled=true` なのにブラウザツールが見つからない/利用できない → `plugins.allow` が `browser` を除外しているため、プラグインがロードされなかった。
- `Failed to start Chrome CDP on port` → ブラウザプロセスの起動に失敗。
- `browser.executablePath not found` → 設定されたパスが無効。
- `No Chrome tabs found for profile="user"` → Chrome MCP アタッチプロファイルにローカル Chrome のタブが開かれていない。
- `Browser attachOnly is enabled ... not reachable` → アタッチ専用プロファイルに到達可能なターゲットがない。

関連：

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/browser](/tools/browser)

## アップグレード後に突然何かが壊れた場合

アップグレード後の問題のほとんどは、設定のドリフトまたはより厳格になったデフォルトの適用が原因です。

### 1) 認証と URL オーバーライドの動作が変更された

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

確認するポイント：

- `gateway.mode=remote` の場合、CLI の呼び出しがリモートを対象としている可能性があり、ローカルサービスは正常であっても問題が生じる。
- 明示的な `--url` 呼び出しは保存された認証情報にフォールバックしない。

よくあるシグネチャ：

- `gateway connect failed:` → URL ターゲットが間違っている。
- `unauthorized` → エンドポイントには到達可能だが認証が間違っている。

### 2) バインドと認証のガードレールがより厳格になった

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

確認するポイント：

- 非ループバックバインド（`lan`、`tailnet`、`custom`）には認証の設定が必要。
- 古いキー `gateway.token` は `gateway.auth.token` を置き換えない。

よくあるシグネチャ：

- `refusing to bind gateway ... without auth` → バインドと認証の不一致。
- ランタイムは起動しているのに `RPC probe: failed` → Gateway ゲートウェイは生存しているが、現在の認証/URL でアクセスできない。

### 3) ペアリングとデバイス ID の状態が変更された

```bash
openclaw devices list
openclaw pairing list --channel <channel> [--account <id>]
openclaw logs --follow
openclaw doctor
```

確認するポイント：

- ダッシュボード/ノードの保留中のデバイス承認。
- ポリシーまたは ID の変更後の保留中のダイレクトメッセージペアリング承認。

よくあるシグネチャ：

- `device identity required` → デバイス認証が満たされていない。
- `pairing required` → 送信者/デバイスの承認が必要。

チェック後もサービス設定とランタイムが一致しない場合、同じプロファイル/ステートディレクトリからサービスメタデータを再インストールしてください：

```bash
openclaw gateway install --force
openclaw gateway restart
```

関連：

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
