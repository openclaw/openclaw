---
summary: "エージェント ワークスペース：場所、レイアウト、バックアップ戦略"
read_when:
  - エージェント ワークスペースやそのファイル レイアウトを説明する必要がある場合
  - エージェント ワークスペースをバックアップまたは移行したい場合
title: "エージェント ワークスペース"
---

# エージェント ワークスペース

ワークスペースはエージェントの家です。 ワークスペースはエージェントのホームです。ファイル ツールおよびワークスペース コンテキストで使用される唯一の作業ディレクトリです。プライベートに保ち、メモリとして扱ってください。 プライベートにしておき、メモリとして扱います。

これは、設定、資格情報、セッションを保存する `~/.openclaw/` とは別です。

**重要：** ワークスペースは **デフォルトの cwd** で、ハードサンドボックスではありません。 12. ツールは相対パスをワークスペースに対して解決しますが、サンドボックスが有効でない限り、絶対パスはホスト上の他の場所にも到達できます。 分離が必要な場合は、
[`agents.defaults.sandbox`](/gateway/sandboxing) (または per‐agent sandbox 設定) を使用してください。
**重要:** ワークスペースは **デフォルトの cwd** であり、厳密なサンドボックスではありません。ツールは相対パスをワークスペース基準で解決しますが、サンドボックス化が有効でない限り、絶対パスはホスト上の他の場所に到達できます。分離が必要な場合は、[`agents.defaults.sandbox`](/gateway/sandboxing)（および／またはエージェントごとのサンドボックス設定）を使用してください。サンドボックス化が有効で、かつ `workspaceAccess` が `"rw"` でない場合、ツールはホストのワークスペースではなく、`~/.openclaw/sandboxes` 配下のサンドボックス ワークスペース内で動作します。

## デフォルトの場所

- デフォルト: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE` が設定され、かつ `"default"` でない場合、デフォルトは
  `~/.openclaw/workspace-<profile>` になります。
- `~/.openclaw/openclaw.json` で上書きできます:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure`、または `openclaw setup` は、ワークスペースを作成し、欠落している場合にブートストラップ ファイルをシードします。

すでにワークスペース ファイルを自分で管理している場合は、ブートストラップ ファイルの作成を無効にできます:

```json5
{ agent: { skipBootstrap: true } }
```

## 追加のワークスペース フォルダー

古いインストールでは`~/openclaw`が作成されている可能性があります。 複数のワークスペース
ディレクトリを保持すると、一度に 1 つの
ワークスペースだけがアクティブになっているため、認証や状態のドリフトを引き起こす可能性があります。

**推奨：** 1つのアクティブなワークスペースを保持します。
の追加フォルダを使用しない場合は、アーカイブまたはゴミ箱に移動します(例えば、 `trash ~/openclaw`)。
**推奨:** 有効なワークスペースは 1 つに保ってください。追加のフォルダーを使用しなくなった場合は、アーカイブするかゴミ箱に移動してください（例: `trash ~/openclaw`）。意図的に複数のワークスペースを保持する場合は、`agents.defaults.workspace` がアクティブなものを指していることを確認してください。

`openclaw doctor` は、追加のワークスペース ディレクトリを検出すると警告します。

## ワークスペース ファイル マップ（各ファイルの意味）

以下は、OpenClaw がワークスペース内に期待する標準ファイルです。

- `AGENTS.md`
  - エージェントの運用指示と、メモリの使用方法。
  - 各セッションの開始時に読み込まれます。
  - ルール、優先順位、「どのように振る舞うか」の詳細に適した場所です。

- `SOUL.md`
  - ペルソナ、トーン、境界。
  - 各セッションで読み込まれます。

- `USER.md`
  - ユーザーが誰で、どのように呼びかけるか。
  - 各セッションで読み込まれます。

- `IDENTITY.md`
  - エージェントの名前、雰囲気、絵文字。
  - ブートストラップの儀式中に作成/更新されます。

- `TOOLS.md`
  - ローカル ツールや慣習に関するメモ。
  - ツールの可用性を制御するものではなく、ガイダンスのみです。

- `HEARTBEAT.md`
  - ハートビート実行用の任意の小さなチェックリスト。
  - トークン消費を避けるため、短く保ってください。

- `BOOT.md`
  - 内部フックが有効な場合に、Gateway 再起動時に実行される任意の起動チェックリスト。
  - 短く保ち、送信には message ツールを使用してください。

- `BOOTSTRAP.md`
  - ワンタイムファーストランの儀式。
  - 新規ワークスペースにのみ作成されます。
  - 儀式が完了した後に削除します。

- `memory/YYYY-MM-DD.md`
  - 日次メモリ ログ（1 日 1 ファイル）。
  - セッション開始時に「今日＋昨日」を読むことを推奨します。

- `MEMORY.md`（任意）
  - キュレーションされた長期メモリ。
  - メインのプライベート セッションでのみ読み込みます（共有／グループ コンテキストでは不可）。

ワークフローと自動メモリ フラッシュについては [Memory](/concepts/memory) を参照してください。

- `skills/`（任意）
  - ワークスペース固有の Skills。
  - 名前が衝突した場合、管理／同梱された Skills を上書きします。

- `canvas/`（任意）
  - ノード表示用の Canvas UI ファイル（例: `canvas/index.html`）。

ブートストラップファイルがない場合、OpenClawはセッションに「不足しているファイル」マーカーを
挿入して続行します。
`agents.defaults.bootstrapMaxChars` で制限を調整します (デフォルト: 20000)。
`openclaw setup`は既存の
ファイルを上書きすることなく、不足しているデフォルトを再現できます。

## ワークスペースに含まれないもの

以下は `~/.openclaw/` 配下にあり、ワークスペース リポジトリにコミット **すべきではありません**。

- `~/.openclaw/openclaw.json`（設定）
- `~/.openclaw/credentials/`（OAuth トークン、API キー）
- `~/.openclaw/agents/<agentId>/sessions/`（セッションのトランスクリプト＋メタデータ）
- `~/.openclaw/skills/`（管理された Skills）

セッションや設定を移行する必要がある場合は、別途コピーし、バージョン管理から除外してください。

## Git バックアップ（推奨、プライベート）

ワークスペースをプライベートメモリとして扱います。 ワークスペースはプライベート メモリとして扱ってください。**プライベート** な git リポジトリに入れて、バックアップおよび復旧可能にします。

以下の手順は Gateway（ゲートウェイ）が稼働しているマシンで実行してください（そこにワークスペースがあります）。

### 1. リポジトリを初期化

git がインストールされている場合、完全に新しいワークスペースは自動的に初期化されます。このワークスペースがまだリポジトリでない場合は、次を実行します。 この
ワークスペースがまだリポジトリでない場合は、次を実行します。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. プライベート リモートを追加（初心者向けの選択肢）

オプション A: GitHub Web UI

1. GitHub で **プライベート** リポジトリを新規作成します。
2. README で初期化しないでください（マージ競合を回避）。
3. HTTPS のリモート URL をコピーします。
4. リモートを追加して push します。

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

オプション B: GitHub CLI（`gh`）

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

オプション C: GitLab Web UI

1. GitLab で **プライベート** リポジトリを新規作成します。
2. README で初期化しないでください（マージ競合を回避）。
3. HTTPS のリモート URL をコピーします。
4. リモートを追加して push します。

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. 継続的な更新

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 秘密をコミットしない

プライベート リポジトリであっても、ワークスペースにシークレットを保存することは避けてください。

- API キー、OAuth トークン、パスワード、または私的な資格情報。
- `~/.openclaw/` 配下のものすべて。
- チャットや敏感な添付ファイルの未加工ダンプ。

機密参照を保存する必要がある場合は、プレースホルダーを使用し、実際のシークレットは別の場所（パスワード マネージャー、環境変数、または `~/.openclaw/`）に保管してください。

推奨される `.gitignore` のスターター:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 新しいマシンへのワークスペース移動

1. リポジトリを目的のパスに clone します（デフォルトは `~/.openclaw/workspace`）。
2. `~/.openclaw/openclaw.json` で `agents.defaults.workspace` をそのパスに設定します。
3. `openclaw setup --workspace <path>` を実行して、欠落しているファイルをシードします。
4. セッションが必要な場合は、`~/.openclaw/agents/<agentId>/sessions/` を旧マシンから別途コピーします。

## 高度な注意点

- マルチエージェント ルーティングでは、エージェントごとに異なるワークスペースを使用できます。ルーティング設定については [Channel routing](/channels/channel-routing) を参照してください。 ルーティング設定については、
  [Channel routing](/channels/channel-routing)を参照してください。
- `agents.defaults.sandbox` が有効な場合、メイン以外のセッションは `agents.defaults.sandbox.workspaceRoot` 配下のセッション単位のサンドボックス ワークスペースを使用できます。
