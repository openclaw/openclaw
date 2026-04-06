---
read_when:
    - エージェントワークスペースやそのファイルレイアウトについて説明する必要がある場合
    - エージェントワークスペースをバックアップまたは移行したい場合
summary: 'エージェントワークスペース: 場所、レイアウト、バックアップ戦略'
title: エージェントワークスペース
x-i18n:
    generated_at: "2026-04-02T07:36:53Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 979f3827cb7d950c93060f866e130507a851454a00a89b75e92609206719eae3
    source_path: concepts/agent-workspace.md
    workflow: 15
---

# エージェントワークスペース

ワークスペースはエージェントのホームです。ファイルツールやワークスペースコンテキストで使用される唯一の作業ディレクトリです。プライベートに保ち、メモリとして扱ってください。

これは設定、認証情報、セッションを保存する `~/.openclaw/` とは別のものです。

**重要:** ワークスペースは**デフォルトのcwd**であり、厳密なサンドボックスではありません。ツールはワークスペースを基準に相対パスを解決しますが、サンドボックス化が有効でない限り、絶対パスでホスト上の他の場所にアクセスできます。分離が必要な場合は、[`agents.defaults.sandbox`](/gateway/sandboxing)（および/またはエージェントごとのサンドボックス設定）を使用してください。
サンドボックス化が有効で `workspaceAccess` が `"rw"` でない場合、ツールはホストのワークスペースではなく `~/.openclaw/sandboxes` 配下のサンドボックスワークスペース内で動作します。

## デフォルトの場所

- デフォルト: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE` が設定されていて `"default"` でない場合、デフォルトは
  `~/.openclaw/workspace-<profile>` になります。
- `~/.openclaw/openclaw.json` でオーバーライド:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure`、または `openclaw setup` を実行すると、ワークスペースが作成され、ブートストラップファイルが存在しない場合はシードされます。
サンドボックスのシードコピーは、通常のワークスペース内ファイルのみを受け入れます。ソースワークスペース外に解決されるシンボリックリンク/ハードリンクのエイリアスは無視されます。

ワークスペースファイルを自分で管理している場合は、ブートストラップファイルの作成を無効にできます:

```json5
{ agent: { skipBootstrap: true } }
```

## 追加のワークスペースフォルダ

古いインストールでは `~/openclaw` が作成されている場合があります。複数のワークスペースディレクトリを残しておくと、一度にアクティブなワークスペースは1つだけであるため、認証や状態のずれが発生し混乱を招く可能性があります。

**推奨:** アクティブなワークスペースは1つだけにしてください。追加のフォルダが不要な場合は、アーカイブするかゴミ箱に移動してください（例: `trash ~/openclaw`）。意図的に複数のワークスペースを維持する場合は、`agents.defaults.workspace` がアクティブなものを指していることを確認してください。

`openclaw doctor` は追加のワークスペースディレクトリを検出すると警告を表示します。

## ワークスペースファイルマップ（各ファイルの意味）

OpenClawがワークスペース内に想定する標準ファイルは以下の通りです:

- `AGENTS.md`
  - エージェントの操作手順とメモリの使い方。
  - 毎セッションの開始時に読み込まれます。
  - ルール、優先事項、「どう振る舞うか」の詳細を記述するのに適した場所です。

- `SOUL.md`
  - ペルソナ、トーン、境界。
  - 毎セッション読み込まれます。

- `USER.md`
  - ユーザーが誰であるか、どう呼びかけるか。
  - 毎セッション読み込まれます。

- `IDENTITY.md`
  - エージェントの名前、雰囲気、絵文字。
  - ブートストラップリチュアル中に作成/更新されます。

- `TOOLS.md`
  - ローカルツールと慣例に関するメモ。
  - ツールの利用可否を制御するものではなく、ガイダンスのみです。

- `HEARTBEAT.md`
  - ハートビート実行用のオプションの簡潔なチェックリスト。
  - トークン消費を避けるため短く保ってください。

- `BOOT.md`
  - 内部フックが有効な場合に Gateway ゲートウェイの再起動時に実行されるオプションの起動チェックリスト。
  - 短く保ってください。送信にはメッセージツールを使用してください。

- `BOOTSTRAP.md`
  - 初回実行のワンタイムリチュアル。
  - 新しいワークスペースに対してのみ作成されます。
  - リチュアル完了後に削除してください。

- `memory/YYYY-MM-DD.md`
  - デイリーメモリログ（1日1ファイル）。
  - セッション開始時に今日と昨日のファイルを読むことを推奨します。

- `MEMORY.md`（オプション）
  - キュレーションされた長期記憶。
  - メインのプライベートセッションでのみ読み込んでください（共有/グループコンテキストでは読み込まないでください）。

ワークフローと自動メモリフラッシュについては[メモリ](/concepts/memory)を参照してください。

- `skills/`（オプション）
  - ワークスペース固有の Skills。
  - 名前が衝突した場合、マネージド/バンドル Skills をオーバーライドします。

- `canvas/`（オプション）
  - ノード表示用のキャンバスUIファイル（例: `canvas/index.html`）。

ブートストラップファイルが欠けている場合、OpenClawはセッションに「missing file」マーカーを挿入して処理を続行します。大きなブートストラップファイルは挿入時に切り詰められます。制限は `agents.defaults.bootstrapMaxChars`（デフォルト: 20000）と `agents.defaults.bootstrapTotalMaxChars`（デフォルト: 150000）で調整できます。
`openclaw setup` は既存のファイルを上書きせずに、欠けているデフォルトファイルを再作成できます。

## ワークスペースに含まれないもの

以下は `~/.openclaw/` 配下にあり、ワークスペースリポジトリにコミットすべきではありません:

- `~/.openclaw/openclaw.json`（設定）
- `~/.openclaw/credentials/`（OAuthトークン、APIキー）
- `~/.openclaw/agents/<agentId>/sessions/`（セッションのトランスクリプト + メタデータ）
- `~/.openclaw/skills/`（マネージド Skills）

セッションや設定を移行する必要がある場合は、別途コピーし、バージョン管理の対象外にしてください。

## Gitバックアップ（推奨、プライベート）

ワークスペースはプライベートなメモリとして扱ってください。バックアップと復元が可能になるよう、**プライベート**なgitリポジトリに入れてください。

以下の手順は Gateway ゲートウェイが実行されているマシン（ワークスペースが存在する場所）で実行してください。

### 1) リポジトリの初期化

gitがインストールされている場合、新しいワークスペースは自動的に初期化されます。このワークスペースがまだリポジトリでない場合は、以下を実行してください:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) プライベートリモートの追加（初心者向けオプション）

オプションA: GitHub Web UI

1. GitHubで新しい**プライベート**リポジトリを作成します。
2. READMEで初期化しないでください（マージコンフリクトを避けるため）。
3. HTTPSリモートURLをコピーします。
4. リモートを追加してプッシュします:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

オプションB: GitHub CLI（`gh`）

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

オプションC: GitLab Web UI

1. GitLabで新しい**プライベート**リポジトリを作成します。
2. READMEで初期化しないでください（マージコンフリクトを避けるため）。
3. HTTPSリモートURLをコピーします。
4. リモートを追加してプッシュします:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) 継続的な更新

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## シークレットをコミットしない

プライベートリポジトリであっても、ワークスペースにシークレットを保存しないでください:

- APIキー、OAuthトークン、パスワード、プライベート認証情報。
- `~/.openclaw/` 配下のすべてのもの。
- チャットの生データや機密性の高い添付ファイル。

機密情報の参照を保存する必要がある場合は、プレースホルダーを使用し、実際のシークレットは別の場所（パスワードマネージャー、環境変数、または `~/.openclaw/`）に保管してください。

推奨 `.gitignore` のスターター:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## ワークスペースを新しいマシンに移動する

1. リポジトリを目的のパス（デフォルト `~/.openclaw/workspace`）にクローンします。
2. `~/.openclaw/openclaw.json` で `agents.defaults.workspace` をそのパスに設定します。
3. `openclaw setup --workspace <path>` を実行して、欠けているファイルをシードします。
4. セッションが必要な場合は、古いマシンから `~/.openclaw/agents/<agentId>/sessions/` を別途コピーします。

## 上級者向けメモ

- マルチエージェントルーティングでは、エージェントごとに異なるワークスペースを使用できます。ルーティング設定については[チャネルルーティング](/channels/channel-routing)を参照してください。
- `agents.defaults.sandbox` が有効な場合、メイン以外のセッションは `agents.defaults.sandbox.workspaceRoot` 配下のセッションごとのサンドボックスワークスペースを使用できます。

## 関連

- [スタンディングオーダー](/automation/standing-orders) — ワークスペースファイル内の永続的な指示
- [ハートビート](/gateway/heartbeat) — HEARTBEAT.md ワークスペースファイル
- [セッション](/concepts/session) — セッション保存パス
- [サンドボックス化](/gateway/sandboxing) — サンドボックス化環境でのワークスペースアクセス
