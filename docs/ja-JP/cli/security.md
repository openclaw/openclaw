---
summary: "`openclaw security` の CLI リファレンス（よくあるセキュリティの落とし穴の監査と修正）"
read_when:
  - 設定/ステートに対する簡易セキュリティ監査の実行
  - 安全な「修正」提案の適用（chmod、デフォルトの強化）
title: "security"
---

# `openclaw security`

セキュリティツール（監査 + オプションの修正）です。

関連:

- セキュリティガイド: [セキュリティ](/gateway/security)

## 監査

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

監査は、複数の DM 送信者がメインセッションを共有している場合に警告し、**セキュア DM モード**: `session.dmScope="per-channel-peer"`（マルチアカウントチャンネルの場合は `per-account-channel-peer`）を共有インボックスに推奨します。
これは協調的/共有インボックスの強化のためのものです。相互に信頼されていない/敵対的なオペレーターが共有する単一の Gateway は推奨される設定ではありません。信頼境界を分割するには、別々の Gateway（または別々の OS ユーザー/ホスト）を使用してください。
また、設定が複数ユーザーのインバウンドを示唆する場合（例: オープンな DM/グループポリシー、設定済みグループターゲット、ワイルドカード送信者ルール）に `security.trust_model.multi_user_heuristic` を出力し、OpenClaw がデフォルトでパーソナルアシスタントの信頼モデルであることを通知します。
意図的な複数ユーザーセットアップの場合、監査のガイダンスはすべてのセッションをサンドボックス化し、ファイルシステムアクセスをワークスペーススコープに保ち、個人的/プライベートな ID や認証情報をそのランタイムに配置しないことです。
また、小規模モデル（`<=300B`）がサンドボックスなしで Web/ブラウザツールが有効な状態で使用されている場合にも警告します。
Webhook インバウンドについては、`hooks.defaultSessionKey` が未設定の場合、リクエストの `sessionKey` オーバーライドが有効な場合、およびオーバーライドが `hooks.allowedSessionKeyPrefixes` なしで有効な場合に警告します。
また、サンドボックスモードがオフの状態でサンドボックス Docker 設定が構成されている場合、`gateway.nodes.denyCommands` に無効なパターン風/未知のエントリが使用されている場合（正確なノードコマンド名マッチングのみ、シェルテキストフィルタリングではありません）、`gateway.nodes.allowCommands` が明示的に危険なノードコマンドを有効にしている場合、グローバルの `tools.profile="minimal"` がエージェントツールプロファイルによってオーバーライドされている場合、オープンなグループがサンドボックス/ワークスペースガードなしでランタイム/ファイルシステムツールを公開している場合、インストール済みのエクステンションプラグインツールが許容的なツールポリシーの下で到達可能な場合にも警告します。
`gateway.allowRealIpFallback=true`（プロキシの設定ミスによるヘッダースプーフィングリスク）や `discovery.mdns.mode="full"`（mDNS TXT レコードによるメタデータ漏洩）もフラグ付けします。
また、サンドボックスブラウザが Docker の `bridge` ネットワークを `sandbox.browser.cdpSourceRange` なしで使用している場合にも警告します。
危険なサンドボックス Docker ネットワークモード（`host` や `container:*` ネームスペースジョインを含む）もフラグ付けします。
既存のサンドボックスブラウザの Docker コンテナにハッシュラベルが欠落/陳腐化している場合（例: マイグレーション前のコンテナに `openclaw.browserConfigEpoch` がない）にも警告し、`openclaw sandbox recreate --browser --all` を推奨します。
npm ベースのプラグイン/フックインストールレコードが固定されていない場合、整合性メタデータが欠落している場合、または現在インストールされているパッケージバージョンと異なる場合にも警告します。
チャンネル許可リストが安定した ID ではなく可変の名前/メール/タグに依存している場合にも警告します（Discord、Slack、Google Chat、MS Teams、Mattermost、該当する場合は IRC スコープ）。
`gateway.auth.mode="none"` が Gateway HTTP API を共有シークレットなしで到達可能にしている場合（`/tools/invoke` および有効な `/v1/*` エンドポイント）にも警告します。
`dangerous`/`dangerously` で始まる設定は明示的なブレークグラスオペレーターオーバーライドです。これを有効にすること自体はセキュリティ脆弱性の報告ではありません。
危険なパラメーターの完全な一覧については、[セキュリティ](/gateway/security) の「安全でないまたは危険なフラグの概要」セクションを参照してください。

## JSON 出力

CI/ポリシーチェックには `--json` を使用します:

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

`--fix` と `--json` を組み合わせた場合、出力には修正アクションと最終レポートの両方が含まれます:

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## `--fix` が変更するもの

`--fix` は安全で決定的な修復を適用します:

- よくある `groupPolicy="open"` を `groupPolicy="allowlist"` に変更します（対応チャンネルのアカウントバリアントを含む）
- `logging.redactSensitive` を `"off"` から `"tools"` に設定します
- ステート/設定と一般的な機密ファイル（`credentials/*.json`、`auth-profiles.json`、`sessions.json`、セッション `*.jsonl`）の権限を強化します

`--fix` は以下のことを**行いません**:

- トークン/パスワード/API キーのローテーション
- ツールの無効化（`gateway`、`cron`、`exec` 等）
- Gateway のバインド/認証/ネットワーク公開設定の変更
- プラグイン/スキルの削除や書き換え
