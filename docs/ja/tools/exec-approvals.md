---
summary: "Exec 承認、許可リスト、サンドボックス脱出プロンプト"
read_when:
  - Exec 承認または許可リストを設定する場合
  - macOS アプリで Exec 承認の UX を実装する場合
  - サンドボックス脱出プロンプトとその影響を確認する場合
title: "Exec 承認"
---

# Exec 承認

Exec 承認は、サンドボックス化されたエージェントが実ホスト上でコマンドを実行することを許可するための **コンパニオンアプリ / ノードホストのガードレール** です
（`gateway` または `node`）。安全インターロックのようなもので、ポリシー + 許可リスト +（任意の）ユーザー承認のすべてが一致した場合にのみコマンドが許可されます。
Exec 承認は、ツールポリシーおよび昇格ゲーティングに **追加** して適用されます（ただし、elevated が `full` に設定されている場合は承認がスキップされます）。
有効なポリシーは `tools.exec.*` と承認のデフォルトのうち **より厳しい方** です。承認フィールドが省略された場合は `tools.exec` の値が使用されます。
コマンドは、ポリシー+許容リスト + (オプション) ユーザーの承認がすべて同意する場合にのみ許可されます。
Exec の承認はツールポリシーに **追加** され、ゲートが昇格されます (昇格が`full`に設定されていない限り、承認はスキップされます)。
効果的なポリシーは `tools.exec.*` の **stricter** で、承認のデフォルト値です。承認フィールドが省略された場合は、 `tools.exec` 値が使用されます。

コンパニオンアプリの UI が **利用できない** 場合、プロンプトを必要とするリクエストは
**ask フォールバック**（デフォルト: deny）によって解決されます。

## 適用する場所

Exec 承認は、実行ホスト上でローカルに強制されます。

- **gateway host** → ゲートウェイマシン上の `openclaw` プロセス
- **node host** → ノードランナー（macOS コンパニオンアプリまたはヘッドレスノードホスト）

macOS の分離構成:

- **node host service** は、`system.run` をローカル IPC 経由で **macOS アプリ** に転送します。
- **macOS アプリ** は承認を適用し、UI コンテキストでコマンドを実行します。

## 設定と保存場所

承認設定は、実行ホスト上のローカル JSON ファイルに保存されます。

`~/.openclaw/exec-approvals.json`

スキーマ例:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## ポリシーの調整項目

### セキュリティ（`exec.security`）

- **deny**: すべてのホスト exec リクエストをブロックします。
- **allowlist**: 許可リストに含まれるコマンドのみを許可します。
- **full**: すべてを許可します（elevated と同等）。

### Ask（`exec.ask`）

- **off**: プロンプトを表示しません。
- **on-miss**: 許可リストに一致しない場合のみプロンプトを表示します。
- **always**: すべてのコマンドでプロンプトを表示します。

### Ask フォールバック（`askFallback`）

プロンプトが必要だが UI に到達できない場合、フォールバックで判断します。

- **deny**: ブロックします。
- **allowlist**: 許可リストに一致する場合のみ許可します。
- **full**: 許可します。

## 許可リスト（エージェント単位）

許可リストは**エージェントごと**です。 18. 複数のエージェントが存在する場合は、
macOS アプリで編集するエージェントを切り替えてください。 パターンは**大文字と小文字を区別しないグローブマッチ**です。
パターンは **バイナリパス** に解決する必要があります (basename-only エントリは無視されます)。
従来の `agents.default` エントリはロード時に `agents.main` に移行されます。

例:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

各許可リストエントリには次の情報が追跡されます。

- **id**: UI 識別用の安定した UUID（任意）
- **last used**: 最終使用時刻
- **last used command**
- **last resolved path**

## Skills CLI の自動許可

**Auto-allow skill CLIs** を有効にすると、既知の Skills によって参照される実行ファイルは、
ノード（macOS ノードまたはヘッドレスノードホスト）上で許可リスト済みとして扱われます。
これは Gateway RPC 経由で `skills.bins` を使用して skill の bin リストを取得します。
厳密な手動許可リストを使用したい場合は、これを無効にしてください。 ゲートウェイRPC上でスキルビンのリストを取得するために、
`skills.bins` を使用します。 厳密な手動の許可が必要な場合はこれを無効にしてください。

## セーフ bin（stdin のみ）

`tools.exec.safeBins` は、明示的な許可リストエントリ **なし** でも
許可リストモードで実行できる **stdin のみ** のバイナリ（例: `jq`）の小さな一覧を定義します。
セーフ bin は位置指定のファイル引数やパスのようなトークンを拒否するため、入力ストリームに対してのみ動作します。
シェルチェーンやリダイレクトは、許可リストモードでは自動許可されません。 安全なビンは
位置ファイルの引数とパスライクなトークンを拒否します。そのため、受信ストリームでのみ動作できます。
シェルチェーンとリダイレクトは許可リストモードでは自動的に許可されません。

シェルチェーン（`&&`、`||`、`;`）は、
各トップレベルのセグメントが許可リスト（セーフ bin または Skills の自動許可を含む）を満たす場合に許可されます。
リダイレクトは許可リストモードでは引き続きサポートされません。
コマンド置換（`$()` / バッククォート）は、ダブルクォート内を含め、
許可リストの解析中に拒否されます。リテラルな `$()` テキストが必要な場合は、シングルクォートを使用してください。 リダイレクトは許可リストモードではサポートされていません。
コマンド置換(`$()` / backticks)は許可リストの解析中に拒否されます。
二重引用符を含みます。`$()` テキスト文字列が必要な場合は単一引用符を使用します。

デフォルトのセーフ bin: `jq`、`grep`、`cut`、`sort`、`uniq`、`head`、`tail`、`tr`、`wc`。

## Control UI での編集

**Control UI → Nodes → Exec 承認** カードを使用して、デフォルト、エージェント単位の
オーバーライド、および許可リストを編集します。スコープ（Defaults またはエージェント）を選択し、
ポリシーを調整し、許可リストパターンを追加または削除してから **Save** をクリックします。
UI には各パターンの **last used** メタデータが表示されるため、一覧を整理できます。 スコープ（デフォルトまたはエージェント）を選択し、ポリシーを微調整します。
許可リストパターンを追加/削除し、**保存**。 UIは**最後に使用された**メタデータ
をパターンごとに表示するので、リストを整理できます。

ターゲットセレクターは **Gateway** (ローカル承認) または **Node** を選択します。 ノード
は `system.execApprovals.get/set` (macOS アプリまたはヘッドレスノードホスト) を宣伝する必要があります。
ターゲットセレクターで **Gateway**（ローカル承認）または **Node** を選択します。
ノードは `system.execApprovals.get/set` をアドバタイズしている必要があります（macOS アプリまたはヘッドレスノードホスト）。
ノードがまだ exec 承認をアドバタイズしていない場合は、
ローカルの `~/.openclaw/exec-approvals.json` を直接編集してください。

CLI: `openclaw approvals` は、ゲートウェイまたはノードの編集をサポートします
（[Approvals CLI](/cli/approvals) を参照）。

## 承認フロー

プロンプトが必要な場合、ゲートウェイは `exec.approval.requested` をオペレータクライアントにブロードキャストします。
プロンプトが必要な場合、ゲートウェイは `exec.approval.requested` をオペレータークライアントにブロードキャストします。
Control UI と macOS アプリは `exec.approval.resolve` を介してこれを解決し、その後ゲートウェイは
承認済みのリクエストをノードホストに転送します。

承認が必要な場合は、execツールはすぐに承認IDを返します。 この id を
に使用すると、後のシステムイベント (`Exec finished` / `Exec denied` ) が関連付けられます。
タイムアウトまでに決定が到達しない場合、リクエストは承認のタイムアウトとして扱われ、拒否の理由として浮上します。

確認ダイアログには次の情報が含まれます。

- command + args
- cwd
- agent id
- 解決された実行ファイルパス
- ホスト + ポリシーメタデータ

アクション:

- **Allow once** → 今回のみ実行
- **Always allow** → 許可リストに追加して実行
- **Deny** → ブロック

## チャットチャンネルへの承認転送

Exec 承認プロンプトは、任意のチャットチャンネル（プラグインチャンネルを含む）に転送でき、
`/approve` で承認できます。これは通常のアウトバウンド配信パイプラインを使用します。 これは通常のアウトバウンド配送パイプラインを使用します。

設定:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

チャットでの返信:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC フロー

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

セキュリティに関する注記:

- Unix ソケットモードは `0600`、トークンは `exec-approvals.json` に保存されます。
- 同一 UID のピアチェック。
- チャレンジ / レスポンス（nonce + HMAC トークン + リクエストハッシュ）と短い TTL。

## システムイベント

Exec のライフサイクルは、システムメッセージとして通知されます。

- `Exec running`（コマンドが実行中通知のしきい値を超えた場合のみ）
- `Exec finished`
- `Exec denied`

これらは、ノードがイベントを報告した後、エージェントのセッションに投稿されます。
Gateway-host exec の承認は、コマンドが終了したとき(および必要に応じてしきい値より長い実行時に)同じライフサイクルイベントを発行します。
Approval-gated実行者は、これらのメッセージ内の`runId`として承認IDを再利用し、簡単な相関を得ます。

## 影響

- **full** は強力です。可能な限り許可リストを優先してください。
- **ask** を使用すると、迅速な承認を維持しつつ状況を把握できます。
- エージェント単位の許可リストにより、あるエージェントの承認が他に漏れるのを防げます。
- 承認は、**authorized senders** からのホスト exec リクエストにのみ適用されます。
  未承認の送信者は `/exec` を発行できません。 許可されていない送信者は `/exec` を発行できません。
- `/exec security=full` は、許可されたオペレーター向けのセッションレベルの利便機能であり、設計上承認をスキップします。
  ホスト exec を厳密にブロックするには、承認のセキュリティを `deny` に設定するか、
  ツールポリシーで `exec` ツールを deny してください。
  ホストの実行をハードブロックするには、承認セキュリティを`deny`に設定するか、ツールポリシーで`exec`ツールを拒否します。

関連:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
