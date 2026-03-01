---
summary: "Exec承認、許可リスト、サンドボックスエスケーププロンプト"
read_when:
  - exec承認または許可リストの設定時
  - macOSアプリでのexec承認UXの実装時
  - サンドボックスエスケーププロンプトとその意味のレビュー時
title: "Exec承認"
---

# Exec承認

Exec承認は、サンドボックス化されたエージェントが実際のホスト（`gateway` または `node`）でコマンドを実行できるようにするための**コンパニオンアプリ / ノードホストの安全インターロック**です。コマンドはポリシー + 許可リスト +（オプションの）ユーザー承認のすべてが同意した場合にのみ許可されます。
Exec承認はツールポリシーとelevatedゲーティングに**加えて**行われます（elevatedが `full` に設定されている場合は承認をスキップします）。
有効なポリシーは `tools.exec.*` と承認デフォルトの**厳しい方**です。承認フィールドが省略されている場合、`tools.exec` の値が使用されます。

コンパニオンアプリUIが**利用できない**場合、プロンプトを必要とするリクエストは**askフォールバック**（デフォルト: 拒否）によって解決されます。

## 適用場所

Exec承認は実行ホストでローカルに適用されます:

- **Gatewayホスト** → Gatewayマシンの `openclaw` プロセス
- **ノードホスト** → ノードランナー（macOSコンパニオンアプリまたはヘッドレスノードホスト）

トラストモデルの注意:

- Gateway認証された呼び出し元は、そのGatewayの信頼されたオペレーターです。
- ペアリングされたノードはノードホストへの信頼されたオペレーター機能を拡張します。
- Exec承認は偶発的な実行リスクを低減しますが、ユーザーごとの認証境界ではありません。

macOSの分割:

- **ノードホストサービス**がローカルIPCを通じて `system.run` を**macOSアプリ**に転送します。
- **macOSアプリ**がUIコンテキストで承認を適用してコマンドを実行します。

## 設定とストレージ

承認は実行ホスト上のローカルJSONファイルに保存されます:

`~/.openclaw/exec-approvals.json`

スキーマの例:

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

## ポリシー設定

### セキュリティ（`exec.security`）

- **deny**: すべてのホストexecリクエストをブロックします。
- **allowlist**: 許可リストに登録されたコマンドのみ許可します。
- **full**: すべてを許可します（elevatedと同等）。

### Ask（`exec.ask`）

- **off**: プロンプトを表示しません。
- **on-miss**: 許可リストが一致しない場合のみプロンプトを表示します。
- **always**: すべてのコマンドでプロンプトを表示します。

### Askフォールバック（`askFallback`）

プロンプトが必要だがUIに到達できない場合、フォールバックが決定します:

- **deny**: ブロックします。
- **allowlist**: 許可リストが一致する場合のみ許可します。
- **full**: 許可します。

## 許可リスト（エージェントごと）

許可リストは**エージェントごと**です。複数のエージェントが存在する場合は、macOSアプリで編集するエージェントを切り替えてください。パターンは**大文字小文字を区別しないglobマッチ**です。
パターンは**バイナリパス**に解決される必要があります（ベース名のみのエントリは無視されます）。
レガシーの `agents.default` エントリはロード時に `agents.main` に移行されます。

例:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

各許可リストエントリは以下を追跡します:

- **id** UIアイデンティティに使用される安定したUUID（オプション）
- **最終使用**タイムスタンプ
- **最終使用コマンド**
- **最終解決パス**

## スキルCLIの自動許可

**スキルCLIを自動許可**が有効な場合、既知のスキルによって参照される実行ファイルがノード（macOSノードまたはヘッドレスノードホスト）で許可リストに登録されたものとして扱われます。これはGateway RPC経由で `skills.bins` を使用してスキルbinリストを取得します。厳格な手動許可リストが必要な場合はこれを無効化してください。

重要なトラストの注意:

- これは**暗黙の便宜的許可リスト**であり、手動パス許可リストエントリとは別です。
- GatewayとノードがTailnetにある場合など、信頼されたオペレーター環境を想定しています。
- 厳格な明示的トラストが必要な場合は `autoAllowSkills: false` を保持し、手動パス許可リストエントリのみを使用してください。

## セーフbin（stdin専用）

`tools.exec.safeBins` は明示的な許可リストエントリなしに許可リストモードで実行できる**stdin専用**バイナリの小さなリスト（例: `jq`）を定義します。セーフbinは位置ファイル引数とパスのようなトークンを拒否するため、受信ストリームのみで操作できます。
これはストリームフィルター向けの狭いファストパスとして扱ってください。一般的なトラストリストではありません。
インタープリターまたはランタイムバイナリ（例: `python3`、`node`、`ruby`、`bash`、`sh`、`zsh`）を `safeBins` に追加しないでください。
コマンドがコードを評価したり、サブコマンドを実行したり、設計上ファイルを読み込める場合は、明示的な許可リストエントリを優先して承認プロンプトを有効のままにしてください。
カスタムセーフbinは `tools.exec.safeBinProfiles.<bin>` で明示的なプロファイルを定義する必要があります。
検証はargvシェイプのみから決定論的に行われます（ホストファイルシステムの存在チェックなし）。これにより、許可/拒否の違いによるファイル存在オラクル動作を防ぎます。
ファイル指向オプションはデフォルトのセーフbinで拒否されます（例: `sort -o`、`sort --output`、
`sort --files0-from`、`sort --compress-program`、`sort --random-source`、
`sort --temporary-directory`/`-T`、`wc --files0-from`、`jq -f/--from-file`、
`grep -f/--file`）。
セーフbinはstdin専用の動作を壊すオプションに対して、バイナリごとに明示的なフラグポリシーも適用します（例: `sort -o/--output/--compress-program` とgrepの再帰フラグ）。
長いオプションはセーフbinモードでフェールクローズで検証されます: 未知のフラグと曖昧な略語は拒否されます。
セーフbinプロファイルによって拒否されるフラグ:

<!-- SAFE_BIN_DENIED_FLAGS:START -->

- `grep`: `--dereference-recursive`, `--directories`, `--exclude-from`, `--file`, `--recursive`, `-R`, `-d`, `-f`, `-r`
- `jq`: `--argfile`, `--from-file`, `--library-path`, `--rawfile`, `--slurpfile`, `-L`, `-f`
- `sort`: `--compress-program`, `--files0-from`, `--output`, `--random-source`, `--temporary-directory`, `-T`, `-o`
- `wc`: `--files0-from`
<!-- SAFE_BIN_DENIED_FLAGS:END -->

セーフbinはstdin専用セグメントの実行時にargvトークンを**リテラルテキスト**として扱います（globbing なし、`$VARS` 展開なし）。したがって、`*` や `$HOME/...` のようなパターンはファイル読み込みの密輸に使用できません。
セーフbinはまた、信頼できるバイナリディレクトリ（システムデフォルトにオプションの `tools.exec.safeBinTrustedDirs` を加えたもの）から解決される必要があります。`PATH` エントリは自動的に信頼されません。
デフォルトの信頼済みセーフbinディレクトリは意図的に最小限です: `/bin`、`/usr/bin`。
セーフbin実行ファイルがパッケージマネージャー/ユーザーパス（例: `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`/snap/bin`）にある場合は、`tools.exec.safeBinTrustedDirs` に明示的に追加してください。
シェルチェーンとリダイレクトは許可リストモードで自動許可されません。

シェルチェーン（`&&`、`||`、`;`）は、すべてのトップレベルセグメントが許可リストを満たす場合に許可されます（セーフbinまたはスキル自動許可を含む）。リダイレクトは許可リストモードでは引き続きサポートされません。
コマンド置換（`$()` / バックティック）は許可リスト解析中に拒否されます。二重引用符の内側も含みます。リテラルの `$()` テキストが必要な場合はシングルクォートを使用してください。
macOSコンパニオンアプリの承認では、シェル制御または展開構文（`&&`、`||`、`;`、`|`、`` ` ``、`$`、`<`、`>`、`(`、`)`）を含む生のシェルテキストは、シェルバイナリ自体が許可リストに登録されていない限り許可リストミスとして扱われます。
シェルラッパー（`bash|sh|zsh ... -c/-lc`）では、リクエストスコープの環境オーバーライドは小さな明示的許可リスト（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）に縮小されます。
許可リストモードでの常に許可決定では、既知のディスパッチラッパー（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）はラッパーパスではなく内部実行ファイルパスを保存します。シェルマルチプレクサー（`busybox`、`toybox`）もシェルアプレット（`sh`、`ash` など）についてアンラップされるため、マルチプレクサーバイナリではなく内部実行ファイルが保存されます。ラッパーまたはマルチプレクサーを安全にアンラップできない場合、許可リストエントリは自動的に保存されません。

デフォルトのセーフbin: `jq`、`cut`、`uniq`、`head`、`tail`、`tr`、`wc`。

`grep` と `sort` はデフォルトリストに含まれていません。オプトインする場合は、非stdinワークフロー用の明示的な許可リストエントリを保持してください。
セーフbinモードの `grep` では、`-e`/`--regexp` でパターンを指定してください。位置パターン形式は拒否されるため、ファイルオペランドを曖昧な位置引数として密輸できません。

### セーフbin vs 許可リスト

| トピック         | `tools.exec.safeBins`                           | 許可リスト（`exec-approvals.json`）                       |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------- |
| 目的             | 狭いstdinフィルターを自動許可する                | 特定の実行ファイルを明示的に信頼する                       |
| マッチタイプ     | 実行ファイル名 + セーフbinのargvポリシー         | 解決済み実行ファイルパスのglobパターン                    |
| 引数スコープ     | セーフbinプロファイルとリテラルトークンルールで制限 | パスマッチのみ。引数は自己責任                            |
| 典型的な例       | `jq`、`head`、`tail`、`wc`                     | `python3`、`node`、`ffmpeg`、カスタムCLI                 |
| 最適な用途       | パイプライン内の低リスクテキスト変換             | より広い動作または副作用を持つツール                       |

設定場所:

- `safeBins` はコンフィグから取得します（`tools.exec.safeBins` またはエージェントごとの `agents.list[].tools.exec.safeBins`）。
- `safeBinTrustedDirs` はコンフィグから取得します（`tools.exec.safeBinTrustedDirs` またはエージェントごとの `agents.list[].tools.exec.safeBinTrustedDirs`）。
- `safeBinProfiles` はコンフィグから取得します（`tools.exec.safeBinProfiles` またはエージェントごとの `agents.list[].tools.exec.safeBinProfiles`）。エージェントごとのプロファイルキーはグローバルキーをオーバーライドします。
- 許可リストエントリはホストローカルの `~/.openclaw/exec-approvals.json` の `agents.<id>.allowlist` 下に存在します（またはControl UI / `openclaw approvals allowlist ...` 経由）。
- `openclaw security audit` は `safeBins` にインタープリター/ランタイムbinが明示的なプロファイルなしで含まれている場合に `tools.exec.safe_bins_interpreter_unprofiled` で警告します。
- `openclaw doctor --fix` は欠落しているカスタム `safeBinProfiles.<bin>` エントリを `{}` としてスキャフォールドできます（その後レビューして絞り込んでください）。インタープリター/ランタイムbinは自動スキャフォールドされません。

カスタムプロファイルの例:

```json5
{
  tools: {
    exec: {
      safeBins: ["jq", "myfilter"],
      safeBinProfiles: {
        myfilter: {
          minPositional: 0,
          maxPositional: 0,
          allowedValueFlags: ["-n", "--limit"],
          deniedFlags: ["-f", "--file", "-c", "--command"],
        },
      },
    },
  },
}
```

## コントロールUIでの編集

**Control UI → Nodes → Exec approvals** カードを使用してデフォルト、エージェントごとのオーバーライド、許可リストを編集します。スコープ（デフォルトまたはエージェント）を選択し、ポリシーを調整し、許可リストパターンを追加/削除してから**保存**してください。UIはパターンごとの**最終使用**メタデータを表示するため、リストを整理できます。

ターゲットセレクターは**Gateway**（ローカル承認）または**Node**を選択します。ノードは `system.execApprovals.get/set` をアドバタイズする必要があります（macOSアプリまたはヘッドレスノードホスト）。
ノードがまだexec承認をアドバタイズしていない場合は、そのローカルの `~/.openclaw/exec-approvals.json` を直接編集してください。

CLI: `openclaw approvals` はGatewayまたはノードの編集をサポートしています（[Approvals CLI](/cli/approvals) を参照）。

## 承認フロー

プロンプトが必要な場合、GatewayはオペレータークライアントにEvent `exec.approval.requested` をブロードキャストします。
Control UIとmacOSアプリは `exec.approval.resolve` を通じて解決し、Gatewayは承認済みリクエストをノードホストに転送します。

承認が必要な場合、execツールは承認IDとともに即座に返されます。そのIDを使用して後のシステムイベント（`Exec finished` / `Exec denied`）と相関させます。タイムアウト前に決定が届かない場合、リクエストは承認タイムアウトとして扱われ、拒否理由として表示されます。

確認ダイアログには以下が含まれます:

- コマンド + 引数
- cwd
- エージェントID
- 解決済み実行ファイルパス
- ホスト + ポリシーメタデータ

アクション:

- **一度だけ許可** → 今すぐ実行
- **常に許可** → 許可リストに追加して実行
- **拒否** → ブロック

## チャットチャンネルへの承認転送

Exec承認プロンプトを任意のチャットチャンネル（プラグインチャンネルを含む）に転送して、`/approve` で承認できます。これは通常のアウトバウンド配信パイプラインを使用します。

設定:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // 部分文字列または正規表現
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

### macOS IPCフロー

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

セキュリティの注意:

- Unixソケットモード `0600`、トークンは `exec-approvals.json` に保存。
- 同じUIDのピアチェック。
- チャレンジ/レスポンス（ノンス + HMACトークン + リクエストハッシュ）+ 短いTTL。

## システムイベント

Execライフサイクルはシステムメッセージとして表示されます:

- `Exec running`（コマンドが実行中通知のしきい値を超えた場合のみ）
- `Exec finished`
- `Exec denied`

これらはノードがイベントを報告した後、エージェントのセッションに投稿されます。
Gatewayホストのexec承認は、コマンドが終了したとき（およびオプションでしきい値を超えて実行されているとき）に同じライフサイクルイベントを発行します。
承認ゲートされたexecは、相関しやすいように承認IDをこれらのメッセージの `runId` として再利用します。

## 意味合い

- **full** は強力です。可能な限り許可リストを優先してください。
- **ask** はあなたをループに保ちながら、高速な承認を可能にします。
- エージェントごとの許可リストは、あるエージェントの承認が他のエージェントに漏れるのを防ぎます。
- 承認は**認証済み送信者**からのホストexecリクエストにのみ適用されます。未認証の送信者は `/exec` を発行できません。
- `/exec security=full` は認証済みオペレーター向けのセッションレベルの便宜機能であり、設計上承認をスキップします。
  ホストexecを完全にブロックするには、承認セキュリティを `deny` に設定するか、ツールポリシーで `exec` ツールを拒否してください。

関連:

- [Execツール](/tools/exec)
- [Elevatedモード](/tools/elevated)
- [スキル](/tools/skills)
