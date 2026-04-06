---
read_when:
    - 設定や状態に対して簡易セキュリティ監査を実行したいとき
    - 安全な「修正」提案（chmod、デフォルトの厳格化）を適用したいとき
summary: '`openclaw security`（一般的なセキュリティ上の問題を監査・修正する）の CLI リファレンス'
title: security
x-i18n:
    generated_at: "2026-04-02T07:36:11Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 374db3580dc8844274b053583cf89fdf6985afee66feb2c91f7209170f4fb45a
    source_path: cli/security.md
    workflow: 15
---

# `openclaw security`

セキュリティツール（監査＋オプションの修正）。

関連：

- セキュリティガイド: [セキュリティ](/gateway/security)

## 監査

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --deep --password <password>
openclaw security audit --deep --token <token>
openclaw security audit --fix
openclaw security audit --json
```

この監査は、複数のダイレクトメッセージ送信者がメインセッションを共有している場合に警告し、**セキュアダイレクトメッセージモード**を推奨します：共有インボックスには `session.dmScope="per-channel-peer"`（マルチアカウントチャネルの場合は `per-account-channel-peer`）を設定してください。
これは協調的・共有インボックスの堅牢化を目的としています。相互に信頼できない、または敵対的なオペレーターが共有する単一の Gateway ゲートウェイは推奨されるセットアップではありません。信頼境界を分離するには、別々の Gateway ゲートウェイ（または別々の OS ユーザー/ホスト）を使用してください。
また、設定が共有ユーザーの受信を示唆する場合（例：オープンなダイレクトメッセージ/グループポリシー、設定済みのグループターゲット、ワイルドカード送信者ルールなど）には `security.trust_model.multi_user_heuristic` を出力し、OpenClaw はデフォルトで個人アシスタントの信頼モデルであることをリマインドします。
意図的な共有ユーザーセットアップの場合、監査のガイダンスとしては、すべてのセッションをサンドボックス化し、ファイルシステムアクセスをワークスペーススコープに限定し、個人的・プライベートな ID や認証情報をそのランタイムに置かないことを推奨します。
また、小規模モデル（`<=300B`）がサンドボックス化なしで Web/ブラウザツールが有効な状態で使用されている場合にも警告します。
Webhook 受信については、`hooks.token` が Gateway ゲートウェイトークンを再利用している場合、`hooks.defaultSessionKey` が未設定の場合、`hooks.allowedAgentIds` が制限されていない場合、リクエストの `sessionKey` オーバーライドが有効な場合、およびオーバーライドが `hooks.allowedSessionKeyPrefixes` なしで有効な場合に警告します。
また、サンドボックスモードがオフの状態でサンドボックス Docker 設定が構成されている場合、`gateway.nodes.denyCommands` が無効なパターンのような/不明なエントリを使用している場合（完全一致のノードコマンド名のみで、シェルテキストフィルタリングではない）、`gateway.nodes.allowCommands` が危険なノードコマンドを明示的に有効にしている場合、グローバルな `tools.profile="minimal"` がエージェントのツールプロファイルによってオーバーライドされている場合、オープングループがサンドボックス/ワークスペースガードなしでランタイム/ファイルシステムツールを公開している場合、およびインストール済みの拡張プラグインツールが許容的なツールポリシーの下で到達可能な場合にも警告します。
`gateway.allowRealIpFallback=true`（プロキシが誤設定されている場合のヘッダースプーフィングリスク）および `discovery.mdns.mode="full"`（mDNS TXT レコードによるメタデータ漏洩）もフラグ付けします。
また、サンドボックスブラウザが `sandbox.browser.cdpSourceRange` なしで Docker `bridge` ネットワークを使用している場合にも警告します。
危険なサンドボックス Docker ネットワークモード（`host` や `container:*` 名前空間結合を含む）もフラグ付けします。
また、既存のサンドボックスブラウザ Docker コンテナにハッシュラベルが欠落・陳腐化している場合（例：マイグレーション前のコンテナで `openclaw.browserConfigEpoch` が欠落）にも警告し、`openclaw sandbox recreate --browser --all` を推奨します。
npm ベースのプラグイン/フックのインストールレコードがピン留めされていない場合、整合性メタデータが欠落している場合、または現在インストールされているパッケージバージョンと乖離している場合にも警告します。
チャネル許可リストが安定した ID ではなく変更可能な名前/メール/タグに依存している場合に警告します（Discord、Slack、Google Chat、Microsoft Teams、Mattermost、IRC スコープなど該当する場合）。
`gateway.auth.mode="none"` で Gateway ゲートウェイ HTTP API が共有シークレットなしでアクセス可能な状態（`/tools/invoke` および有効な `/v1/*` エンドポイント）の場合にも警告します。
`dangerous`/`dangerously` プレフィックスが付いた設定は、明示的なブレークグラス用オペレーターオーバーライドです。有効にすること自体はセキュリティ脆弱性の報告ではありません。
危険パラメーターの完全な一覧については、[セキュリティ](/gateway/security)の「安全でない、または危険なフラグの概要」セクションを参照してください。

SecretRef の動作：

- `security audit` は、対象パスに対して読み取り専用モードでサポートされている SecretRef を解決します。
- 現在のコマンドパスで SecretRef が利用できない場合、監査は続行し、（クラッシュする代わりに）`secretDiagnostics` を報告します。
- `--token` と `--password` は、そのコマンド呼び出しのディーププローブ認証のみをオーバーライドします。設定や SecretRef マッピングの書き換えは行いません。

## JSON 出力

CI/ポリシーチェックには `--json` を使用します：

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

`--fix` と `--json` を組み合わせた場合、出力には修正アクションと最終レポートの両方が含まれます：

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## `--fix` が変更する内容

`--fix` は安全で決定論的な修正を適用します：

- 一般的な `groupPolicy="open"` を `groupPolicy="allowlist"` に変更（サポートされているチャネルのアカウントバリアントを含む）
- `logging.redactSensitive` を `"off"` から `"tools"` に設定
- 状態/設定および一般的な機密ファイルのパーミッションを厳格化（`credentials/*.json`、`auth-profiles.json`、`sessions.json`、セッション `*.jsonl`）

`--fix` は以下を**行いません**：

- トークン/パスワード/API キーのローテーション
- ツールの無効化（`gateway`、`cron`、`exec` など）
- Gateway ゲートウェイのバインド/認証/ネットワーク公開設定の変更
- プラグイン/Skills の削除または書き換え
