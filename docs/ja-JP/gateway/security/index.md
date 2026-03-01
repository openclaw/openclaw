---
summary: "シェルアクセスを持つAI Gatewayの運用に関するセキュリティ考慮事項と脅威モデル"
read_when:
  - Adding features that widen access or automation
title: "セキュリティ"
---

# セキュリティ

> [!WARNING]
> **パーソナルアシスタント信頼モデル：** このガイダンスは、Gatewayごとに1つの信頼されたオペレーター境界を前提としています（シングルユーザー/パーソナルアシスタントモデル）。
> OpenClawは、複数の敵対的ユーザーが1つのエージェント/Gatewayを共有する、敵対的マルチテナントセキュリティ境界**ではありません**。
> 混合信頼または敵対的ユーザー運用が必要な場合は、信頼境界を分割してください（別々のGateway + 認証情報、理想的には別々のOSユーザー/ホスト）。

## スコープファースト：パーソナルアシスタントセキュリティモデル

OpenClawのセキュリティガイダンスは、**パーソナルアシスタント**デプロイメントを前提としています：1つの信頼されたオペレーター境界、潜在的に多数のエージェント。

- サポートされるセキュリティ態勢：Gatewayごとに1ユーザー/信頼境界（境界ごとに1 OSユーザー/ホスト/VPSを推奨）。
- サポートされるセキュリティ境界ではないもの：相互に信頼されていないまたは敵対的なユーザーが使用する1つの共有Gateway/エージェント。
- 敵対的ユーザー分離が必要な場合は、信頼境界ごとに分割してください（別々のGateway + 認証情報、理想的には別々のOSユーザー/ホスト）。
- 複数の信頼されていないユーザーが1つのツール対応エージェントにメッセージを送信できる場合、そのエージェントに対する同じ委任されたツール権限を共有していると見なしてください。

このページでは、**そのモデル内での**堅牢化について説明します。1つの共有Gatewayでの敵対的マルチテナント分離を主張するものではありません。

## クイックチェック：`openclaw security audit`

参照：[形式検証（セキュリティモデル）](/security/formal-verification/)

定期的に（特に設定変更やネットワークサーフェスの公開後に）実行してください：

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

一般的な落とし穴をフラグします（Gateway認証の露出、ブラウザコントロールの露出、elevated許可リスト、ファイルシステム権限）。

OpenClawは製品であると同時に実験でもあります：フロンティアモデルの動作を実際のメッセージングサーフェスと実際のツールに接続しています。**「完全にセキュアな」セットアップは存在しません。** 目標は以下について意図的であることです：

- 誰があなたのボットに話しかけられるか
- ボットがどこで行動を許可されるか
- ボットが何に触れられるか

動作する最小限のアクセスから始めて、自信がつくにつれて拡大してください。

## デプロイメントの前提（重要）

OpenClawはホストと設定境界が信頼されていることを前提としています：

- Gatewayホストの状態/設定（`~/.openclaw`、`openclaw.json`を含む）を変更できる人がいる場合、その人を信頼されたオペレーターとして扱ってください。
- 相互に信頼されていない/敵対的な複数のオペレーターのために1つのGatewayを実行することは**推奨されるセットアップではありません**。
- 混合信頼チームの場合は、別々のGatewayで信頼境界を分割してください（または最低限、別々のOSユーザー/ホスト）。
- OpenClawは1つのマシン上で複数のGatewayインスタンスを実行できますが、推奨される運用はクリーンな信頼境界分離を支持します。
- 推奨デフォルト：マシン/ホスト（またはVPS）ごとに1ユーザー、そのユーザーに1つのGateway、そのGateway内に1つ以上のエージェント。
- 複数のユーザーがOpenClawを必要とする場合は、ユーザーごとに1つのVPS/ホストを使用してください。

### 実用的な帰結（オペレーター信頼境界）

1つのGatewayインスタンス内では、認証されたオペレーターアクセスは信頼されたコントロールプレーンロールであり、ユーザーごとのテナントロールではありません。

- 読み取り/コントロールプレーンアクセスを持つオペレーターは、設計上、Gatewayセッションのメタデータ/履歴を検査できます。
- セッション識別子（`sessionKey`、セッションID、ラベル）はルーティングセレクターであり、認可トークンではありません。
- 例：`sessions.list`、`sessions.preview`、`chat.history`などのメソッドに対するオペレーターごとの分離を期待することは、このモデルの範囲外です。
- 敵対的ユーザー分離が必要な場合は、信頼境界ごとに別々のGatewayを実行してください。
- 1つのマシン上での複数Gatewayは技術的に可能ですが、マルチユーザー分離の推奨ベースラインではありません。

## パーソナルアシスタントモデル（マルチテナントバスではない）

OpenClawはパーソナルアシスタントセキュリティモデルとして設計されています：1つの信頼されたオペレーター境界、潜在的に多数のエージェント。

- 複数の人が1つのツール対応エージェントにメッセージを送信できる場合、それぞれが同じ権限セットを操作できます。
- ユーザーごとのセッション/メモリ分離はプライバシーに役立ちますが、共有エージェントをユーザーごとのホスト認可に変換するものではありません。
- ユーザーが互いに敵対的な場合は、信頼境界ごとに別々のGateway（または別々のOSユーザー/ホスト）を実行してください。

### 共有Slackワークスペース：実際のリスク

「Slackの全員がボットにメッセージを送信できる」場合、コアリスクは委任されたツール権限です：

- 許可された送信者は誰でも、エージェントのポリシー内でツール呼び出し（`exec`、ブラウザ、ネットワーク/ファイルツール）を誘発できます。
- 1人の送信者からのプロンプト/コンテンツインジェクションが、共有状態、デバイス、または出力に影響するアクションを引き起こす可能性があります。
- 1つの共有エージェントが機密の認証情報/ファイルを持っている場合、許可された送信者はツール使用を通じて窃取を推進できる可能性があります。

チームワークフローには最小限のツールを持つ別々のエージェント/Gatewayを使用してください。個人データエージェントはプライベートに保ってください。

### 会社共有エージェント：許容されるパターン

そのエージェントを使用する全員が同じ信頼境界内にあり（例：1つの企業チーム）、エージェントが厳密にビジネススコープである場合、これは許容されます。

- 専用マシン/VM/コンテナで実行してください。
- そのランタイム用に専用のOSユーザー + 専用のブラウザ/プロファイル/アカウントを使用してください。
- そのランタイムを個人のApple/Googleアカウントや個人のパスワードマネージャー/ブラウザプロファイルにサインインしないでください。

個人アイデンティティと会社アイデンティティを同じランタイムで混在させると、分離が崩壊し、個人データ露出リスクが増加します。

## Gatewayとノードの信頼コンセプト

Gatewayとノードを異なるロールを持つ1つのオペレーター信頼ドメインとして扱います：

- **Gateway**はコントロールプレーンとポリシーサーフェスです（`gateway.auth`、ツールポリシー、ルーティング）。
- **ノード**はそのGatewayにペアリングされたリモート実行サーフェスです（コマンド、デバイスアクション、ホストローカルケイパビリティ）。
- Gatewayに認証された呼び出し元はGatewayスコープで信頼されます。ペアリング後、ノードアクションはそのノード上の信頼されたオペレーターアクションです。
- `sessionKey`はルーティング/コンテキスト選択であり、ユーザーごとの認証ではありません。
- Exec承認（許可リスト + ask）はオペレーターの意図のためのガードレールであり、敵対的マルチテナント分離ではありません。

敵対的ユーザー分離が必要な場合は、OSユーザー/ホストで信頼境界を分割し、別々のGatewayを実行してください。

## 信頼境界マトリックス

リスクのトリアージ時にクイックモデルとして使用してください：

| 境界またはコントロール                         | 意味                                     | よくある誤解                                                                |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `gateway.auth`（トークン/パスワード/デバイス認証） | Gateway APIへの呼び出し元を認証             | 「セキュアにするにはすべてのフレームにメッセージごとの署名が必要」                    |
| `sessionKey`                                | コンテキスト/セッション選択のためのルーティングキー         | 「セッションキーはユーザー認証境界である」                                         |
| プロンプト/コンテンツガードレール                   | モデル悪用リスクを軽減                           | 「プロンプトインジェクションだけで認証バイパスが証明される」                                   |
| `canvas.eval` / ブラウザevaluate            | 有効時の意図的なオペレーターケイパビリティ      | 「JS eval primitiveはこの信頼モデルでは自動的に脆弱性」           |
| ローカルTUI `!` シェル                         | 明示的なオペレータートリガーのローカル実行       | 「ローカルシェルの便利なコマンドはリモートインジェクションである」                         |
| ノードペアリングとノードコマンド              | ペアリングされたデバイス上のオペレーターレベルのリモート実行 | 「リモートデバイス制御はデフォルトで信頼されていないユーザーアクセスとして扱うべき」 |

## 設計上の脆弱性ではないもの

これらのパターンは一般的に報告されますが、実際の境界バイパスが示されない限り、通常はアクション不要として閉じられます：

- ポリシー/認証/サンドボックスバイパスのないプロンプトインジェクションのみのチェーン。
- 1つの共有ホスト/設定での敵対的マルチテナント運用を前提とする主張。
- 共有Gatewayセットアップで通常のオペレーター読み取りパスアクセス（例：`sessions.list`/`sessions.preview`/`chat.history`）をIDORとして分類する主張。
- ローカルホスト限定のデプロイメントの発見（例：ループバック限定GatewayでのHSTS）。
- このリポジトリに存在しないインバウンドパスのDiscordインバウンドWebhookシグネチャの発見。
- `sessionKey`を認証トークンとして扱う「ユーザーごとの認可の欠如」の発見。

## 研究者プリフライトチェックリスト

GHSAを開く前に、以下のすべてを確認してください：

1. 再現が最新の`main`または最新リリースで動作する。
2. レポートに正確なコードパス（`file`、関数、行範囲）とテスト済みバージョン/コミットが含まれている。
3. 影響が文書化された信頼境界を越えている（プロンプトインジェクションだけではない）。
4. 主張が[スコープ外](https://github.com/openclaw/openclaw/blob/main/SECURITY.md#out-of-scope)に記載されていない。
5. 既存のアドバイザリーで重複がチェックされている（該当する場合はカノニカルGHSAを再利用）。
6. デプロイメントの前提が明示的である（ループバック/ローカル vs 露出、信頼済み vs 信頼されていないオペレーター）。

## 60秒で堅牢化されたベースライン

まずこのベースラインを使用し、信頼されたエージェントごとにツールを選択的に再有効化してください：

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

これによりGatewayをローカル限定に保ち、DMを分離し、コントロールプレーン/ランタイムツールをデフォルトで無効化します。

## 共有受信箱のクイックルール

複数の人がボットにDMを送信できる場合：

- `session.dmScope: "per-channel-peer"`を設定してください（マルチアカウントチャンネルの場合は`"per-account-channel-peer"`）。
- `dmPolicy: "pairing"`または厳格な許可リストを維持してください。
- 共有DMと広範なツールアクセスを組み合わせないでください。
- これは協調的/共有受信箱を堅牢化しますが、ユーザーがホスト/設定の書き込みアクセスを共有する場合の敵対的共同テナント分離として設計されているわけではありません。

### 監査がチェックする内容（概要）

- **インバウンドアクセス**（DMポリシー、グループポリシー、許可リスト）：見知らぬ人がボットをトリガーできるか？
- **ツールの影響範囲**（elevatedツール + オープンルーム）：プロンプトインジェクションがシェル/ファイル/ネットワークアクションに変換される可能性があるか？
- **ネットワーク露出**（Gatewayのバインド/認証、Tailscale Serve/Funnel、弱い/短い認証トークン）。
- **ブラウザコントロールの露出**（リモートノード、リレーポート、リモートCDPエンドポイント）。
- **ローカルディスク衛生**（権限、シンボリックリンク、設定インクルード、「同期フォルダ」パス）。
- **プラグイン**（明示的な許可リストなしで拡張機能が存在する）。
- **ポリシーのずれ/設定ミス**（サンドボックスモードがオフなのにサンドボックスDocker設定が構成されている、マッチングが正確なコマンド名のみ（例：`system.run`）でシェルテキストを検査しないため`gateway.nodes.denyCommands`パターンが無効、危険な`gateway.nodes.allowCommands`エントリ、エージェントごとのプロファイルによりグローバル`tools.profile="minimal"`がオーバーライドされる、寛容なツールポリシーの下で拡張プラグインツールが到達可能）。
- **ランタイム期待のずれ**（例：サンドボックスモードがオフなのに`tools.exec.host="sandbox"`が設定されており、Gatewayホスト上で直接実行される）。
- **モデル衛生**（設定されたモデルがレガシーに見える場合に警告、ハードブロックではない）。

`--deep`を指定して実行すると、OpenClawはベストエフォートのライブGatewayプローブも試行します。

## 認証情報ストレージマップ

アクセスの監査やバックアップ対象の決定時に使用してください：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegramボットトークン**：設定/環境変数または`channels.telegram.tokenFile`
- **Discordボットトークン**：設定/環境変数（トークンファイルは未サポート）
- **Slackトークン**：設定/環境変数（`channels.slack.*`）
- **ペアリング許可リスト**：
  - `~/.openclaw/credentials/<channel>-allowFrom.json`（デフォルトアカウント）
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json`（デフォルト以外のアカウント）
- **モデル認証プロファイル**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **ファイルベースシークレットペイロード（オプション）**：`~/.openclaw/secrets.json`
- **レガシーOAuthインポート**：`~/.openclaw/credentials/oauth.json`

## セキュリティ監査チェックリスト

監査が検出結果を出力した場合、これを優先順位として扱ってください：

1. **「オープン」+ ツール有効の組み合わせ**：まずDM/グループをロックダウン（ペアリング/許可リスト）し、次にツールポリシー/サンドボックスを厳格化してください。
2. **パブリックネットワーク露出**（LANバインド、Funnel、認証なし）：即座に修正してください。
3. **ブラウザコントロールのリモート露出**：オペレーターアクセスと同様に扱ってください（Tailnet限定、意図的にノードをペアリング、パブリック露出を避ける）。
4. **権限**：状態/設定/認証情報/認証がグループ/ワールドリーダブルでないことを確認してください。
5. **プラグイン/拡張機能**：明示的に信頼するものだけをロードしてください。
6. **モデル選択**：ツールを持つボットには、最新の命令堅牢化されたモデルを推奨します。

## セキュリティ監査用語集

実際のデプロイメントで最もよく見られる高シグナルの`checkId`値（網羅的ではありません）：

| `checkId`                                          | 重大度      | 重要な理由                                                                     | 主な修正キー/パス                                                                              | 自動修正 |
| -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| `fs.state_dir.perms_world_writable`                | critical      | 他のユーザー/プロセスがOpenClawの全状態を変更できる                               | `~/.openclaw`のファイルシステム権限                                                                 | あり      |
| `fs.config.perms_writable`                         | critical      | 他者が認証/ツールポリシー/設定を変更できる                                          | `~/.openclaw/openclaw.json`のファイルシステム権限                                                   | あり      |
| `fs.config.perms_world_readable`                   | critical      | 設定がトークン/設定を露出する可能性がある                                          | 設定ファイルのファイルシステム権限                                                                   | あり      |
| `gateway.bind_no_auth`                             | critical      | 共有シークレットなしのリモートバインド                                              | `gateway.bind`、`gateway.auth.*`                                                                  | なし       |
| `gateway.loopback_no_auth`                         | critical      | リバースプロキシされたループバックが未認証になる可能性がある                                | `gateway.auth.*`、プロキシ設定                                                                     | なし       |
| `gateway.http.no_auth`                             | warn/critical | `auth.mode="none"`でGateway HTTP APIが到達可能                                | `gateway.auth.mode`、`gateway.http.endpoints.*`                                                   | なし       |
| `gateway.tools_invoke_http.dangerous_allow`        | warn/critical | HTTP API経由で危険なツールを再有効化                                           | `gateway.tools.allow`                                                                             | なし       |
| `gateway.nodes.allow_commands_dangerous`           | warn/critical | 高影響なノードコマンドを有効化（カメラ/画面/連絡先/カレンダー/SMS）            | `gateway.nodes.allowCommands`                                                                     | なし       |
| `gateway.tailscale_funnel`                         | critical      | パブリックインターネット露出                                                           | `gateway.tailscale.mode`                                                                          | なし       |
| `gateway.control_ui.allowed_origins_required`      | critical      | 明示的なブラウザオリジン許可リストなしの非ループバックControl UI                  | `gateway.controlUi.allowedOrigins`                                                                | なし       |
| `gateway.control_ui.host_header_origin_fallback`   | warn/critical | Hostヘッダーオリジンフォールバックを有効化（DNSリバインディング堅牢化のダウングレード）            | `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`                                      | なし       |
| `gateway.control_ui.insecure_auth`                 | warn          | セキュアでない認証の互換性トグルが有効                                         | `gateway.controlUi.allowInsecureAuth`                                                             | なし       |
| `gateway.control_ui.device_auth_disabled`          | critical      | デバイスアイデンティティチェックを無効化                                                     | `gateway.controlUi.dangerouslyDisableDeviceAuth`                                                  | なし       |
| `gateway.real_ip_fallback_enabled`                 | warn/critical | `X-Real-IP`フォールバックの信頼がプロキシ設定ミスによるソースIPスプーフィングを可能にする    | `gateway.allowRealIpFallback`、`gateway.trustedProxies`                                           | なし       |
| `discovery.mdns_full_mode`                         | warn/critical | mDNSフルモードがローカルネットワーク上で`cliPath`/`sshPort`メタデータをアドバタイズ            | `discovery.mdns.mode`、`gateway.bind`                                                             | なし       |
| `config.insecure_or_dangerous_flags`               | warn          | セキュアでない/危険なデバッグフラグが有効                                         | 複数のキー（検出結果の詳細を参照）                                                                | なし       |
| `hooks.token_too_short`                            | warn          | Hookイングレスへのブルートフォースが容易                                                 | `hooks.token`                                                                                     | なし       |
| `hooks.request_session_key_enabled`                | warn/critical | 外部呼び出し元がsessionKeyを選択可能                                              | `hooks.allowRequestSessionKey`                                                                    | なし       |
| `hooks.request_session_key_prefixes_missing`       | warn/critical | 外部セッションキーの形状に制限がない                                            | `hooks.allowedSessionKeyPrefixes`                                                                 | なし       |
| `logging.redact_off`                               | warn          | 機密値がログ/ステータスに漏洩                                               | `logging.redactSensitive`                                                                         | あり      |
| `sandbox.docker_config_mode_off`                   | warn          | サンドボックスDocker設定が存在するが非アクティブ                                         | `agents.*.sandbox.mode`                                                                           | なし       |
| `sandbox.dangerous_network_mode`                   | critical      | サンドボックスDockerネットワークが`host`または`container:*`ネームスペース結合モードを使用            | `agents.*.sandbox.docker.network`                                                                 | なし       |
| `tools.exec.host_sandbox_no_sandbox_defaults`      | warn          | サンドボックスがオフの場合`exec host=sandbox`がホストexecに解決される                      | `tools.exec.host`、`agents.defaults.sandbox.mode`                                                 | なし       |
| `tools.exec.host_sandbox_no_sandbox_agents`        | warn          | サンドボックスがオフの場合エージェントごとの`exec host=sandbox`がホストexecに解決される            | `agents.list[].tools.exec.host`、`agents.list[].sandbox.mode`                                     | なし       |
| `tools.exec.safe_bins_interpreter_unprofiled`      | warn          | 明示的なプロファイルなしの`safeBins`内のインタープリター/ランタイムバイナリがexecリスクを拡大 | `tools.exec.safeBins`、`tools.exec.safeBinProfiles`、`agents.list[].tools.exec.*`                 | なし       |
| `security.exposure.open_groups_with_elevated`      | critical      | オープングループ + elevatedツールが高影響なプロンプトインジェクションパスを作成             | `channels.*.groupPolicy`、`tools.elevated.*`                                                      | なし       |
| `security.exposure.open_groups_with_runtime_or_fs` | critical/warn | オープングループがサンドボックス/ワークスペースガードなしでコマンド/ファイルツールに到達可能          | `channels.*.groupPolicy`、`tools.profile/deny`、`tools.fs.workspaceOnly`、`agents.*.sandbox.mode` | なし       |
| `security.trust_model.multi_user_heuristic`        | warn          | Gateway信頼モデルがパーソナルアシスタントなのに設定がマルチユーザーに見える            | 信頼境界を分割、または共有ユーザー堅牢化（`sandbox.mode`、ツールdeny/ワークスペーススコーピング）    | なし       |
| `tools.profile_minimal_overridden`                 | warn          | エージェントオーバーライドがグローバルminimalプロファイルをバイパス                                      | `agents.list[].tools.profile`                                                                     | なし       |
| `plugins.tools_reachable_permissive_policy`        | warn          | 寛容なコンテキストで拡張ツールが到達可能                                   | `tools.profile` + ツールallow/deny                                                                | なし       |
| `models.small_params`                              | critical/info | 小さいモデル + 安全でないツールサーフェスがインジェクションリスクを増加                           | モデル選択 + サンドボックス/ツールポリシー                                                                | なし       |

## HTTP経由のControl UI

Control UIはデバイスアイデンティティを生成するために**セキュアコンテキスト**（HTTPSまたはlocalhost）が必要です。`gateway.controlUi.allowInsecureAuth`はセキュアコンテキスト、デバイスアイデンティティ、またはデバイスペアリングチェックをバイパス**しません**。HTTPS（Tailscale Serve）を推奨するか、UIを`127.0.0.1`で開いてください。

ブレイクグラスシナリオのみ、`gateway.controlUi.dangerouslyDisableDeviceAuth`はデバイスアイデンティティチェックを完全に無効化します。これは深刻なセキュリティダウングレードです。アクティブにデバッグしており、すぐに元に戻せる場合を除いてオフのままにしてください。

`openclaw security audit`はこの設定が有効な場合に警告します。

## セキュアでないまたは危険なフラグの概要

`openclaw security audit`は、既知のセキュアでない/危険なデバッグスイッチが有効な場合に`config.insecure_or_dangerous_flags`を含めます。そのチェックは現在以下を集約しています：

- `gateway.controlUi.allowInsecureAuth=true`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`
- `gateway.controlUi.dangerouslyDisableDeviceAuth=true`
- `hooks.gmail.allowUnsafeExternalContent=true`
- `hooks.mappings[<index>].allowUnsafeExternalContent=true`
- `tools.exec.applyPatch.workspaceOnly=false`

OpenClaw設定スキーマで定義されている完全な`dangerous*` / `dangerously*`設定キー：

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

## リバースプロキシ設定

Gatewayをリバースプロキシ（nginx、Caddy、Traefikなど）の背後で実行する場合、適切なクライアントIP検出のために`gateway.trustedProxies`を設定する必要があります。

Gatewayが`trustedProxies`に**含まれていない**アドレスからプロキシヘッダーを検出すると、接続をローカルクライアントとして扱い**ません**。Gateway認証が無効な場合、それらの接続は拒否されます。これにより、プロキシされた接続がlocalhostからのものに見え、自動的に信頼を受けるという認証バイパスを防止します。

```yaml
gateway:
  trustedProxies:
    - "127.0.0.1" # プロキシがlocalhost上で実行される場合
  # オプション。デフォルトfalse。
  # プロキシがX-Forwarded-Forを提供できない場合のみ有効化。
  allowRealIpFallback: false
  auth:
    mode: password
    password: ${OPENCLAW_GATEWAY_PASSWORD}
```

`trustedProxies`が設定されている場合、GatewayはクライアントIPの決定に`X-Forwarded-For`を使用します。`X-Real-IP`は`gateway.allowRealIpFallback: true`が明示的に設定されない限り、デフォルトでは無視されます。

良いリバースプロキシの動作（受信転送ヘッダーを上書き）：

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

悪いリバースプロキシの動作（信頼されていない転送ヘッダーを追加/保持）：

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

## HSTSとオリジンに関する注意事項

- OpenClaw Gatewayはローカル/ループバックファーストです。リバースプロキシでTLS終端を行う場合は、プロキシ側のHTTPSドメインでHSTSを設定してください。
- Gateway自体がHTTPSを終端する場合、`gateway.http.securityHeaders.strictTransportSecurity`を設定してOpenClawレスポンスからHSTSヘッダーを発行できます。
- 詳細なデプロイメントガイダンスは[Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts)にあります。
- 非ループバックのControl UIデプロイメントでは、`gateway.controlUi.allowedOrigins`がデフォルトで必要です。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`はHostヘッダーオリジンフォールバックモードを有効にします。危険なオペレーター選択のポリシーとして扱ってください。
- DNSリバインディングとプロキシホストヘッダーの動作をデプロイメント堅牢化の懸念として扱ってください。`trustedProxies`を厳密に保ち、Gatewayを直接パブリックインターネットに公開することを避けてください。

## ローカルセッションログはディスク上に存在する

OpenClawはセッショントランスクリプトを`~/.openclaw/agents/<agentId>/sessions/*.jsonl`配下のディスクに保存します。
これはセッションの継続性と（オプションで）セッションメモリインデキシングに必要ですが、
**ファイルシステムアクセスを持つ任意のプロセス/ユーザーがそれらのログを読み取れる**ことも意味します。ディスクアクセスを信頼
境界として扱い、`~/.openclaw`の権限をロックダウンしてください（以下の監査セクションを参照）。エージェント間で
より強力な分離が必要な場合は、別々のOSユーザーまたは別々のホストで実行してください。

## ノード実行（system.run）

macOSノードがペアリングされている場合、Gatewayはそのノード上で`system.run`を呼び出せます。これはMac上での**リモートコード実行**です：

- ノードペアリング（承認 + トークン）が必要です。
- Mac上で**設定 → Exec承認**（セキュリティ + ask + 許可リスト）で制御されます。
- リモート実行が不要な場合は、セキュリティを**deny**に設定し、そのMacのノードペアリングを削除してください。

## ダイナミックスキル（ウォッチャー / リモートノード）

OpenClawはセッション中にスキルリストをリフレッシュできます：

- **スキルウォッチャー**：`SKILL.md`の変更により、次のエージェントターンでスキルスナップショットが更新される可能性があります。
- **リモートノード**：macOSノードの接続により、macOS専用スキルが利用可能になる場合があります（バイナリプロービングに基づく）。

スキルフォルダを**信頼されたコード**として扱い、変更できる人を制限してください。

## 脅威モデル

あなたのAIアシスタントは以下が可能です：

- 任意のシェルコマンドの実行
- ファイルの読み書き
- ネットワークサービスへのアクセス
- 誰にでもメッセージを送信（WhatsAppアクセスを与えた場合）

あなたにメッセージを送信する人は以下を試みる可能性があります：

- AIを騙して悪いことをさせる
- データへのアクセスをソーシャルエンジニアリングで取得する
- インフラストラクチャの詳細を探る

## コアコンセプト：インテリジェンスの前にアクセス制御

ここでのほとんどの失敗は高度なエクスプロイトではありません。「誰かがボットにメッセージを送信し、ボットが言われた通りにした」というものです。

OpenClawのスタンス：

- **まずアイデンティティ：** 誰がボットと話せるかを決定してください（DMペアリング / 許可リスト / 明示的な「オープン」）。
- **次にスコープ：** ボットがどこで行動を許可されるかを決定してください（グループ許可リスト + メンションゲーティング、ツール、サンドボックス、デバイス権限）。
- **最後にモデル：** モデルは操作される可能性があると想定し、操作された場合の影響範囲が限定されるように設計してください。

## コマンド認可モデル

スラッシュコマンドとディレクティブは**認可された送信者**に対してのみ実行されます。認可は
チャンネル許可リスト/ペアリングと`commands.useAccessGroups`から導出されます（[設定](/gateway/configuration)
と[スラッシュコマンド](/tools/slash-commands)を参照）。チャンネル許可リストが空または`"*"`を含む場合、
そのチャンネルではコマンドは事実上オープンです。

`/exec`は認可されたオペレーター用のセッション限定の便利機能です。設定を書き込んだり
他のセッションを変更したり**しません**。

## コントロールプレーンツールのリスク

2つの組み込みツールが永続的なコントロールプレーンの変更を行えます：

- `gateway`は`config.apply`、`config.patch`、`update.run`を呼び出せます。
- `cron`は元のチャット/タスクが終了した後も実行され続けるスケジュールジョブを作成できます。

信頼されていないコンテンツを扱うエージェント/サーフェスでは、デフォルトでこれらを拒否してください：

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send"],
  },
}
```

`commands.restart=false`はリスタートアクションのみをブロックします。`gateway`設定/更新アクションは無効化しません。

## プラグイン/拡張機能

プラグインはGatewayと**同じプロセス内**で実行されます。信頼されたコードとして扱ってください：

- 信頼するソースからのプラグインのみをインストールしてください。
- 明示的な`plugins.allow`許可リストを推奨します。
- 有効化する前にプラグインの設定をレビューしてください。
- プラグイン変更後はGatewayを再起動してください。
- npm（`openclaw plugins install <npm-spec>`）からプラグインをインストールする場合は、信頼されていないコードの実行と同様に扱ってください：
  - インストールパスは`~/.openclaw/extensions/<pluginId>/`（または`$OPENCLAW_STATE_DIR/extensions/<pluginId>/`）です。
  - OpenClawは`npm pack`を使用し、そのディレクトリで`npm install --omit=dev`を実行します（npmライフサイクルスクリプトはインストール中にコードを実行できます）。
  - ピン留めされた正確なバージョン（`@scope/pkg@1.2.3`）を推奨し、有効化する前にディスク上の展開されたコードを検査してください。

詳細：[プラグイン](/tools/plugin)

## DMアクセスモデル（pairing / allowlist / open / disabled）

現在のすべてのDM対応チャンネルは、インバウンドDMをメッセージ処理の**前に**ゲートするDMポリシー（`dmPolicy`または`*.dm.policy`）をサポートしています：

- `pairing`（デフォルト）：不明な送信者は短いペアリングコードを受け取り、承認されるまでボットはメッセージを無視します。コードは1時間後に期限切れになります。新しいリクエストが作成されるまで、繰り返しのDMではコードは再送信されません。保留中のリクエストはチャンネルごとにデフォルトで**3件**に制限されています。
- `allowlist`：不明な送信者はブロックされます（ペアリングハンドシェイクなし）。
- `open`：誰でもDMを許可（パブリック）。チャンネル許可リストに`"*"`を含める必要があります（明示的なオプトイン）。
- `disabled`：インバウンドDMを完全に無視します。

CLI経由での承認：

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

詳細 + ディスク上のファイル：[ペアリング](/channels/pairing)

## DMセッション分離（マルチユーザーモード）

デフォルトでは、OpenClawは**すべてのDMをメインセッションにルーティング**するため、デバイスやチャンネル間でアシスタントの継続性が保たれます。**複数の人**がボットにDMを送信できる場合（オープンDMまたは複数人の許可リスト）、DMセッションの分離を検討してください：

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

これにより、グループチャットを分離したまま、ユーザー間のコンテキスト漏洩を防止します。

これはメッセージングコンテキスト境界であり、ホスト管理者境界ではありません。ユーザーが相互に敵対的で同じGatewayホスト/設定を共有している場合は、代わりに信頼境界ごとに別々のGatewayを実行してください。

### セキュアDMモード（推奨）

上記のスニペットを**セキュアDMモード**として扱ってください：

- デフォルト：`session.dmScope: "main"`（すべてのDMが継続性のために1つのセッションを共有）。
- ローカルCLIオンボーディングデフォルト：未設定の場合`session.dmScope: "per-channel-peer"`を書き込みます（既存の明示的な値は保持）。
- セキュアDMモード：`session.dmScope: "per-channel-peer"`（各チャンネル+送信者ペアが分離されたDMコンテキストを取得）。

同じチャンネルで複数のアカウントを実行している場合は、代わりに`per-account-channel-peer`を使用してください。同じ人が複数のチャンネルから連絡してくる場合は、`session.identityLinks`を使用してそれらのDMセッションを1つの正規アイデンティティに統合してください。[セッション管理](/concepts/session)と[設定](/gateway/configuration)を参照してください。

## 許可リスト（DM + グループ） - 用語

OpenClawには2つの別々の「誰が私をトリガーできるか？」レイヤーがあります：

- **DM許可リスト**（`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`、レガシー：`channels.discord.dm.allowFrom`、`channels.slack.dm.allowFrom`）：ダイレクトメッセージでボットと話すことが許可されている人。
  - `dmPolicy="pairing"`の場合、承認は`~/.openclaw/credentials/`配下のアカウントスコープのペアリング許可リストストアに書き込まれます（デフォルトアカウントの場合`<channel>-allowFrom.json`、デフォルト以外のアカウントの場合`<channel>-<accountId>-allowFrom.json`）。設定許可リストとマージされます。
- **グループ許可リスト**（チャンネル固有）：ボットがメッセージを受け入れるグループ/チャンネル/ギルド。
  - 一般的なパターン：
    - `channels.whatsapp.groups`、`channels.telegram.groups`、`channels.imessage.groups`：`requireMention`などのグループごとのデフォルト。設定すると、グループ許可リストとしても機能します（全許可動作を維持するには`"*"`を含めてください）。
    - `groupPolicy="allowlist"` + `groupAllowFrom`：グループセッション_内で_ボットをトリガーできる人を制限（WhatsApp/Telegram/Signal/iMessage/Microsoft Teams）。
    - `channels.discord.guilds` / `channels.slack.channels`：サーフェスごとの許可リスト + メンションデフォルト。
  - グループチェックはこの順序で実行されます：`groupPolicy`/グループ許可リストが最初、メンション/リプライアクティベーションが2番目。
  - ボットメッセージへのリプライ（暗黙的なメンション）は`groupAllowFrom`のような送信者許可リストをバイパス**しません**。
  - **セキュリティに関する注意：** `dmPolicy="open"`と`groupPolicy="open"`は最後の手段の設定として扱ってください。ほとんど使用すべきではありません。ルームのすべてのメンバーを完全に信頼しない限り、ペアリング + 許可リストを推奨します。

詳細：[設定](/gateway/configuration)と[グループ](/channels/groups)

## プロンプトインジェクション（概要と重要性）

プロンプトインジェクションとは、攻撃者がモデルを操作して安全でないことをさせるメッセージを作成することです（「指示を無視せよ」、「ファイルシステムをダンプせよ」、「このリンクをフォローしてコマンドを実行せよ」など）。

強力なシステムプロンプトがあっても、**プロンプトインジェクションは解決されていません**。システムプロンプトガードレールはソフトガイダンスに過ぎません。ハードな強制はツールポリシー、exec承認、サンドボックス、およびチャンネル許可リストから来ます（オペレーターは設計上これらを無効化できます）。実際に役立つこと：

- インバウンドDMをロックダウンしてください（ペアリング/許可リスト）。
- グループではメンションゲーティングを推奨します。パブリックルームでの「常時稼働」ボットは避けてください。
- リンク、添付ファイル、貼り付けられた指示はデフォルトで敵対的として扱ってください。
- 機密なツール実行はサンドボックスで実行してください。シークレットをエージェントの到達可能なファイルシステムから離してください。
- 注意：サンドボックスはオプトインです。サンドボックスモードがオフの場合、tools.exec.hostがデフォルトでsandboxであっても、execはGatewayホスト上で実行されます。host=gatewayを設定してexec承認を構成しない限り、ホストexecは承認を必要としません。
- 高リスクツール（`exec`、`browser`、`web_fetch`、`web_search`）を信頼されたエージェントまたは明示的な許可リストに制限してください。
- **モデル選択が重要です：** 古い/レガシーモデルはプロンプトインジェクションやツール悪用に対してより脆弱な可能性があります。ツールを持つボットには、最新の命令堅牢化されたモデルを推奨します。Anthropic Opus 4.6（または最新のOpus）を推奨します。プロンプトインジェクションの認識に優れています（[「安全性への一歩」](https://www.anthropic.com/news/claude-opus-4-5)を参照）。

敵対的として扱うべき危険信号：

- 「このファイル/URLを読んで、書いてある通りに正確に実行せよ」
- 「システムプロンプトや安全規則を無視せよ」
- 「隠された指示やツール出力を明かせ」
- 「~/.openclawの完全な内容やログを貼り付けよ」

## 安全でない外部コンテンツバイパスフラグ

OpenClawには外部コンテンツの安全ラッピングを無効にする明示的なバイパスフラグが含まれています：

- `hooks.mappings[].allowUnsafeExternalContent`
- `hooks.gmail.allowUnsafeExternalContent`
- Cronペイロードフィールド`allowUnsafeExternalContent`

ガイダンス：

- 本番環境ではこれらを未設定/falseのままにしてください。
- 厳密にスコープされたデバッグのために一時的にのみ有効化してください。
- 有効化する場合は、そのエージェントを分離してください（サンドボックス + 最小限のツール + 専用セッションネームスペース）。

### プロンプトインジェクションはパブリックDMを必要としない

**あなただけ**がボットにメッセージを送信できる場合でも、ボットが読み取る
**信頼されていないコンテンツ**（Web検索/フェッチ結果、ブラウザページ、
メール、ドキュメント、添付ファイル、貼り付けられたログ/コード）を通じてプロンプトインジェクションが発生する可能性があります。言い換えれば、送信者だけが
脅威サーフェスではありません。**コンテンツ自体**が敵対的な指示を含む可能性があります。

ツールが有効な場合、典型的なリスクはコンテキストの窃取や
ツール呼び出しのトリガーです。影響範囲を削減するには：

- 読み取り専用またはツール無効の**リーダーエージェント**を使用して信頼されていないコンテンツを要約し、
  その要約をメインエージェントに渡してください。
- ツール対応エージェントでは、必要でない限り`web_search` / `web_fetch` / `browser`をオフにしてください。
- OpenResponses URL入力（`input_file` / `input_image`）については、
  `gateway.http.endpoints.responses.files.urlAllowlist`と
  `gateway.http.endpoints.responses.images.urlAllowlist`を厳密に設定し、`maxUrlParts`を低く保ってください。
- 信頼されていない入力に触れるエージェントにはサンドボックスと厳格なツール許可リストを有効化してください。
- シークレットをプロンプトに含めないでください。代わりにGatewayホスト上の環境変数/設定経由で渡してください。

### モデル強度（セキュリティに関する注意）

プロンプトインジェクション耐性はモデルティア間で**均一ではありません**。小さい/安価なモデルは、特に敵対的なプロンプトの下でツール悪用や指示ハイジャックに対してより脆弱です。

推奨事項：

- ツールを実行したりファイル/ネットワークに触れたりできるボットには**最新世代の最上位モデル**を使用してください。
- ツール対応エージェントや信頼されていない受信箱には**弱いティア**（例：SonnetやHaiku）を避けてください。
- 小さいモデルを使用する必要がある場合は、**影響範囲を削減**してください（読み取り専用ツール、強力なサンドボックス、最小限のファイルシステムアクセス、厳格な許可リスト）。
- 小さいモデルを実行する場合は、**すべてのセッションでサンドボックスを有効化**し、入力が厳密に制御されていない限り**web_search/web_fetch/browserを無効化**してください。
- 信頼された入力とツールなしのチャット専用パーソナルアシスタントの場合、小さいモデルは通常問題ありません。

## グループでのReasoningとVerbose出力

`/reasoning`と`/verbose`は、パブリックチャンネル向けではない内部推論やツール出力を公開する可能性があります。グループ設定では、**デバッグ専用**として扱い、明示的に必要でない限りオフにしてください。

ガイダンス：

- パブリックルームでは`/reasoning`と`/verbose`を無効にしてください。
- 有効にする場合は、信頼されたDMまたは厳密に管理されたルームでのみ行ってください。
- 注意：verbose出力にはツール引数、URL、モデルが見たデータが含まれる可能性があります。

## 設定堅牢化（例）

### 0) ファイル権限

Gatewayホスト上で設定 + 状態をプライベートに保ってください：

- `~/.openclaw/openclaw.json`：`600`（ユーザー読み書きのみ）
- `~/.openclaw`：`700`（ユーザーのみ）

`openclaw doctor`はこれらの権限について警告し、厳格化を提案できます。

### 0.4) ネットワーク露出（バインド + ポート + ファイアウォール）

Gatewayは**WebSocket + HTTP**を単一ポートで多重化します：

- デフォルト：`18789`
- 設定/フラグ/環境変数：`gateway.port`、`--port`、`OPENCLAW_GATEWAY_PORT`

このHTTPサーフェスにはControl UIとキャンバスホストが含まれます：

- Control UI（SPAアセット）（デフォルトベースパス`/`）
- キャンバスホスト：`/__openclaw__/canvas/`と`/__openclaw__/a2ui/`（任意のHTML/JS、信頼されていないコンテンツとして扱ってください）

キャンバスコンテンツを通常のブラウザでロードする場合、他の信頼されていないWebページと同様に扱ってください：

- キャンバスホストを信頼されていないネットワーク/ユーザーに公開しないでください。
- 影響を完全に理解しない限り、キャンバスコンテンツを特権Webサーフェスと同じオリジンで共有しないでください。

バインドモードはGatewayがリッスンする場所を制御します：

- `gateway.bind: "loopback"`（デフォルト）：ローカルクライアントのみが接続可能。
- 非ループバックバインド（`"lan"`、`"tailnet"`、`"custom"`）はアタックサーフェスを拡大します。共有トークン/パスワードと実際のファイアウォールでのみ使用してください。

経験則：

- LANバインドよりTailscale Serveを推奨します（ServeはGatewayをループバックに保ち、Tailscaleがアクセスを処理します）。
- LANへのバインドが必要な場合は、ポートを厳格なソースIP許可リストにファイアウォールしてください。広範にポートフォワーディングしないでください。
- `0.0.0.0`で未認証のGatewayを公開しないでください。

### 0.4.1) mDNS/Bonjourディスカバリ（情報漏洩）

Gatewayはローカルデバイス検出のためにmDNS（ポート5353の`_openclaw-gw._tcp`）でプレゼンスをブロードキャストします。フルモードでは、運用の詳細を公開する可能性のあるTXTレコードが含まれます：

- `cliPath`：CLIバイナリへの完全なファイルシステムパス（ユーザー名とインストール場所を明らかにする）
- `sshPort`：ホスト上のSSH利用可能性をアドバタイズ
- `displayName`、`lanHost`：ホスト名情報

**運用セキュリティに関する考慮事項：** インフラストラクチャの詳細をブロードキャストすると、ローカルネットワーク上の誰にとっても偵察が容易になります。ファイルシステムパスやSSH利用可能性などの「無害な」情報でさえ、攻撃者が環境をマッピングするのに役立ちます。

**推奨事項：**

1. **ミニマルモード**（デフォルト、露出されたGatewayに推奨）：mDNSブロードキャストから機密フィールドを除外：

   ```json5
   {
     discovery: {
       mdns: { mode: "minimal" },
     },
   }
   ```

2. ローカルデバイス検出が不要な場合は**完全に無効化**：

   ```json5
   {
     discovery: {
       mdns: { mode: "off" },
     },
   }
   ```

3. **フルモード**（オプトイン）：TXTレコードに`cliPath` + `sshPort`を含める：

   ```json5
   {
     discovery: {
       mdns: { mode: "full" },
     },
   }
   ```

4. **環境変数**（代替）：設定変更なしでmDNSを無効にするには`OPENCLAW_DISABLE_BONJOUR=1`を設定。

ミニマルモードでは、Gatewayはデバイス検出に十分な情報（`role`、`gatewayPort`、`transport`）をブロードキャストしますが、`cliPath`と`sshPort`を省略します。CLIパス情報が必要なアプリは、代わりに認証済みWebSocket接続経由で取得できます。

### 0.5) Gateway WebSocketのロックダウン（ローカル認証）

Gateway認証は**デフォルトで必須**です。トークン/パスワードが設定されていない場合、
GatewayはWebSocket接続を拒否します（フェイルクローズ）。

オンボーディングウィザードはデフォルトでトークンを生成するため（ループバックでも）、
ローカルクライアントは認証する必要があります。

**すべての**WSクライアントが認証する必要があるようにトークンを設定してください：

```json5
{
  gateway: {
    auth: { mode: "token", token: "your-token" },
  },
}
```

Doctorが生成できます：`openclaw doctor --generate-gateway-token`。

注意：`gateway.remote.token` / `.password`はクライアント認証情報ソースです。
それ自体ではローカルWSアクセスを保護**しません**。
`gateway.auth.*`が未設定の場合、ローカル呼び出しパスは`gateway.remote.*`をフォールバックとして使用できます。
オプション：`wss://`使用時に`gateway.remote.tlsFingerprint`でリモートTLSをピン留め。

ローカルデバイスペアリング：

- デバイスペアリングは、同じホストのクライアントをスムーズに保つために**ローカル**接続（ループバックまたは
  Gatewayホスト自身のTailnetアドレス）で自動承認されます。
- 他のTailnetピアはローカルとして扱われ**ません**。ペアリング
  承認が必要です。

認証モード：

- `gateway.auth.mode: "token"`：共有ベアラートークン（ほとんどのセットアップに推奨）。
- `gateway.auth.mode: "password"`：パスワード認証（環境変数での設定を推奨：`OPENCLAW_GATEWAY_PASSWORD`）。
- `gateway.auth.mode: "trusted-proxy"`：アイデンティティ認識リバースプロキシを信頼してユーザーを認証し、ヘッダー経由でアイデンティティを渡します（[Trusted Proxy Auth](/gateway/trusted-proxy-auth)を参照）。

ローテーションチェックリスト（トークン/パスワード）：

1. 新しいシークレットを生成/設定してください（`gateway.auth.token`または`OPENCLAW_GATEWAY_PASSWORD`）。
2. Gatewayを再起動してください（またはGatewayを管理するmacOSアプリを再起動）。
3. リモートクライアントを更新してください（Gatewayに呼び出すマシンの`gateway.remote.token` / `.password`）。
4. 古い認証情報で接続できなくなったことを確認してください。

### 0.6) Tailscale Serveアイデンティティヘッダー

`gateway.auth.allowTailscale`が`true`（Serveのデフォルト）の場合、OpenClawは
Control UI/WebSocket認証のためにTailscale Serveアイデンティティヘッダー（`tailscale-user-login`）を受け入れます。OpenClawはローカルTailscaleデーモン（`tailscale whois`）経由で
`x-forwarded-for`アドレスを解決し、ヘッダーと照合することでアイデンティティを検証します。これはループバックにヒットし、
Tailscaleによって挿入された`x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`を含む
リクエストに対してのみトリガーされます。
HTTP APIエンドポイント（例：`/v1/*`、`/tools/invoke`、`/api/channels/*`）は
トークン/パスワード認証が必要です。

**信頼の前提：** トークンレスServe認証はGatewayホストが信頼されていることを前提としています。
信頼されていないローカルコードがGatewayホスト上で実行される可能性がある場合は、`gateway.auth.allowTailscale`を無効にし
トークン/パスワード認証を要求してください。

**セキュリティルール：** 独自のリバースプロキシからこれらのヘッダーを転送しないでください。
Gateway前でTLS終端やプロキシを行う場合は、
`gateway.auth.allowTailscale`を無効にし、トークン/パスワード認証（または[Trusted Proxy Auth](/gateway/trusted-proxy-auth)）を代わりに使用してください。

Trusted Proxy：

- Gateway前でTLSを終端する場合は、`gateway.trustedProxies`をプロキシIPに設定してください。
- OpenClawはローカルペアリングチェックとHTTP認証/ローカルチェックのためにクライアントIPを決定するために、それらのIPからの`x-forwarded-for`（または`x-real-ip`）を信頼します。
- プロキシが`x-forwarded-for`を**上書き**し、Gatewayポートへの直接アクセスをブロックすることを確認してください。

[Tailscale](/gateway/tailscale)と[Web概要](/web)を参照してください。

### 0.6.1) ノードホスト経由のブラウザコントロール（推奨）

Gatewayがリモートでブラウザが別のマシンで実行されている場合、
ブラウザマシンで**ノードホスト**を実行し、Gatewayにブラウザアクションをプロキシさせてください（[ブラウザツール](/tools/browser)を参照）。
ノードペアリングを管理者アクセスと同様に扱ってください。

推奨パターン：

- Gatewayとノードホストを同じTailnet（Tailscale）に保ってください。
- 意図的にノードをペアリングしてください。不要な場合はブラウザプロキシルーティングを無効にしてください。

避けるべきこと：

- LANまたはパブリックインターネット経由でリレー/コントロールポートを公開すること。
- ブラウザコントロールエンドポイントにTailscale Funnel（パブリック露出）を使用すること。

### 0.7) ディスク上のシークレット（機密なもの）

`~/.openclaw/`（または`$OPENCLAW_STATE_DIR/`）配下のすべてがシークレットまたはプライベートデータを含む可能性があると想定してください：

- `openclaw.json`：設定にトークン（Gateway、リモートGateway）、プロバイダー設定、許可リストが含まれる場合があります。
- `credentials/**`：チャンネル認証情報（例：WhatsApp認証情報）、ペアリング許可リスト、レガシーOAuthインポート。
- `agents/<agentId>/agent/auth-profiles.json`：APIキー、トークンプロファイル、OAuthトークン、オプションの`keyRef`/`tokenRef`。
- `secrets.json`（オプション）：`file` SecretRefプロバイダー（`secrets.providers`）で使用されるファイルベースシークレットペイロード。
- `agents/<agentId>/agent/auth.json`：レガシー互換ファイル。静的な`api_key`エントリは発見時にスクラブされます。
- `agents/<agentId>/sessions/**`：セッショントランスクリプト（`*.jsonl`）+ ルーティングメタデータ（`sessions.json`）。プライベートメッセージやツール出力を含む場合があります。
- `extensions/**`：インストールされたプラグイン（`node_modules/`を含む）。
- `sandboxes/**`：ツールサンドボックスワークスペース。サンドボックス内で読み書きしたファイルのコピーが蓄積される場合があります。

堅牢化のヒント：

- 権限を厳格に保ってください（ディレクトリには`700`、ファイルには`600`）。
- Gatewayホストでフルディスク暗号化を使用してください。
- ホストが共有されている場合は、Gateway用に専用のOSユーザーアカウントを推奨します。

### 0.8) ログ + トランスクリプト（リダクション + 保持）

アクセス制御が正しい場合でも、ログとトランスクリプトは機密情報を漏洩する可能性があります：

- Gatewayログにはツールサマリー、エラー、URLが含まれる場合があります。
- セッショントランスクリプトには貼り付けられたシークレット、ファイル内容、コマンド出力、リンクが含まれる場合があります。

推奨事項：

- ツールサマリーリダクションをオンにしてください（`logging.redactSensitive: "tools"`、デフォルト）。
- 環境に合わせたカスタムパターンを`logging.redactPatterns`で追加してください（トークン、ホスト名、内部URL）。
- 診断を共有する場合は、生ログよりも`openclaw status --all`（貼り付け可能、シークレットリダクション済み）を推奨します。
- 長期保持が不要な場合は、古いセッショントランスクリプトとログファイルを整理してください。

詳細：[ロギング](/gateway/logging)

### 1) DM：デフォルトでペアリング

```json5
{
  channels: { whatsapp: { dmPolicy: "pairing" } },
}
```

### 2) グループ：どこでもメンション必須

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

### 3. 別の番号

AIを個人の電話番号とは別の番号で実行することを検討してください：

- 個人番号：あなたの会話はプライベートのまま
- ボット番号：AIが適切な境界を持ってこれらを処理

### 4. 読み取り専用モード（現在、サンドボックス + ツール経由）

以下を組み合わせることで、すでに読み取り専用プロファイルを構築できます：

- `agents.defaults.sandbox.workspaceAccess: "ro"`（またはワークスペースアクセスなしの`"none"`）
- `write`、`edit`、`apply_patch`、`exec`、`process`などをブロックするツールallow/denyリスト

この設定を簡素化するために、後に単一の`readOnlyMode`フラグを追加する可能性があります。

追加の堅牢化オプション：

- `tools.exec.applyPatch.workspaceOnly: true`（デフォルト）：サンドボックスがオフの場合でも、`apply_patch`がワークスペースディレクトリの外にあるファイルに書き込み/削除できないことを保証します。意図的に`apply_patch`でワークスペース外のファイルに触れたい場合のみ`false`に設定してください。
- `tools.fs.workspaceOnly: true`（オプション）：`read`/`write`/`edit`/`apply_patch`パスとネイティブプロンプト画像自動ロードパスをワークスペースディレクトリに制限します（今日絶対パスを許可しており、単一のガードレールが必要な場合に有用）。
- ファイルシステムルートを狭く保ってください：エージェントワークスペース/サンドボックスワークスペースにホームディレクトリのような広いルートを使用しないでください。広いルートは機密なローカルファイル（例：`~/.openclaw`配下の状態/設定）をファイルシステムツールに公開する可能性があります。

### 5) セキュアベースライン（コピー&ペースト）

Gatewayをプライベートに保ち、DMペアリングを要求し、常時稼働のグループボットを避ける「安全なデフォルト」設定：

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

「デフォルトでより安全な」ツール実行も必要な場合は、サンドボックスを追加し、オーナー以外のエージェントに対して危険なツールを拒否してください（以下の「エージェントごとのアクセスプロファイル」の例を参照）。

チャット駆動のエージェントターンの組み込みベースライン：オーナー以外の送信者は`cron`や`gateway`ツールを使用できません。

## サンドボックス（推奨）

専用ドキュメント：[サンドボックス](/gateway/sandboxing)

2つの補完的なアプローチ：

- **GatewayをまるごとDockerで実行**（コンテナ境界）：[Docker](/install/docker)
- **ツールサンドボックス**（`agents.defaults.sandbox`、ホストGateway + Docker分離ツール）：[サンドボックス](/gateway/sandboxing)

注意：エージェント間のアクセスを防止するには、`agents.defaults.sandbox.scope`を`"agent"`（デフォルト）
または`"session"`（より厳格なセッションごとの分離）に保ってください。`scope: "shared"`は
単一のコンテナ/ワークスペースを使用します。

サンドボックス内のエージェントワークスペースアクセスも検討してください：

- `agents.defaults.sandbox.workspaceAccess: "none"`（デフォルト）はエージェントワークスペースをアクセス不可にします。ツールは`~/.openclaw/sandboxes`配下のサンドボックスワークスペースに対して実行されます
- `agents.defaults.sandbox.workspaceAccess: "ro"`はエージェントワークスペースを`/agent`に読み取り専用でマウントします（`write`/`edit`/`apply_patch`を無効化）
- `agents.defaults.sandbox.workspaceAccess: "rw"`はエージェントワークスペースを`/workspace`に読み書き可能でマウントします

重要：`tools.elevated`はホスト上でexecを実行するグローバルベースラインのエスケープハッチです。`tools.elevated.allowFrom`を厳格に保ち、見知らぬ人には有効化しないでください。`agents.list[].tools.elevated`でエージェントごとにさらにelevatedを制限できます。[Elevatedモード](/tools/elevated)を参照してください。

## ブラウザコントロールのリスク

ブラウザコントロールを有効にすると、モデルに実際のブラウザを操作する能力を与えます。
そのブラウザプロファイルにすでにログイン済みセッションが含まれている場合、モデルはそれらのアカウントとデータにアクセスできます。ブラウザプロファイルを**機密状態**として扱ってください：

- エージェント用の専用プロファイルを推奨します（デフォルトの`openclaw`プロファイル）。
- エージェントを個人の日常使いプロファイルに向けないでください。
- サンドボックスエージェントについては、信頼しない限りホストブラウザコントロールを無効にしてください。
- ブラウザダウンロードを信頼されていない入力として扱ってください。分離されたダウンロードディレクトリを推奨します。
- 可能であれば、エージェントプロファイルのブラウザ同期/パスワードマネージャーを無効にしてください（影響範囲を削減）。
- リモートGatewayの場合、「ブラウザコントロール」はそのプロファイルが到達できるものへの「オペレーターアクセス」と同等と想定してください。
- GatewayとノードホストをTailnet限定に保ってください。リレー/コントロールポートをLANやパブリックインターネットに公開しないでください。
- Chrome拡張機能リレーのCDPエンドポイントは認証ゲートされています。OpenClawクライアントのみが接続できます。
- 不要な場合はブラウザプロキシルーティングを無効にしてください（`gateway.nodes.browser.mode="off"`）。
- Chrome拡張機能リレーモードは「より安全」では**ありません**。既存のChromeタブを乗っ取ることができます。そのタブ/プロファイルが到達できるものすべてに対して、あなたとして行動できると想定してください。

### ブラウザSSRFポリシー（信頼ネットワークデフォルト）

OpenClawのブラウザネットワークポリシーは信頼されたオペレーターモデルにデフォルトします：明示的に無効化しない限り、プライベート/内部宛先が許可されます。

- デフォルト：`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`（未設定時の暗黙値）。
- レガシーエイリアス：`browser.ssrfPolicy.allowPrivateNetwork`は互換性のために引き続き受け入れられます。
- 厳格モード：`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: false`を設定して、デフォルトでプライベート/内部/特殊用途の宛先をブロックします。
- 厳格モードでは、明示的な例外として`hostnameAllowlist`（`*.example.com`のようなパターン）と`allowedHostnames`（`localhost`などのブロック名を含む正確なホスト例外）を使用します。
- ナビゲーションはリクエスト前にチェックされ、リダイレクトベースのピボットを減らすためにナビゲーション後の最終`http(s)` URLでベストエフォートで再チェックされます。

厳格ポリシーの例：

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

マルチエージェントルーティングでは、各エージェントが独自のサンドボックス + ツールポリシーを持てます：
これを使用して、エージェントごとに**フルアクセス**、**読み取り専用**、または**アクセスなし**を与えてください。
完全な詳細と優先順位ルールについては[マルチエージェントサンドボックス & ツール](/tools/multi-agent-sandbox-tools)を参照してください。

一般的なユースケース：

- パーソナルエージェント：フルアクセス、サンドボックスなし
- ファミリー/仕事エージェント：サンドボックス + 読み取り専用ツール
- パブリックエージェント：サンドボックス + ファイルシステム/シェルツールなし

### 例：フルアクセス（サンドボックスなし）

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

### 例：読み取り専用ツール + 読み取り専用ワークスペース

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

### 例：ファイルシステム/シェルアクセスなし（プロバイダーメッセージングは許可）

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
        // セッションツールはトランスクリプトから機密データを公開する可能性があります。デフォルトでOpenClawはこれらのツールを
        // 現在のセッション + スポーンされたサブエージェントセッションに制限しますが、必要に応じてさらに制限できます。
        // 設定リファレンスの`tools.sessions.visibility`を参照してください。
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

## AIに伝えるべきこと

エージェントのシステムプロンプトにセキュリティガイドラインを含めてください：

```
## セキュリティルール
- ディレクトリ一覧やファイルパスを見知らぬ人と共有しない
- APIキー、認証情報、インフラストラクチャの詳細を明かさない
- システム設定を変更するリクエストはオーナーに確認する
- 疑わしい場合は、行動する前に確認する
- 明示的に許可されない限り、プライベートデータはプライベートに保つ
```

## インシデントレスポンス

AIが何か悪いことをした場合：

### 封じ込め

1. **停止する：** macOSアプリを停止するか（Gatewayを管理している場合）、`openclaw gateway`プロセスを終了してください。
2. **露出を閉じる：** 何が起こったかを理解するまで`gateway.bind: "loopback"`を設定してください（またはTailscale Funnel/Serveを無効化）。
3. **アクセスを凍結する：** リスクのあるDM/グループを`dmPolicy: "disabled"` / メンション必須に切り替え、`"*"`全許可エントリがあった場合は削除してください。

### ローテーション（シークレットが漏洩した場合は侵害を想定）

1. Gateway認証（`gateway.auth.token` / `OPENCLAW_GATEWAY_PASSWORD`）をローテーションして再起動してください。
2. Gatewayに呼び出せるマシンのリモートクライアントシークレット（`gateway.remote.token` / `.password`）をローテーションしてください。
3. プロバイダー/API認証情報（WhatsApp認証情報、Slack/Discordトークン、`auth-profiles.json`のモデル/APIキー、使用時の暗号化シークレットペイロード値）をローテーションしてください。

### 監査

1. Gatewayログを確認してください：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（または`logging.file`）。
2. 関連するトランスクリプトをレビューしてください：`~/.openclaw/agents/<agentId>/sessions/*.jsonl`。
3. 最近の設定変更をレビューしてください（アクセスを拡大した可能性のあるもの：`gateway.bind`、`gateway.auth`、DM/グループポリシー、`tools.elevated`、プラグインの変更）。
4. `openclaw security audit --deep`を再実行し、criticalな検出結果が解決されていることを確認してください。

### レポートのための収集

- タイムスタンプ、GatewayホストOS + OpenClawバージョン
- セッショントランスクリプト + 短いログ末尾（リダクション後）
- 攻撃者が送信したもの + エージェントが行ったこと
- Gatewayがループバック以外に公開されていたかどうか（LAN/Tailscale Funnel/Serve）

## シークレットスキャン（detect-secrets）

CIは`secrets`ジョブで`detect-secrets scan --baseline .secrets.baseline`を実行します。
失敗した場合、ベースラインにまだ含まれていない新しい候補があります。

### CIが失敗した場合

1. ローカルで再現してください：

   ```bash
   detect-secrets scan --baseline .secrets.baseline
   ```

2. ツールを理解してください：
   - `detect-secrets scan`は候補を見つけてベースラインと比較します。
   - `detect-secrets audit`はインタラクティブなレビューを開き、各ベースライン
     アイテムを本物または偽陽性としてマークします。
3. 本物のシークレットの場合：ローテーション/削除し、スキャンを再実行してベースラインを更新してください。
4. 偽陽性の場合：インタラクティブな監査を実行し、falseとしてマークしてください：

   ```bash
   detect-secrets audit .secrets.baseline
   ```

5. 新しい除外が必要な場合は、`.detect-secrets.cfg`に追加し、一致する`--exclude-files` / `--exclude-lines`フラグでベースラインを再生成してください（設定
   ファイルは参照のみです。detect-secretsは自動的に読み取りません）。

更新された`.secrets.baseline`が意図された状態を反映したらコミットしてください。

## セキュリティ問題の報告

OpenClawに脆弱性を発見しましたか？責任ある報告をお願いします：

1. メール：[security@openclaw.ai](mailto:security@openclaw.ai)
2. 修正されるまで公開しないでください
3. クレジットいたします（匿名を希望される場合を除く）
