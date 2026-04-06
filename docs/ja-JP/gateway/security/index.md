---
read_when:
  - アクセスや自動化を拡大する機能を追加する場合
summary: "シェルアクセスを持つAI Gatewayを実行するためのセキュリティ考慮事項と脅威モデル"
title: "Security"
x-i18n:
  generated_at: "2026-04-03T00:00:00Z"
  model: claude-sonnet-4-6
  provider: anthropic
  source_hash: ""
  source_path: gateway/security/index.md
  workflow: 15
---

# セキュリティ

<Warning>
**個人アシスタントのトラストモデル:** このガイダンスはGateway ゲートウェイごとに1つの信頼できるオペレーター境界を前提としています（シングルユーザー/個人アシスタントモデル）。
OpenClawは、1つのエージェント/Gatewayを共有する複数の敵対的ユーザーに対して、**悪意あるマルチテナントのセキュリティ境界ではありません**。
混在信頼または敵対的ユーザーの操作が必要な場合は、信頼境界を分割してください（別のGateway + 認証情報、理想的には別のOSユーザー/ホスト）。
</Warning>

**このページ:** [トラストモデル](#scope-first-personal-assistant-security-model) | [クイック監査](#quick-check-openclaw-security-audit) | [強化ベースライン](#hardened-baseline-in-60-seconds) | [DMアクセスモデル](#dm-access-model-pairing--allowlist--open--disabled) | [設定の強化](#configuration-hardening-examples) | [インシデント対応](#incident-response)

## スコープ優先: 個人アシスタントセキュリティモデル

OpenClawのセキュリティガイダンスは**個人アシスタント**デプロイメントを前提としています: 1つの信頼できるオペレーター境界、潜在的に多数のエージェント。

- サポートされるセキュリティポスチャー: Gatewayごとに1ユーザー/信頼境界（OSユーザー/ホスト/VPSごとに1つを推奨）。
- サポートされないセキュリティ境界: 相互に信頼できないまたは敵対的なユーザーが使用する1つの共有Gateway/エージェント。
- 敵対的ユーザーの分離が必要な場合は、信頼境界で分割してください（別のGateway + 認証情報、理想的には別のOSユーザー/ホスト）。
- 複数の信頼できないユーザーが1つのツール対応エージェントにメッセージを送れる場合、それらは同じ委任ツール権限を共有しているとみなします。

このページでは**そのモデル内での**強化について説明します。1つの共有Gateway上での悪意あるマルチテナント分離を主張するものではありません。

## クイックチェック: `openclaw security audit`

参照: [フォーマル検証（セキュリティモデル）](/security/formal-verification)

設定を変更したり、ネットワークサーフェスを公開した後は定期的に実行してください:

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

一般的な落とし穴（Gateway認証の露出、ブラウザコントロールの露出、昇格した許可リスト、ファイルシステム権限、許容的なexec承認、オープンチャンネルのツール露出）を検出します。

OpenClawは製品であり実験でもあります: フロンティアモデルの動作を実際のメッセージングサーフェスと実際のツールに接続しています。**「完全にセキュアな」セットアップは存在しません。** 目標は以下について意図的に考えることです:

- 誰がボットと話せるか
- ボットはどこで行動を許可されているか
- ボットは何に触れることができるか

機能する最小限のアクセスから始め、自信がつくにつれて拡大してください。

### デプロイメントとホストの信頼

OpenClawはホストとconfig境界が信頼されていることを前提としています:

- Gateway ゲートウェイのホスト状態/config（`~/.openclaw`、`openclaw.json`を含む）を変更できる場合、信頼できるオペレーターとして扱ってください。
- 複数の相互に信頼できない/敵対的なオペレーターに対して1つのGateway ゲートウェイを実行することは**推奨されるセットアップではありません**。
- 混在信頼チームの場合は、別のGateway（または最低限、別のOSユーザー/ホスト）で信頼境界を分割してください。
- 推奨デフォルト: マシン/ホスト（またはVPS）ごとに1ユーザー、そのユーザー用に1つのGateway ゲートウェイ、そのGateway内に1つ以上のエージェント。
- 1つのGateway ゲートウェイインスタンス内で、認証されたオペレーターアクセスは信頼できるコントロールプレーンロールであり、ユーザーごとのテナントロールではありません。
- セッション識別子（`sessionKey`、セッションID、ラベル）はルーティングセレクターであり、認証トークンではありません。
- 複数の人が1つのツール対応エージェントにメッセージを送れる場合、それぞれがその同じ権限セットを操作できます。ユーザーごとのセッション/メモリ分離はプライバシーに役立ちますが、共有エージェントをユーザーごとのホスト認証に変換するわけではありません。

### 共有Slackワークスペース: 実際のリスク

「Slackの誰もがボットにメッセージを送れる」場合、核心的なリスクは委任ツール権限です:

- 許可された送信者は誰でも、エージェントのポリシー範囲内でツール呼び出し（`exec`、ブラウザ、ネットワーク/ファイルツール）を誘発できます。
- 1人の送信者からのプロンプト/コンテンツインジェクションが共有状態、デバイス、または出力に影響するアクションを引き起こす可能性があります。
- 1つの共有エージェントが機密認証情報/ファイルを持っている場合、許可された送信者はツール使用によって流出を引き起こす可能性があります。

チームワークフローにはツールを最小限にした別々のエージェント/Gatewayを使用してください; 個人データエージェントはプライベートに保ってください。

### 会社の共有エージェント: 許容されるパターン

そのエージェントを使用するすべての人が同じ信頼境界（例: 1つの会社チーム）にあり、エージェントが厳密にビジネスに限定されている場合に許容されます。

- 専用のマシン/VM/コンテナで実行してください。
- そのランタイム用の専用OSユーザー + 専用ブラウザ/プロファイル/アカウントを使用してください。
- 個人のApple/Googleアカウントや個人のパスワードマネージャー/ブラウザプロファイルをそのランタイムにサインインしないでください。

個人と会社のアイデンティティを同じランタイムで混在させると、分離が崩れ、個人データ露出リスクが高まります。

## Gateway ゲートウェイとノードの信頼概念

Gateway ゲートウェイとノードを、異なるロールを持つ1つのオペレータートラストドメインとして扱います:

- **Gateway ゲートウェイ**はコントロールプレーンとポリシーサーフェスです（`gateway.auth`、ツールポリシー、ルーティング）。
- **ノード**はそのGateway ゲートウェイにペアリングされたリモート実行サーフェスです（コマンド、デバイスアクション、ホストローカル機能）。
- Gateway ゲートウェイに認証された呼び出し元はGatewayスコープで信頼されます。ペアリング後、ノードアクションはそのノードの信頼されたオペレーターアクションです。
- `sessionKey`はルーティング/コンテキスト選択であり、ユーザーごとの認証ではありません。
- Exec承認（許可リスト + 確認）はオペレーターの意図のためのガードレールであり、悪意あるマルチテナント分離ではありません。
- Exec承認は正確なリクエストコンテキストとベストエフォートの直接ローカルファイルオペランドをバインドします; すべてのランタイム/インタープリターローダーパスを意味的にモデル化するわけではありません。強い境界にはサンドボックスとホスト分離を使用してください。

敵対的ユーザー分離が必要な場合は、OSユーザー/ホストで信頼境界を分割し、別々のGateway ゲートウェイを実行してください。

## 信頼境界マトリックス

リスクをトリアージする際のクイックモデルとして使用してください:

| 境界またはコントロール                        | 意味                                             | よくある誤解                                                                       |
| --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `gateway.auth`（token/password/device auth）  | Gateway ゲートウェイAPIへの呼び出し元を認証する   | 「セキュアにするには全フレームにメッセージごとの署名が必要」                         |
| `sessionKey`                                  | コンテキスト/セッション選択のルーティングキー     | 「セッションキーはユーザー認証境界」                                                |
| プロンプト/コンテンツガードレール              | モデル悪用リスクを軽減する                        | 「プロンプトインジェクション単独で認証バイパスが証明される」                         |
| `canvas.eval` / ブラウザ評価                  | 有効時のオペレーターの意図的な機能               | 「JSのeval原始は自動的にこのトラストモデルの脆弱性」                                |
| ローカルTUI `!` シェル                        | 明示的なオペレーターによるローカル実行           | 「ローカルシェルの便利なコマンドはリモートインジェクション」                         |
| ノードのペアリングとノードコマンド             | ペアリングされたデバイスでのオペレーターレベルのリモート実行 | 「リモートデバイスコントロールはデフォルトで信頼できないユーザーアクセスとして扱うべき」 |

## 設計上の脆弱性ではないもの

これらのパターンはよく報告されますが、実際の境界バイパスが示されない限り通常はノーアクションとして閉じられます:

- ポリシー/認証/サンドボックスバイパスなしのプロンプトインジェクションのみのチェーン。
- 1つの共有ホスト/configでの悪意あるマルチテナント操作を前提とする主張。
- 共有Gateway設定での通常のオペレーターの読み取りパスアクセス（例: `sessions.list`/`sessions.preview`/`chat.history`）をIDORとして分類する主張。
- ローカルホストのみのデプロイメント検出（例: ループバックのみのGatewayでのHSTS）。
- このリポジトリに存在しない受信パスのDiscordインバウンドWebhook署名の検出。
- ノードペアリングメタデータを`system.run`の隠れた第2のコマンドごとの承認レイヤーとして扱うレポート（実際の実行境界はGatewayのグローバルノードコマンドポリシーとノード自身のexec承認）。
- `sessionKey`を認証トークンとして扱う「ユーザーごとの認証がない」という検出。

## 研究者の事前チェックリスト

GHSAを開く前に、以下をすべて確認してください:

1. 最新の`main`または最新リリースで再現可能である。
2. レポートに正確なコードパス（`file`、関数、行番号）とテスト済みのバージョン/コミットが含まれている。
3. 影響が文書化された信頼境界を越えている（プロンプトインジェクションのみではない）。
4. 主張が[対象外](https://github.com/openclaw/openclaw/blob/main/SECURITY.md#out-of-scope)に記載されていない。
5. 重複のために既存のアドバイザリが確認されている（該当する場合は正規のGHSAを再利用）。
6. デプロイメントの前提が明示されている（ループバック/ローカル対公開、信頼できる対信頼できないオペレーター）。

## 60秒での強化ベースライン

このベースラインを最初に使用し、信頼できるエージェントごとに選択的にツールを再有効化してください:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "replace-with-long-random-token" },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "group:fs", "sessions_spawn", "sessions_send"],
    fs: { workspaceOnly: true },
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
  channels: {
    whatsapp: { dmPolicy: "pairing", groups: { "*": { requireMention: true } } },
  },
}
```

これによりGateway ゲートウェイがローカルのみになり、DMが分離され、コントロールプレーン/ランタイムツールがデフォルトで無効化されます。

## 共有受信トレイのクイックルール

1人以上の人がボットにDMできる場合:

- `session.dmScope: "per-channel-peer"`を設定します（複数アカウントのチャンネルでは`"per-account-channel-peer"`）。
- `dmPolicy: "pairing"`または厳格な許可リストを維持してください。
- 広範なツールアクセスと共有DMを組み合わせないでください。
- これは協力的/共有の受信トレイを強化しますが、ユーザーがホスト/configの書き込みアクセスを共有する場合は敵対的な共同テナント分離として設計されていません。

## 監査がチェックすること（概要）

- **インバウンドアクセス**（DMポリシー、グループポリシー、許可リスト）: 見知らぬ人がボットをトリガーできるか?
- **ツールのブラスト半径**（昇格ツール + オープンルーム）: プロンプトインジェクションがシェル/ファイル/ネットワークアクションになりうるか?
- **Exec承認のドリフト**（`security=full`、`autoAllowSkills`、`strictInlineEval`なしのインタープリター許可リスト）: ホスト実行ガードレールは期待通りに機能しているか?
- **ネットワーク露出**（Gateway ゲートウェイのバインド/認証、Tailscale Serve/Funnel、弱い/短い認証トークン）。
- **ブラウザコントロールの露出**（リモートノード、リレーポート、リモートCDPエンドポイント）。
- **ローカルディスクの衛生**（権限、シンボリックリンク、config include、「同期フォルダー」パス）。
- **プラグイン**（明示的な許可リストなしで拡張機能が存在する）。
- **ポリシードリフト/設定ミス**（サンドボックスDockerの設定はあるがサンドボックスモードがオフ; マッチングが正確なコマンド名のみのため無効な`gateway.nodes.denyCommands`パターン; 危険な`gateway.nodes.allowCommands`エントリ; エージェントごとのプロファイルでオーバーライドされるグローバルな`tools.profile="minimal"`; 許容的なツールポリシー下で到達可能な拡張プラグインツール）。
- **ランタイム期待のドリフト**（例: `tools.exec.host`が`auto`にデフォルト設定されたときに暗黙的なexecがまだ`sandbox`を意味すると仮定する、またはサンドボックスモードがオフの状態で明示的に`tools.exec.host="sandbox"`を設定する）。
- **モデルの衛生**（設定されたモデルがレガシーに見える場合に警告; ハードブロックではない）。

`--deep`を実行すると、OpenClawはベストエフォートのライブGateway ゲートウェイプローブも試みます。

## 認証情報ストレージマップ

アクセスを監査したり、バックアップ対象を決定する際に使用してください:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegramボットトークン**: config/envまたは`channels.telegram.tokenFile`（通常のファイルのみ; シンボリックリンクは拒否）
- **Discordボットトークン**: config/envまたはSecretRef（env/file/execプロバイダー）
- **Slackトークン**: config/env（`channels.slack.*`）
- **ペアリング許可リスト**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json`（デフォルトアカウント）
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json`（デフォルト以外のアカウント）
- **モデル認証プロファイル**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **ファイルバックのシークレットペイロード（オプション）**: `~/.openclaw/secrets.json`
- **レガシーOAuthインポート**: `~/.openclaw/credentials/oauth.json`

## セキュリティ監査チェックリスト

監査が検出結果を出力した場合、これを優先順位として扱ってください:

1. **「open」かつツールが有効**: まずDM/グループをロックダウン（ペアリング/許可リスト）、次にツールポリシー/サンドボックスを強化。
2. **パブリックネットワーク露出**（LANバインド、Funnel、認証なし）: 直ちに修正。
3. **ブラウザコントロールのリモート露出**: オペレーターアクセスと同様に扱います（テイルネットのみ、意図的にノードをペアリング、パブリック露出を避ける）。
4. **権限**: 状態/config/認証情報/認証がグループ/ワールド読み取り可能でないことを確認。
5. **プラグイン/拡張機能**: 明示的に信頼するものだけをロード。
6. **モデルの選択**: ツールを持つボットには最新の、命令強化されたモデルを優先。

## セキュリティ監査用語集

実際のデプロイメントで最もよく見られる高シグナルの`checkId`値（網羅的ではありません）:

| `checkId`                                                     | 重大度        | 重要な理由                                                                           | 主要な修正キー/パス                                                                                  | 自動修正 |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------- |
| `fs.state_dir.perms_world_writable`                           | critical      | 他のユーザー/プロセスがOpenClawの完全な状態を変更できる                              | `~/.openclaw`のファイルシステム権限                                                                  | yes      |
| `fs.config.perms_writable`                                    | critical      | 他者が認証/ツールポリシー/configを変更できる                                         | `~/.openclaw/openclaw.json`のファイルシステム権限                                                    | yes      |
| `fs.config.perms_world_readable`                              | critical      | configがトークン/設定を露出する可能性                                                | configファイルのファイルシステム権限                                                                  | yes      |
| `gateway.bind_no_auth`                                        | critical      | 共有シークレットなしのリモートバインド                                               | `gateway.bind`、`gateway.auth.*`                                                                     | no       |
| `gateway.loopback_no_auth`                                    | critical      | リバースプロキシ経由のループバックが認証なしになる可能性                             | `gateway.auth.*`、プロキシ設定                                                                       | no       |
| `gateway.http.no_auth`                                        | warn/critical | `auth.mode="none"`でGateway HTTP APIに到達可能                                      | `gateway.auth.mode`、`gateway.http.endpoints.*`                                                      | no       |
| `gateway.tools_invoke_http.dangerous_allow`                   | warn/critical | HTTP API経由で危険なツールを再有効化                                                 | `gateway.tools.allow`                                                                                | no       |
| `gateway.nodes.allow_commands_dangerous`                      | warn/critical | 高影響ノードコマンドを有効化（カメラ/画面/連絡先/カレンダー/SMS）                    | `gateway.nodes.allowCommands`                                                                        | no       |
| `gateway.tailscale_funnel`                                    | critical      | パブリックインターネット露出                                                         | `gateway.tailscale.mode`                                                                             | no       |
| `gateway.control_ui.allowed_origins_required`                 | critical      | 明示的なブラウザオリジン許可リストなしの非ループバックControl UI                    | `gateway.controlUi.allowedOrigins`                                                                   | no       |
| `gateway.control_ui.host_header_origin_fallback`              | warn/critical | Hostヘッダーオリジンフォールバックを有効化（DNSリバインディング強化のダウングレード）  | `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`                                         | no       |
| `gateway.control_ui.insecure_auth`                            | warn          | 安全でない認証互換性トグルが有効                                                     | `gateway.controlUi.allowInsecureAuth`                                                                | no       |
| `gateway.control_ui.device_auth_disabled`                     | critical      | デバイスアイデンティティチェックを無効化                                             | `gateway.controlUi.dangerouslyDisableDeviceAuth`                                                     | no       |
| `gateway.real_ip_fallback_enabled`                            | warn/critical | `X-Real-IP`フォールバックを信頼するとプロキシ設定ミスによるソースIPスプーフィングが可能 | `gateway.allowRealIpFallback`、`gateway.trustedProxies`                                              | no       |
| `discovery.mdns_full_mode`                                    | warn/critical | mDNSフルモードがローカルネットワークで`cliPath`/`sshPort`メタデータをアドバタイズ    | `discovery.mdns.mode`、`gateway.bind`                                                                | no       |
| `config.insecure_or_dangerous_flags`                          | warn          | 安全でない/危険なデバッグフラグが有効                                                | 複数のキー（検出の詳細を参照）                                                                       | no       |
| `hooks.token_reuse_gateway_token`                             | critical      | フックイングレストークンがGateway認証もアンロック                                    | `hooks.token`、`gateway.auth.token`                                                                  | no       |
| `hooks.token_too_short`                                       | warn          | フックイングレスへのブルートフォースが容易                                           | `hooks.token`                                                                                        | no       |
| `hooks.default_session_key_unset`                             | warn          | フックエージェントの実行がリクエストごとに生成されたセッションにファンアウト          | `hooks.defaultSessionKey`                                                                            | no       |
| `hooks.allowed_agent_ids_unrestricted`                        | warn/critical | 認証されたフック呼び出し元が任意の設定済みエージェントにルーティング可能              | `hooks.allowedAgentIds`                                                                              | no       |
| `hooks.request_session_key_enabled`                           | warn/critical | 外部呼び出し元がsessionKeyを選択可能                                                 | `hooks.allowRequestSessionKey`                                                                       | no       |
| `hooks.request_session_key_prefixes_missing`                  | warn/critical | 外部セッションキーの形状に制限なし                                                   | `hooks.allowedSessionKeyPrefixes`                                                                    | no       |
| `logging.redact_off`                                          | warn          | 機密値がログ/ステータスに漏れる                                                      | `logging.redactSensitive`                                                                            | yes      |
| `sandbox.docker_config_mode_off`                              | warn          | サンドボックスDocker configが存在するが非アクティブ                                  | `agents.*.sandbox.mode`                                                                              | no       |
| `sandbox.dangerous_network_mode`                              | critical      | サンドボックスDockerネットワークが`host`または`container:*`ネームスペース結合モード   | `agents.*.sandbox.docker.network`                                                                    | no       |
| `tools.exec.host_sandbox_no_sandbox_defaults`                 | warn          | `exec host=sandbox`はサンドボックスがオフの時に失敗するよう閉じられる               | `tools.exec.host`、`agents.defaults.sandbox.mode`                                                    | no       |
| `tools.exec.host_sandbox_no_sandbox_agents`                   | warn          | エージェントごとの`exec host=sandbox`はサンドボックスがオフの時に失敗するよう閉じられる | `agents.list[].tools.exec.host`、`agents.list[].sandbox.mode`                                        | no       |
| `tools.exec.security_full_configured`                         | warn/critical | ホストexecが`security="full"`で実行中                                                | `tools.exec.security`、`agents.list[].tools.exec.security`                                           | no       |
| `tools.exec.auto_allow_skills_enabled`                        | warn          | Exec承認がスキルビンを暗黙的に信頼                                                   | `~/.openclaw/exec-approvals.json`                                                                    | no       |
| `tools.exec.allowlist_interpreter_without_strict_inline_eval` | warn          | インタープリター許可リストが強制的な再承認なしにインラインevalを許可                  | `tools.exec.strictInlineEval`、`agents.list[].tools.exec.strictInlineEval`、exec承認許可リスト        | no       |
| `tools.exec.safe_bins_interpreter_unprofiled`                 | warn          | プロファイルなしの`safeBins`内のインタープリター/ランタイムビンがexecリスクを拡大     | `tools.exec.safeBins`、`tools.exec.safeBinProfiles`、`agents.list[].tools.exec.*`                    | no       |
| `tools.exec.safe_bins_broad_behavior`                         | warn          | `safeBins`内の広い動作ツールが低リストstdinフィルタートラストモデルを弱める          | `tools.exec.safeBins`、`agents.list[].tools.exec.safeBins`                                           | no       |
| `skills.workspace.symlink_escape`                             | warn          | ワークスペース`skills/**/SKILL.md`がワークスペースルート外に解決（シンボリックリンクチェーンドリフト） | ワークスペース`skills/**`ファイルシステム状態                                                         | no       |
| `security.exposure.open_channels_with_exec`                   | warn/critical | 共有/パブリックルームがexec対応エージェントに到達可能                               | `channels.*.dmPolicy`、`channels.*.groupPolicy`、`tools.exec.*`、`agents.list[].tools.exec.*`        | no       |
| `security.exposure.open_groups_with_elevated`                 | critical      | オープングループ + 昇格ツールが高影響のプロンプトインジェクションパスを作成          | `channels.*.groupPolicy`、`tools.elevated.*`                                                         | no       |
| `security.exposure.open_groups_with_runtime_or_fs`            | critical/warn | オープングループがサンドボックス/ワークスペースガードなしのコマンド/ファイルツールに到達可能 | `channels.*.groupPolicy`、`tools.profile/deny`、`tools.fs.workspaceOnly`、`agents.*.sandbox.mode`    | no       |
| `security.trust_model.multi_user_heuristic`                   | warn          | Gatewayトラストモデルが個人アシスタントである間にconfigがマルチユーザーに見える     | 信頼境界を分割するか、共有ユーザー強化（`sandbox.mode`、ツール deny/ワークスペーススコープ）          | no       |
| `tools.profile_minimal_overridden`                            | warn          | エージェントのオーバーライドがグローバルの最小プロファイルをバイパス                 | `agents.list[].tools.profile`                                                                        | no       |
| `plugins.tools_reachable_permissive_policy`                   | warn          | 許容的なコンテキストで拡張ツールに到達可能                                           | `tools.profile` + ツールのallow/deny                                                                 | no       |
| `models.small_params`                                         | critical/info | 小さなモデル + 安全でないツールサーフェスがインジェクションリスクを高める            | モデルの選択 + サンドボックス/ツールポリシー                                                          | no       |

## HTTP経由のControl UI

Control UIはデバイスアイデンティティを生成するために**セキュアコンテキスト**（HTTPSまたはlocalhost）が必要です。`gateway.controlUi.allowInsecureAuth`はローカル互換性トグルです:

- localhostでは、ページが非セキュアHTTP経由でロードされる場合でも、デバイスアイデンティティなしのControl UI認証を許可します。
- ペアリングチェックをバイパスしません。
- リモート（非localhost）のデバイスアイデンティティ要件を緩和しません。

HTTPSを優先してください（Tailscale Serve）または`127.0.0.1`でUIを開いてください。

break-glassシナリオのみに対して、`gateway.controlUi.dangerouslyDisableDeviceAuth`はデバイスアイデンティティチェックを完全に無効化します。これは深刻なセキュリティダウングレードです; アクティブにデバッグしていて迅速に元に戻せる場合以外はオフにしてください。

この設定が有効な場合、`openclaw security audit`が警告します。

## 安全でないまたは危険なフラグの概要

`openclaw security audit`は既知の安全でない/危険なデバッグスイッチが有効な場合に`config.insecure_or_dangerous_flags`を含めます。そのチェックは現在以下を集約します:

- `gateway.controlUi.allowInsecureAuth=true`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`
- `gateway.controlUi.dangerouslyDisableDeviceAuth=true`
- `hooks.gmail.allowUnsafeExternalContent=true`
- `hooks.mappings[<index>].allowUnsafeExternalContent=true`
- `tools.exec.applyPatch.workspaceOnly=false`
- `plugins.entries.acpx.config.permissionMode=approve-all`

OpenClaw configスキーマで定義されている完全な`dangerous*` / `dangerously*` configキー:

- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`
- `gateway.controlUi.dangerouslyDisableDeviceAuth`
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`
- `channels.discord.dangerouslyAllowNameMatching`
- `channels.discord.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.slack.dangerouslyAllowNameMatching`
- `channels.slack.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.googlechat.dangerouslyAllowNameMatching`
- `channels.googlechat.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.msteams.dangerouslyAllowNameMatching`
- `channels.synology-chat.dangerouslyAllowNameMatching`（拡張チャンネル）
- `channels.synology-chat.accounts.<accountId>.dangerouslyAllowNameMatching`（拡張チャンネル）
- `channels.zalouser.dangerouslyAllowNameMatching`（拡張チャンネル）
- `channels.irc.dangerouslyAllowNameMatching`（拡張チャンネル）
- `channels.irc.accounts.<accountId>.dangerouslyAllowNameMatching`（拡張チャンネル）
- `channels.mattermost.dangerouslyAllowNameMatching`（拡張チャンネル）
- `channels.mattermost.accounts.<accountId>.dangerouslyAllowNameMatching`（拡張チャンネル）
- `agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets`
- `agents.defaults.sandbox.docker.dangerouslyAllowExternalBindSources`
- `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowReservedContainerTargets`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowExternalBindSources`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowContainerNamespaceJoin`

## リバースプロキシの設定

Gateway ゲートウェイをリバースプロキシ（nginx、Caddy、Traefik等）の背後で実行する場合、適切なクライアントIP検出のために`gateway.trustedProxies`を設定してください。

Gateway ゲートウェイが**`trustedProxies`に含まれていない**アドレスからのプロキシヘッダーを検出すると、接続をローカルクライアントとして扱いません。Gatewayの認証が無効な場合、それらの接続は拒否されます。これにより、プロキシ接続がlocalhostからのものように見えて自動的に信頼されることによる認証バイパスを防ぎます。

```yaml
gateway:
  trustedProxies:
    - "127.0.0.1" # プロキシがlocalhostで実行されている場合
  # オプション。デフォルトはfalse。
  # プロキシがX-Forwarded-Forを提供できない場合のみ有効にしてください。
  allowRealIpFallback: false
  auth:
    mode: password
    password: ${OPENCLAW_GATEWAY_PASSWORD}
```

`trustedProxies`が設定されると、Gateway ゲートウェイはクライアントIPを決定するために`X-Forwarded-For`を使用します。`X-Real-IP`は`gateway.allowRealIpFallback: true`が明示的に設定されない限りデフォルトで無視されます。

良いリバースプロキシの動作（受信転送ヘッダーを上書き）:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

悪いリバースプロキシの動作（信頼できない転送ヘッダーを追加/保持）:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

## HSTSとオリジンに関する注意

- OpenClaw Gatewayはローカル/ループバック優先です。リバースプロキシでTLSを終端する場合、プロキシ向けのHTTPSドメインでHSTSを設定してください。
- Gateway ゲートウェイ自体がHTTPSを終端する場合、`gateway.http.securityHeaders.strictTransportSecurity`を設定してOpenClawレスポンスからHSTSヘッダーを送出できます。
- 詳細なデプロイメントガイダンスは[Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts)にあります。
- 非ループバックのControl UIデプロイメントでは、デフォルトで`gateway.controlUi.allowedOrigins`が必要です。
- `gateway.controlUi.allowedOrigins: ["*"]`は明示的なすべてのブラウザオリジンを許可するポリシーであり、強化されたデフォルトではありません。厳密に制御されたローカルテスト以外では避けてください。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`はHostヘッダーオリジンフォールバックモードを有効化します; 危険なオペレーター選択ポリシーとして扱ってください。
- DNSリバインディングとプロキシホストヘッダーの動作はデプロイメント強化の懸念事項として扱ってください; `trustedProxies`を厳格に保ち、Gateway ゲートウェイをパブリックインターネットに直接公開しないでください。

## ローカルセッションログはディスクに保存される

OpenClawはセッションのトランスクリプトを`~/.openclaw/agents/<agentId>/sessions/*.jsonl`のディスク上に保存します。
これはセッションの継続性と（オプションで）セッションメモリインデックスに必要ですが、
**ファイルシステムアクセスを持つすべてのプロセス/ユーザーがこれらのログを読み取れる**ことも意味します。ディスクアクセスを信頼境界として扱い、`~/.openclaw`の権限をロックダウンしてください（下記の監査セクションを参照）。エージェント間のより強い分離が必要な場合は、別のOSユーザーまたは別のホストで実行してください。

## ノード実行（system.run）

macOSノードがペアリングされている場合、Gateway ゲートウェイはそのノードで`system.run`を呼び出せます。これはMac上の**リモートコード実行**です:

- ノードのペアリング（承認 + トークン）が必要。
- Gateway ゲートウェイのノードペアリングはコマンドごとの承認サーフェスではありません。ノードのアイデンティティ/信頼とトークン発行を確立します。
- Gateway ゲートウェイは`gateway.nodes.allowCommands` / `denyCommands`を通じてグローバルなノードコマンドポリシーを適用します。
- Macの**Settings → Exec approvals**（security + ask + 許可リスト）で制御されます。
- ノードごとの`system.run`ポリシーはノード自身のexec承認ファイル（`exec.approvals.node.*`）であり、Gatewayのグローバルコマンドポリシーより厳格または緩和できます。
- 承認モードは正確なリクエストコンテキストと、可能な場合は1つの具体的なローカルスクリプト/ファイルオペランドをバインドします。インタープリター/ランタイムコマンドに対して正確に1つの直接ローカルファイルを識別できない場合、承認ベースの実行は完全な意味的カバレッジを約束するのではなく拒否されます。
- リモート実行を望まない場合は、securityを**deny**に設定し、そのMacのノードペアリングを削除してください。

この区別はトリアージに重要です:

- 別のコマンドリストをアドバタイズする再接続ペアリングノードは、Gateway ゲートウェイのグローバルポリシーとノードのローカルexec承認が実際の実行境界を引き続き強制している場合、それ自体では脆弱性ではありません。
- ノードペアリングメタデータを`system.run`の隠れた第2のコマンドごとの承認レイヤーとして扱うレポートは通常、セキュリティ境界バイパスではなく、ポリシー/UXの混乱です。

## 動的スキル（ウォッチャー / リモートノード）

OpenClawはセッション中盤でスキルリストを更新できます:

- **スキルウォッチャー**: `SKILL.md`の変更は次のエージェントターンでスキルスナップショットを更新できます。
- **リモートノード**: macOSノードを接続するとmacOS専用スキルが適格になる可能性があります（バイナリプロービングに基づく）。

スキルフォルダーを**信頼されたコード**として扱い、変更できる人を制限してください。

## 脅威モデル

AIアシスタントは以下が可能です:

- 任意のシェルコマンドを実行
- ファイルの読み書き
- ネットワークサービスへのアクセス
- 誰にでもメッセージを送信（WhatsAppアクセスを与えた場合）

あなたにメッセージを送る人は以下を試みる可能性があります:

- AIをだまして悪いことをさせる
- データへのアクセスをソーシャルエンジニアリングする
- インフラの詳細を探る

## コア概念: インテリジェンスの前にアクセスコントロール

ここでの失敗のほとんどは凝ったエクスプロイトではなく「誰かがボットにメッセージを送り、ボットが言われた通りにした」です。

OpenClawのスタンス:

- **アイデンティティ優先:** ボットと話せる人を決定します（DMペアリング / 許可リスト / 明示的な「open」）。
- **スコープ次:** ボットが行動を許可される場所を決定します（グループ許可リスト + メンションゲーティング、ツール、サンドボックス、デバイス権限）。
- **モデルは最後:** モデルが操作される可能性があると仮定します; 操作のブラスト半径が限定されるように設計してください。

## コマンド認証モデル

スラッシュコマンドとディレクティブは**認証された送信者**に対してのみ有効です。認証はチャンネルの許可リスト/ペアリングと`commands.useAccessGroups`から派生します（[Configuration](/gateway/configuration)と[スラッシュコマンド](/tools/slash-commands)を参照）。チャンネルの許可リストが空または`"*"`を含む場合、コマンドはそのチャンネルに対して実質的にオープンです。

`/exec`は認証されたオペレーターのセッション専用の便利機能です。configを書き込んだり他のセッションを変更したりは**しません**。

## コントロールプレーンツールのリスク

2つの組み込みツールが永続的なコントロールプレーンの変更を行える可能性があります:

- `gateway`は`config.apply`、`config.patch`、`update.run`を呼び出せます。
- `cron`は元のチャット/タスクが終了した後も実行し続けるスケジュールされたジョブを作成できます。

信頼できないコンテンツを処理するエージェント/サーフェスに対して、これらをデフォルトで拒否してください:

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send"],
  },
}
```

`commands.restart=false`は再起動アクションのみをブロックします。`gateway`のconfig/updateアクションは無効化しません。

## プラグイン/拡張機能

プラグインはGateway ゲートウェイとともに**インプロセス**で実行されます。信頼されたコードとして扱ってください:

- 信頼するソースからのみプラグインをインストールしてください。
- 明示的な`plugins.allow`許可リストを優先してください。
- 有効化する前にプラグインのconfigを確認してください。
- プラグインの変更後にGateway ゲートウェイを再起動してください。
- プラグインをインストールする場合（`openclaw plugins install <package>`）、信頼できないコードの実行と同様に扱ってください:
  - インストールパスはアクティブなプラグインインストールルート下のプラグインごとのディレクトリです。
  - OpenClawはインストール前に組み込みの危険なコードスキャンを実行します。`critical`の検出はデフォルトでブロックします。
  - OpenClawは`npm pack`を使用し、そのディレクトリで`npm install --omit=dev`を実行します（npmライフサイクルスクリプトはインストール中にコードを実行できます）。
  - ピン留めされた正確なバージョン（`@scope/pkg@1.2.3`）を優先し、有効化前にディスク上の展開されたコードを確認してください。
  - `--dangerously-force-unsafe-install`は組み込みスキャンの誤検知のみのbreak-glassです。プラグインの`before_install`フックポリシーのブロックやスキャンの失敗をバイパスしません。
  - Gatewayバックのスキル依存関係のインストールは同じ危険/疑わしい分割に従います: 組み込みの`critical`の検出は呼び出し元が明示的に`dangerouslyForceUnsafeInstall`を設定しない限りブロックし、疑わしい検出は引き続き警告のみです。`openclaw skills install`は別のClawHubスキルのダウンロード/インストールフローのままです。

詳細: [Plugins](/tools/plugin)

## DMアクセスモデル（pairing / allowlist / open / disabled）

現在のすべてのDM対応チャンネルは、メッセージが処理される**前に**インバウンドDMをゲートするDMポリシー（`dmPolicy`または`*.dm.policy`）をサポートしています:

- `pairing`（デフォルト）: 未知の送信者は短いペアリングコードを受け取り、承認されるまでボットはそのメッセージを無視します。コードは1時間後に期限切れになります; 繰り返しのDMは新しいリクエストが作成されるまでコードを再送しません。保留中のリクエストはデフォルトで**チャンネルごとに3件**に制限されます。
- `allowlist`: 未知の送信者はブロックされます（ペアリングハンドシェイクなし）。
- `open`: 誰でもDMを許可します（パブリック）。チャンネルの許可リストに`"*"`を含める**必要があります**（明示的なオプトイン）。
- `disabled`: インバウンドDMを完全に無視します。

CLI経由で承認:

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

詳細 + ディスク上のファイル: [Pairing](/channels/pairing)

## DMセッション分離（マルチユーザーモード）

デフォルトでは、OpenClawはデバイスとチャンネル間で継続性を保てるよう**すべてのDMをメインセッションにルーティング**します。**複数の人**がボットにDMできる場合（オープンDMまたは複数人の許可リスト）、DMセッションの分離を検討してください:

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

これによりグループチャットを分離したままユーザー間のコンテキスト漏洩を防ぎます。

これはメッセージングコンテキスト境界であり、ホスト管理境界ではありません。ユーザーが相互に敵対的で同じGateway ゲートウェイのホスト/configを共有している場合、代わりに信頼境界ごとに別々のGateway ゲートウェイを実行してください。

### セキュアDMモード（推奨）

上記のスニペットを**セキュアDMモード**として扱ってください:

- デフォルト: `session.dmScope: "main"`（すべてのDMが継続性のために1つのセッションを共有）。
- ローカルCLIオンボーディングのデフォルト: 未設定の場合`session.dmScope: "per-channel-peer"`を書き込みます（既存の明示的な値は保持）。
- セキュアDMモード: `session.dmScope: "per-channel-peer"`（各チャンネル+送信者のペアが分離されたDMコンテキストを取得）。
- クロスチャンネルピア分離: `session.dmScope: "per-peer"`（各送信者が同じタイプのすべてのチャンネルで1つのセッションを取得）。

同じチャンネルで複数のアカウントを実行する場合は`per-account-channel-peer`を使用してください。同じ人が複数のチャンネルであなたに連絡する場合は、`session.identityLinks`を使用してそれらのDMセッションを1つの正規アイデンティティに統合してください。[Session Management](/concepts/session)と[Configuration](/gateway/configuration)を参照してください。

## 許可リスト（DM + グループ）- 用語

OpenClawには2つの別々の「誰が私をトリガーできるか?」レイヤーがあります:

- **DM許可リスト**（`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`; レガシー: `channels.discord.dm.allowFrom`、`channels.slack.dm.allowFrom`）: ダイレクトメッセージでボットと話すことが許可されている人。
  - `dmPolicy="pairing"`の場合、承認は`~/.openclaw/credentials/`下のアカウントスコープのペアリング許可リストストアに書き込まれます（デフォルトアカウントは`<channel>-allowFrom.json`、デフォルト以外のアカウントは`<channel>-<accountId>-allowFrom.json`）、configの許可リストとマージされます。
- **グループ許可リスト**（チャンネル固有）: ボットがメッセージを受け入れるグループ/チャンネル/ギルド。
  - 一般的なパターン:
    - `channels.whatsapp.groups`、`channels.telegram.groups`、`channels.imessage.groups`: `requireMention`のようなグループごとのデフォルト; 設定されている場合、グループ許可リストとしても機能します（すべて許可する動作を維持するには`"*"`を含めてください）。
    - `groupPolicy="allowlist"` + `groupAllowFrom`: グループセッション内でボットをトリガーできる人を制限します（WhatsApp/Telegram/Signal/iMessage/Microsoft Teams）。
    - `channels.discord.guilds` / `channels.slack.channels`: サーフェスごとの許可リスト + メンションのデフォルト。
  - グループチェックはこの順序で実行されます: `groupPolicy`/グループ許可リスト優先、メンション/返信アクティベーション次。
  - ボットメッセージへの返信（暗黙のメンション）は`groupAllowFrom`のような送信者許可リストを**バイパスしません**。
  - **セキュリティ注意:** `dmPolicy="open"`と`groupPolicy="open"`は最後の手段として扱ってください。ルームのすべてのメンバーを完全に信頼しない限り、ペアリング + 許可リストを優先してください。

詳細: [Configuration](/gateway/configuration)と[Groups](/channels/groups)

## プロンプトインジェクション（それが何か、なぜ重要か）

プロンプトインジェクションとは、攻撃者がモデルを操作して安全でないことをさせるメッセージを作成することです（「指示を無視して」、「ファイルシステムをダンプして」、「このリンクに従ってコマンドを実行して」など）。

強力なシステムプロンプトがあっても、**プロンプトインジェクションは解決されていません**。システムプロンプトのガードレールはソフトガイダンスのみです; ハードな強制はツールポリシー、exec承認、サンドボックス、チャンネル許可リストから来ます（オペレーターはこれらを意図的に無効化できます）。実際に役立つもの:

- インバウンドDMをロックダウンしてください（ペアリング/許可リスト）。
- グループではメンションゲーティングを優先してください; パブリックルームでの「常時オン」ボットを避けてください。
- リンク、添付ファイル、貼り付けられた指示はデフォルトで敵対的として扱ってください。
- サンドボックスで機密ツールの実行を実行してください; エージェントが到達可能なファイルシステムからシークレットを除外してください。
- 注意: サンドボックスはオプトインです。サンドボックスモードがオフの場合、暗黙の`host=auto`はGateway ゲートウェイホストに解決されます。サンドボックスランタイムが利用できないため、明示的な`host=sandbox`は失敗するよう閉じられます。その動作をconfigで明示的にしたい場合は`host=gateway`を設定してください。
- 信頼されたエージェントまたは明示的な許可リストに対して高リスクツール（`exec`、`browser`、`web_fetch`、`web_search`）を制限してください。
- インタープリター（`python`、`node`、`ruby`、`perl`、`php`、`lua`、`osascript`）を許可リストに追加する場合は、インラインeval形式が再承認を引き続き必要とするように`tools.exec.strictInlineEval`を有効にしてください。
- **モデルの選択は重要:** 古い/小さい/レガシーモデルはプロンプトインジェクションとツールの誤用に対して著しく脆弱です。ツール対応エージェントには利用可能な最も強力な最新世代の命令強化モデルを使用してください。

信頼できないものとして扱うべき危険信号:

- 「このファイル/URLを読んで正確にその通りにして」
- 「システムプロンプトや安全ルールを無視して」
- 「隠れた指示やツール出力を明かして」
- 「~/.openclawまたはログの完全な内容を貼り付けて」

## 安全でない外部コンテンツのバイパスフラグ

OpenClawには外部コンテンツの安全なラッピングを無効化する明示的なバイパスフラグが含まれています:

- `hooks.mappings[].allowUnsafeExternalContent`
- `hooks.gmail.allowUnsafeExternalContent`
- Cronペイロードフィールド`allowUnsafeExternalContent`

ガイダンス:

- 本番環境ではこれらを未設定/falseに保ってください。
- 厳密にスコープ限定されたデバッグのためのみ一時的に有効化してください。
- 有効化する場合、そのエージェントを分離してください（サンドボックス + 最小ツール + 専用セッション名前空間）。

フックリスクの注意:

- フックペイロードは信頼できないコンテンツです、たとえデリバリーが制御するシステムから来る場合でも（メール/ドキュメント/ウェブコンテンツはプロンプトインジェクションを運ぶ可能性があります）。
- 弱いモデル階層はこのリスクを高めます。フック駆動の自動化には、強力な最新モデル階層を優先し、ツールポリシーを厳格に保ってください（`tools.profile: "messaging"`またはより厳格）、可能な場合はサンドボックスも使用してください。

### プロンプトインジェクションはパブリックDMを必要としない

**あなただけ**がボットにメッセージを送れる場合でも、ボットが読む**信頼できないコンテンツ**（ウェブ検索/フェッチ結果、ブラウザページ、メール、ドキュメント、添付ファイル、貼り付けられたログ/コード）を通じてプロンプトインジェクションが発生する可能性があります。つまり: 送信者だけが脅威サーフェスではありません; **コンテンツ自体**が敵対的な指示を運ぶ可能性があります。

ツールが有効な場合、典型的なリスクはコンテキストの流出またはツール呼び出しのトリガーです。ブラスト半径を減らすには:

- 信頼できないコンテンツを要約するために読み取り専用または無効化されたツールの**リーダーエージェント**を使用し、要約をメインエージェントに渡してください。
- 必要でない限りツール対応エージェントに`web_search` / `web_fetch` / `browser`をオフにしてください。
- OpenResponses URLインプット（`input_file` / `input_image`）に対して、厳格な`gateway.http.endpoints.responses.files.urlAllowlist`と`gateway.http.endpoints.responses.images.urlAllowlist`を設定し、`maxUrlParts`を低く保ってください。
  空の許可リストは未設定として扱われます; URLフェッチを完全に無効にしたい場合は`files.allowUrl: false` / `images.allowUrl: false`を使用してください。
- 信頼できない入力に触れるエージェントにはサンドボックスと厳格なツール許可リストを有効化してください。
- シークレットをプロンプトに含めないでください; 代わりにGateway ゲートウェイホストのenv/configを通じて渡してください。

### モデルの強度（セキュリティ注意）

プロンプトインジェクション耐性はモデル階層間で**均一ではありません**。小さい/安価なモデルは一般的に、特に敵対的なプロンプト下でのツールの誤用と命令のハイジャックに対してより脆弱です。

<Warning>
ツール対応エージェントまたは信頼できないコンテンツを読むエージェントにとって、古い/小さいモデルでのプロンプトインジェクションリスクはしばしば高すぎます。これらのワークロードを弱いモデル階層で実行しないでください。
</Warning>

推奨事項:

- ツールを実行できるまたはファイル/ネットワークに触れることができるボットには**最新世代の最高階層モデルを使用**してください。
- ツール対応エージェントや信頼できない受信トレイには**古い/弱い/小さい階層を使用しないでください**; プロンプトインジェクションリスクが高すぎます。
- 小さいモデルを使用する必要がある場合は、**ブラスト半径を減らしてください**（読み取り専用ツール、強力なサンドボックス、最小限のファイルシステムアクセス、厳格な許可リスト）。
- 小さいモデルを実行する場合は、**すべてのセッションにサンドボックスを有効化**し、入力が厳格に制御されない限り**web_search/web_fetch/browserを無効化**してください。
- 信頼できる入力とツールなしのチャット専用個人アシスタントには、小さいモデルは通常問題ありません。

<a id="reasoning-verbose-output-in-groups"></a>

## グループでの推論と詳細出力

`/reasoning`と`/verbose`はパブリックチャンネルを意図しない内部推論やツール出力を露出する可能性があります。グループ設定では、明示的に必要な場合のみ**デバッグ専用**として扱い、オフにしてください。

ガイダンス:

- パブリックルームでは`/reasoning`と`/verbose`を無効にしてください。
- 有効化する場合は、信頼できるDMまたは厳格に制御されたルームでのみ行ってください。
- 詳細出力にはツールの引数、URL、モデルが見たデータが含まれる可能性があることを覚えておいてください。

## 設定の強化（例）

### 0) ファイル権限

Gateway ゲートウェイホスト上でconfigと状態をプライベートに保ってください:

- `~/.openclaw/openclaw.json`: `600`（ユーザーの読み書きのみ）
- `~/.openclaw`: `700`（ユーザーのみ）

`openclaw doctor`はこれらの権限を警告して強化を提案できます。

### 0.4) ネットワーク露出（バインド + ポート + ファイアウォール）

Gateway ゲートウェイは単一ポートで**WebSocket + HTTP**を多重化します:

- デフォルト: `18789`
- Config/フラグ/env: `gateway.port`、`--port`、`OPENCLAW_GATEWAY_PORT`

このHTTPサーフェスにはControl UIとCanvasホストが含まれます:

- Control UI（SPAアセット）（デフォルトのベースパス`/`）
- Canvasホスト: `/__openclaw__/canvas/`と`/__openclaw__/a2ui/`（任意のHTML/JS; 信頼できないコンテンツとして扱ってください）

通常のブラウザでcanvasコンテンツをロードする場合、他の信頼できないウェブページと同様に扱ってください:

- Canvasホストを信頼できないネットワーク/ユーザーに公開しないでください。
- 影響を完全に理解していない限り、Canvasコンテンツを特権ウェブサーフェスと同じオリジンで共有しないでください。

バインドモードはGateway ゲートウェイのリスニング先を制御します:

- `gateway.bind: "loopback"`（デフォルト）: ローカルクライアントのみが接続できます。
- 非ループバックバインド（`"lan"`、`"tailnet"`、`"custom"`）は攻撃サーフェスを拡大します。共有トークン/パスワードと実際のファイアウォールとともに使用してください。

経験則:

- LAN バインドよりTailscale Serveを優先してください（ServeはGateway ゲートウェイをループバックに保ち、Tailscaleがアクセスを処理します）。
- LANにバインドする必要がある場合、ソースIPの厳格な許可リストにポートをファイアウォールしてください; 広くポートフォワードしないでください。
- `0.0.0.0`上で認証なしでGateway ゲートウェイを公開しないでください。

### 0.4.1) Dockerポート公開 + UFW（`DOCKER-USER`）

VPS上でDockerを使用してOpenClawを実行する場合、公開されたコンテナポート（`-p HOST:CONTAINER`またはCompose `ports:`）はDockerの転送チェーンを通じてルーティングされ、ホストの`INPUT`ルールのみではないことを覚えておいてください。

Dockerトラフィックをファイアウォールポリシーと一致させるため、`DOCKER-USER`でルールを強制してください（このチェーンはDockerの独自のacceptルールの前に評価されます）。多くの最新ディストロでは`iptables`/`ip6tables`が`iptables-nft`フロントエンドを使用しており、これらのルールはnftablesバックエンドにも適用されます。

最小許可リストの例（IPv4）:

```bash
# /etc/ufw/after.rules（独自の*filterセクションとして追加）
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -s 127.0.0.0/8 -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -s 100.64.0.0/10 -j RETURN
-A DOCKER-USER -p tcp --dport 80 -j RETURN
-A DOCKER-USER -p tcp --dport 443 -j RETURN
-A DOCKER-USER -m conntrack --ctstate NEW -j DROP
-A DOCKER-USER -j RETURN
COMMIT
```

IPv6には別のテーブルがあります。DockerのIPv6が有効な場合は`/etc/ufw/after6.rules`に一致するポリシーを追加してください。

ドキュメントのスニペットに`eth0`のようなインターフェース名をハードコードしないでください。インターフェース名はVPSイメージ間で異なり（`ens3`、`enp*`等）、不一致によって誤ってdenyルールがスキップされる可能性があります。

リロード後のクイック検証:

```bash
ufw reload
iptables -S DOCKER-USER
ip6tables -S DOCKER-USER
nmap -sT -p 1-65535 <public-ip> --open
```

外部ポートは意図的に公開したもの（ほとんどのセットアップでは: SSH + リバースプロキシポート）のみであるべきです。

### 0.4.2) mDNS/Bonjourディスカバリー（情報漏洩）

Gateway ゲートウェイはローカルデバイスディスカバリーのためにmDNS（ポート5353の`_openclaw-gw._tcp`）経由でその存在をブロードキャストします。フルモードでは、操作上の詳細を露出する可能性のあるTXTレコードが含まれます:

- `cliPath`: CLIバイナリへの完全なファイルシステムパス（ユーザー名とインストール場所を明かす）
- `sshPort`: ホスト上のSSH可用性をアドバタイズ
- `displayName`、`lanHost`: ホスト名情報

**操作セキュリティの考慮事項:** インフラの詳細をブロードキャストすると、ローカルネットワーク上の誰でも偵察が容易になります。ファイルシステムパスやSSH可用性のような「無害な」情報でも、攻撃者がブ環境をマッピングするのに役立ちます。

**推奨事項:**

1. **最小モード**（デフォルト、公開されたGateway ゲートウェイに推奨）: mDNSブロードキャストから機密フィールドを省略:

   ```json5
   {
     discovery: {
       mdns: { mode: "minimal" },
     },
   }
   ```

2. ローカルデバイスディスカバリーが不要な場合は**完全に無効化**:

   ```json5
   {
     discovery: {
       mdns: { mode: "off" },
     },
   }
   ```

3. **フルモード**（オプトイン）: TXTレコードに`cliPath` + `sshPort`を含める:

   ```json5
   {
     discovery: {
       mdns: { mode: "full" },
     },
   }
   ```

4. **環境変数**（代替）: config変更なしでmDNSを無効化するには`OPENCLAW_DISABLE_BONJOUR=1`を設定。

最小モードでは、Gateway ゲートウェイはデバイスディスカバリーに十分なブロードキャストを行います（`role`、`gatewayPort`、`transport`）が、`cliPath`と`sshPort`を省略します。CLIパス情報が必要なアプリは代わりに認証済みWebSocket接続を通じてそれを取得できます。

### 0.5) Gateway ゲートウェイのWebSocketをロックダウン（ローカル認証）

Gateway ゲートウェイの認証は**デフォルトで必須**です。トークン/パスワードが設定されていない場合、Gateway ゲートウェイはWebSocket接続を拒否します（失敗するよう閉じられます）。

オンボーディングはデフォルトでトークンを生成します（ループバックでも）ので、ローカルクライアントも認証が必要です。

**すべての**WSクライアントが認証を必要とするようにトークンを設定してください:

```json5
{
  gateway: {
    auth: { mode: "token", token: "your-token" },
  },
}
```

Doctorがトークンを生成できます: `openclaw doctor --generate-gateway-token`。

注意: `gateway.remote.token` / `.password`はクライアント認証情報ソースです。それら自体ではローカルWSアクセスを保護**しません**。
ローカルコールパスは`gateway.auth.*`が未設定の場合のみフォールバックとして`gateway.remote.*`を使用できます。
`gateway.auth.token` / `gateway.auth.password`がSecretRef経由で明示的に設定されて未解決の場合、解決は失敗するよう閉じられます（リモートフォールバックのマスキングなし）。
オプション: `wss://`使用時に`gateway.remote.tlsFingerprint`でリモートTLSをピン留めしてください。
プレーンテキストの`ws://`はデフォルトでループバックのみです。信頼できるプライベートネットワークパスには、クライアントプロセスで`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`をbreak-glassとして設定してください。

ローカルデバイスペアリング:

- デバイスペアリングは**ローカル**接続（ループバックまたはGateway ゲートウェイホスト自身のテイルネットアドレス）に対して自動承認されます。同一ホストクライアントをスムーズにするためです。
- 他のテイルネットピアは**ローカルとして扱われません**; ペアリング承認が引き続き必要です。

認証モード:

- `gateway.auth.mode: "token"`: 共有ベアラートークン（ほとんどのセットアップに推奨）。
- `gateway.auth.mode: "password"`: パスワード認証（env経由での設定を優先: `OPENCLAW_GATEWAY_PASSWORD`）。
- `gateway.auth.mode: "trusted-proxy"`: アイデンティティ対応のリバースプロキシを信頼してユーザーを認証し、ヘッダー経由でアイデンティティを渡します（[Trusted Proxy Auth](/gateway/trusted-proxy-auth)を参照）。

ローテーションチェックリスト（トークン/パスワード）:

1. 新しいシークレットを生成/設定します（`gateway.auth.token`または`OPENCLAW_GATEWAY_PASSWORD`）。
2. Gateway ゲートウェイを再起動します（または、macOSアプリがGatewayを監督している場合はmacOSアプリを再起動）。
3. Gateway ゲートウェイを呼び出すマシン上でリモートクライアントシークレットを更新します（`gateway.remote.token` / `.password`）。
4. 古い認証情報では接続できなくなったことを確認します。

### 0.6) Tailscale Serveのアイデンティティヘッダー

`gateway.auth.allowTailscale`が`true`（Serveのデフォルト）の場合、OpenClawはControl UI/WebSocket認証のためにTailscale Serveのアイデンティティヘッダー（`tailscale-user-login`）を受け入れます。OpenClawはローカルTailscaleデーモン（`tailscale whois`）を通じて`x-forwarded-for`アドレスを解決し、ヘッダーと照合することでアイデンティティを検証します。これはループバックに到達してTailscaleが注入した`x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`を含むリクエストにのみトリガーされます。
HTTP APIエンドポイント（例: `/v1/*`、`/tools/invoke`、`/api/channels/*`）はトークン/パスワード認証を引き続き必要とします。

重要な境界注意:

- Gateway HTTPベアラー認証は事実上全か無かのオペレーターアクセスです。
- `/v1/chat/completions`、`/v1/responses`、`/api/channels/*`を呼び出せる認証情報をそのGateway ゲートウェイの完全アクセスオペレーターシークレットとして扱ってください。
- OpenAI互換HTTPサーフェス上で、共有シークレットベアラー認証はエージェントターンの完全なデフォルトオペレータースコープとオーナーセマンティクスを復元します; 狭い`x-openclaw-scopes`値はその共有シークレットパスを減らしません。
- HTTPでのリクエストごとのスコープセマンティクスはリクエストがtrusted proxy authや`gateway.auth.mode="none"`のようなアイデンティティを持つモードから来る場合にのみ適用されます。
- `/tools/invoke`は同じ共有シークレットルールに従います: トークン/パスワードベアラー認証も完全オペレーターアクセスとして扱われます、アイデンティティを持つモードは引き続き宣言されたスコープを尊重します。
- 信頼できない呼び出し元とこれらの認証情報を共有しないでください; 信頼境界ごとに別々のGateway ゲートウェイを優先してください。

**信頼の前提:** トークンレスのServe認証はGateway ゲートウェイホストが信頼されていると仮定します。敵対的な同一ホストプロセスに対する保護として扱わないでください。Gateway ゲートウェイホスト上で信頼できないローカルコードが実行される可能性がある場合は`gateway.auth.allowTailscale`を無効にし、トークン/パスワード認証を必要とします。

**セキュリティルール:** 独自のリバースプロキシからこれらのヘッダーを転送しないでください。TLSをGateway ゲートウェイの前でプロキシする場合は`gateway.auth.allowTailscale`を無効にし、トークン/パスワード認証（または[Trusted Proxy Auth](/gateway/trusted-proxy-auth)）を使用してください。

信頼されたプロキシ:

- Gateway ゲートウェイの前でTLSを終端する場合は、プロキシIPに`gateway.trustedProxies`を設定してください。
- OpenClawはローカルペアリングチェックとHTTP認証/ローカルチェックのためにクライアントIPを決定するのにそれらのIPからの`x-forwarded-for`（または`x-real-ip`）を信頼します。
- プロキシが`x-forwarded-for`を**上書き**し、Gateway ゲートウェイポートへの直接アクセスをブロックすることを確認してください。

[Tailscale](/gateway/tailscale)と[Web overview](/web)を参照してください。

### 0.6.1) ノードホスト経由のブラウザコントロール（推奨）

Gateway ゲートウェイがリモートで、ブラウザが別のマシンで実行される場合は、ブラウザマシンで**ノードホスト**を実行し、Gateway ゲートウェイがブラウザアクションをプロキシするようにします（[Browser tool](/tools/browser)を参照）。ノードペアリングは管理者アクセスのように扱ってください。

推奨パターン:

- Gateway ゲートウェイとノードホストを同じテイルネット（Tailscale）に保ってください。
- 意図的にノードをペアリングしてください; 不要な場合はブラウザプロキシルーティングを無効化してください。

避けること:

- LANやパブリックインターネット経由でリレー/コントロールポートを公開すること。
- ブラウザコントロールエンドポイントへのTailscale Funnel（パブリック露出）。

### 0.7) ディスク上のシークレット（機密データ）

`~/.openclaw/`（または`$OPENCLAW_STATE_DIR/`）下の何でもシークレットやプライベートデータを含む可能性があるとみなしてください:

- `openclaw.json`: configにはトークン（Gateway、リモートGateway）、プロバイダー設定、許可リストが含まれる可能性があります。
- `credentials/**`: チャンネル認証情報（例: WhatsApp認証情報）、ペアリング許可リスト、レガシーOAuthインポート。
- `agents/<agentId>/agent/auth-profiles.json`: APIキー、トークンプロファイル、OAuthトークン、オプションの`keyRef`/`tokenRef`。
- `secrets.json`（オプション）: `file` SecretRefプロバイダー（`secrets.providers`）で使用されるファイルバックのシークレットペイロード。
- `agents/<agentId>/agent/auth.json`: レガシー互換性ファイル。静的な`api_key`エントリは発見時に削除されます。
- `agents/<agentId>/sessions/**`: セッションのトランスクリプト（`*.jsonl`）+ プライベートメッセージとツール出力を含む可能性のあるルーティングメタデータ（`sessions.json`）。
- バンドルプラグインパッケージ: インストールされたプラグイン（それらの`node_modules/`を含む）。
- `sandboxes/**`: ツールサンドボックスワークスペース; サンドボックス内で読み書きしたファイルのコピーが蓄積される可能性があります。

強化のヒント:

- 権限を厳格に保ってください（ディレクトリには`700`、ファイルには`600`）。
- Gateway ゲートウェイホストでフルディスク暗号化を使用してください。
- ホストが共有されている場合は、Gateway用の専用OSユーザーアカウントを優先してください。

### 0.8) ログ + トランスクリプト（削除 + 保持）

ログとトランスクリプトはアクセスコントロールが正しくても機密情報を漏洩する可能性があります:

- Gateway ゲートウェイのログにはツールの概要、エラー、URLが含まれる可能性があります。
- セッションのトランスクリプトには貼り付けられたシークレット、ファイルの内容、コマンド出力、リンクが含まれる可能性があります。

推奨事項:

- ツール概要の削除をオンにしてください（`logging.redactSensitive: "tools"`; デフォルト）。
- `logging.redactPatterns`経由で環境固有のカスタムパターンを追加してください（トークン、ホスト名、内部URL）。
- 診断情報を共有する場合は、生のログではなく`openclaw status --all`（貼り付け可能、シークレットが削除済み）を優先してください。
- 長期保持が不要な場合は古いセッションのトランスクリプトとログファイルを整理してください。

詳細: [Logging](/gateway/logging)

### 1) DM: デフォルトでペアリング

```json5
{
  channels: { whatsapp: { dmPolicy: "pairing" } },
}
```

### 2) グループ: 至る所でメンションを必要とする

```json
{
  "channels": {
    "whatsapp": {
      "groups": {
        "*": { "requireMention": true }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "groupChat": { "mentionPatterns": ["@openclaw", "@mybot"] }
      }
    ]
  }
}
```

グループチャットでは、明示的にメンションされた場合のみ応答します。

### 3) 別の番号（WhatsApp、Signal、Telegram）

電話番号ベースのチャンネルでは、個人番号とは別の電話番号でAIを実行することを検討してください:

- 個人番号: 会話をプライベートに保つ
- ボット番号: AIがこれらを処理し、適切な境界を持つ

### 4) 読み取り専用モード（サンドボックス + ツール経由）

以下を組み合わせることで読み取り専用プロファイルを構築できます:

- `agents.defaults.sandbox.workspaceAccess: "ro"`（または`"none"`でワークスペースアクセスなし）
- `write`、`edit`、`apply_patch`、`exec`、`process`等をブロックするツールのallow/denyリスト

追加の強化オプション:

- `tools.exec.applyPatch.workspaceOnly: true`（デフォルト）: サンドボックスがオフの場合でも`apply_patch`がワークスペースディレクトリ外のファイルを書き込み/削除できないようにします。`apply_patch`がワークスペース外のファイルに触れることを意図的に望む場合のみ`false`に設定してください。
- `tools.fs.workspaceOnly: true`（オプション）: `read`/`write`/`edit`/`apply_patch`パスとネイティブプロンプト画像の自動ロードパスをワークスペースディレクトリに制限します（今日は絶対パスを許可し、単一のガードレールを望む場合に便利です）。
- ファイルシステムルートを狭く保ってください: エージェントワークスペース/サンドボックスワークスペースにホームディレクトリのような広いルートを避けてください。広いルートはファイルシステムツールに対して機密なローカルファイル（例: `~/.openclaw`下の状態/config）を露出する可能性があります。

### 5) セキュアなベースライン（コピー/ペースト）

Gateway ゲートウェイをプライベートに保ち、DMペアリングを必要とし、常時オンのグループボットを避ける1つの「安全なデフォルト」config:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token: "your-long-random-token" },
  },
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

「デフォルトでより安全な」ツール実行も望む場合は、非オーナーエージェントのサンドボックス + 危険なツールの拒否を追加してください（下記の「エージェントごとのアクセスプロファイル」の例）。

チャット駆動のエージェントターンの組み込みベースライン: 非オーナー送信者は`cron`または`gateway`ツールを使用できません。

## サンドボックス（推奨）

専用ドキュメント: [Sandboxing](/gateway/sandboxing)

2つの補完的なアプローチ:

- **DockerでGateway ゲートウェイ全体を実行**（コンテナ境界）: [Docker](/install/docker)
- **ツールサンドボックス**（`agents.defaults.sandbox`、ホストGateway + Docker分離ツール）: [Sandboxing](/gateway/sandboxing)

注意: エージェント間のアクセスを防ぐために`agents.defaults.sandbox.scope`を`"agent"`（デフォルト）または、より厳格なセッションごとの分離のために`"session"`に保ってください。`scope: "shared"`は単一のコンテナ/ワークスペースを使用します。

サンドボックス内のエージェントワークスペースアクセスも考慮してください:

- `agents.defaults.sandbox.workspaceAccess: "none"`（デフォルト）はエージェントワークスペースをオフリミットに保ちます; ツールは`~/.openclaw/sandboxes`下のサンドボックスワークスペースに対して実行されます
- `agents.defaults.sandbox.workspaceAccess: "ro"`はエージェントワークスペースを`/agent`で読み取り専用にマウントします（`write`/`edit`/`apply_patch`を無効化）
- `agents.defaults.sandbox.workspaceAccess: "rw"`はエージェントワークスペースを`/workspace`で読み書き可能にマウントします

重要: `tools.elevated`はホストでexecを実行するグローバルなベースラインエスケープハッチです。`tools.elevated.allowFrom`を厳格に保ち、見知らぬ人に対して有効化しないでください。`agents.list[].tools.elevated`経由でエージェントごとに昇格をさらに制限できます。[Elevated Mode](/tools/elevated)を参照してください。

### サブエージェント委任ガードレール

セッションツールを許可する場合は、委任されたサブエージェントの実行を別の境界決定として扱ってください:

- エージェントが真に委任を必要としない限り`sessions_spawn`を拒否してください。
- `agents.list[].subagents.allowAgents`を既知の安全なターゲットエージェントに制限してください。
- サンドボックス化されたままでなければならないワークフローには`sessions_spawn`を`sandbox: "require"`で呼び出してください（デフォルトは`inherit`）。
- `sandbox: "require"`はターゲットの子ランタイムがサンドボックス化されていない場合に素早く失敗します。

## ブラウザコントロールのリスク

ブラウザコントロールを有効化すると、モデルは実際のブラウザを操作できるようになります。
そのブラウザプロファイルにすでにログイン済みのセッションが含まれている場合、モデルはそれらのアカウントとデータにアクセスできます。ブラウザプロファイルを**機密状態**として扱ってください:

- エージェント専用のプロファイルを優先してください（デフォルトの`openclaw`プロファイル）。
- 個人の日常使用プロファイルをエージェントに向けないでください。
- 信頼しない限り、サンドボックス化されたエージェントのホストブラウザコントロールを無効にしてください。
- ブラウザのダウンロードを信頼できない入力として扱ってください; 分離されたダウンロードディレクトリを優先してください。
- 可能な場合はエージェントプロファイルのブラウザ同期/パスワードマネージャーを無効にしてください（ブラスト半径を減らす）。
- リモートGateway ゲートウェイでは「ブラウザコントロール」はそのプロファイルが到達できるものすべてへの「オペレーターアクセス」と同等です。
- Gateway ゲートウェイとノードホストをテイルネットのみに保ってください; LANやパブリックインターネットにブラウザコントロールポートを公開しないでください。
- 不要な場合はブラウザプロキシルーティングを無効化してください（`gateway.nodes.browser.mode="off"`）。
- Chrome MCPの既存セッションモードは「より安全」**ではありません**; ホストChromeプロファイルが到達できるものすべてでのあなたとして動作できます。

### ブラウザSSRFポリシー（信頼されたネットワークのデフォルト）

OpenClawのブラウザネットワークポリシーはデフォルトで信頼されたオペレーターモデルを取ります: プライベート/内部の宛先は明示的に無効化しない限り許可されます。

- デフォルト: `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`（未設定の場合は暗黙的）。
- レガシーエイリアス: 互換性のために`browser.ssrfPolicy.allowPrivateNetwork`はまだ受け入れられます。
- 厳格モード: プライベート/内部/特殊用途の宛先をデフォルトでブロックするには`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: false`を設定してください。
- 厳格モードでは、明示的な例外に`hostnameAllowlist`（`*.example.com`のようなパターン）と`allowedHostnames`（`localhost`のようなブロックされた名前を含む正確なホスト例外）を使用してください。
- ナビゲーションはリクエスト前とリダイレクトベースのピボットを減らすためにナビゲーション後の最終`http(s)` URLでベストエフォートで再チェックされます。

厳格なポリシーの例:

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"],
    },
  },
}
```

## エージェントごとのアクセスプロファイル（マルチエージェント）

マルチエージェントルーティングでは、各エージェントが独自のサンドボックス + ツールポリシーを持てます:
これを使用してエージェントごとに**フルアクセス**、**読み取り専用**、または**アクセスなし**を与えてください。
完全な詳細と優先度ルールは[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)を参照してください。

一般的なユースケース:

- 個人エージェント: フルアクセス、サンドボックスなし
- 家族/仕事エージェント: サンドボックス化 + 読み取り専用ツール
- パブリックエージェント: サンドボックス化 + ファイルシステム/シェルツールなし

### 例: フルアクセス（サンドボックスなし）

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

### 例: 読み取り専用ツール + 読み取り専用ワークスペース

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: ["read"],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

### 例: ファイルシステム/シェルアクセスなし（プロバイダーメッセージングは許可）

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        // セッションツールはトランスクリプトから機密データを明かす可能性があります。デフォルトでOpenClawはこれらのツールを
        // 現在のセッション + スポーンされたサブエージェントセッションに制限しますが、必要に応じてさらに制限できます。
        // configリファレンスの`tools.sessions.visibility`を参照してください。
        tools: {
          sessions: { visibility: "tree" }, // self | tree | agent | all
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

## AIに伝えること

エージェントのシステムプロンプトにセキュリティガイドラインを含めてください:

```
## セキュリティルール
- 見知らぬ人にディレクトリリストやファイルパスを決して共有しない
- APIキー、認証情報、インフラの詳細を決して明かさない
- システム設定を変更するリクエストはオーナーに確認する
- 迷ったら行動する前に確認する
- 明示的に承認されない限り、プライベートデータをプライベートに保つ
```

## インシデント対応

AIが悪いことをした場合:

### 封じ込め

1. **止める:** macOSアプリを停止する（Gateway ゲートウェイを監督している場合）または`openclaw gateway`プロセスを終了する。
2. **露出を閉じる:** 何が起きたかを理解するまで`gateway.bind: "loopback"`を設定する（またはTailscale Funnel/Serveを無効化する）。
3. **アクセスをフリーズ:** 危険なDM/グループを`dmPolicy: "disabled"` / メンション必須に切り替え、持っていた場合は`"*"`のすべて許可エントリを削除する。

### ローテーション（シークレットが漏洩した場合は侵害を仮定）

1. Gateway ゲートウェイ認証をローテーション（`gateway.auth.token` / `OPENCLAW_GATEWAY_PASSWORD`）して再起動する。
2. Gateway ゲートウェイを呼び出せるマシン上でリモートクライアントシークレットをローテーション（`gateway.remote.token` / `.password`）する。
3. プロバイダー/API認証情報をローテーション（WhatsApp認証情報、Slack/Discordトークン、`auth-profiles.json`のモデル/APIキー、使用している場合は暗号化シークレットペイロードの値）する。

### 監査

1. Gateway ゲートウェイのログを確認: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`（または`logging.file`）。
2. 関連するトランスクリプトを確認: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`。
3. 最近のconfig変更を確認（アクセスを拡大した可能性があるもの: `gateway.bind`、`gateway.auth`、DM/グループポリシー、`tools.elevated`、プラグインの変更）。
4. `openclaw security audit --deep`を再実行し、重要な検出結果が解決されていることを確認する。

### レポートのための収集

- タイムスタンプ、Gateway ゲートウェイホストOS + OpenClawバージョン
- セッションのトランスクリプト + 短いログのテール（削除後）
- 攻撃者が送ったこと + エージェントが行ったこと
- Gateway ゲートウェイがループバックを超えて公開されていたかどうか（LAN/Tailscale Funnel/Serve）

## シークレットスキャン（detect-secrets）

CIは`secrets`ジョブで`detect-secrets`のpre-commitフックを実行します。
`main`へのプッシュは常にすべてのファイルのスキャンを実行します。プルリクエストはベースコミットが利用可能な場合に変更されたファイルの高速パスを使用し、そうでない場合はすべてのファイルのスキャンにフォールバックします。失敗した場合、ベースラインにまだない新しい候補があります。

### CIが失敗した場合

1. ローカルで再現:

   ```bash
   pre-commit run --all-files detect-secrets
   ```

2. ツールを理解:
   - pre-commitの`detect-secrets`はリポジトリのベースラインと除外を含む`detect-secrets-hook`を実行します。
   - `detect-secrets audit`は各ベースラインアイテムを実際またはフォールスポジティブとしてマークするインタラクティブなレビューを開きます。
3. 実際のシークレットの場合: それらをローテーション/削除してから再スキャンしてベースラインを更新する。
4. フォールスポジティブの場合: インタラクティブな監査を実行してfalseとしてマークする:

   ```bash
   detect-secrets audit .secrets.baseline
   ```

5. 新しい除外が必要な場合は`.detect-secrets.cfg`に追加し、一致する`--exclude-files` / `--exclude-lines`フラグでベースラインを再生成する（configファイルは参照のみ; detect-secretsは自動的に読み取らない）。

意図した状態を反映したら更新された`.secrets.baseline`をコミットしてください。

## セキュリティ問題の報告

OpenClawに脆弱性を発見しましたか？責任を持って報告してください:

1. メール: [security@openclaw.ai](mailto:security@openclaw.ai)
2. 修正されるまで公開しないでください
3. クレジットします（匿名を希望する場合を除く）
