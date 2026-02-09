---
summary: "セッションの一覧表示、履歴の取得、およびセッション間メッセージ送信のためのエージェント セッション ツール"
read_when:
  - セッション ツールの追加または変更時
title: "セッション ツール"
---

# セッション ツール

目的：エージェントがセッションを一覧表示し、履歴を取得し、別のセッションに送信できる、小さく誤用しにくいツール セットを提供します。

## ツール名

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## キー モデル

- メインのダイレクト チャット バケットは、常にリテラル キー `"main"`（現在のエージェントのメイン キーに解決）です。
- グループ チャットは `agent:<agentId>:<channel>:group:<id>` または `agent:<agentId>:<channel>:channel:<id>` を使用します（完全なキーを渡します）。
- Cron ジョブは `cron:<job.id>` を使用します。
- フックは、明示的に設定されていない限り `hook:<uuid>` を使用します。
- ノード セッションは、明示的に設定されていない限り `node-<nodeId>` を使用します。

`global` と `unknown` は予約されており、一覧に表示されません。 `global` と `unknown` は予約値であり、一覧には表示されません。`session.scope = "global"` の場合、すべてのツールで `main` にエイリアスされ、呼び出し側が `global` を目にすることはありません。

## sessions_list

セッションを行の配列として一覧表示します。

パラメータ：

- `kinds?: string[]` フィルター：`"main" | "group" | "cron" | "hook" | "node" | "other"` のいずれか
- `limit?: number` 最大行数（デフォルト：サーバー既定、例：200 にクランプ）
- `activeMinutes?: number` N 分以内に更新されたセッションのみ
- `messageLimit?: number` 0 = メッセージなし（デフォルト 0）；>0 = 直近 N 件のメッセージを含める

挙動：

- `messageLimit > 0` は、セッションごとに `chat.history` を取得し、直近 N 件のメッセージを含めます。
- ツールの結果は一覧出力から除外されます。ツール メッセージには `sessions_history` を使用してください。
- **サンドボックス化された** エージェント セッションで実行している場合、セッション ツールは既定で **spawned-only 可視性**（下記参照）になります。

行の形状（JSON）：

- `key`：セッション キー（string）
- `kind`：`main | group | cron | hook | node | other`
- `channel`：`whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName`（利用可能な場合のグループ表示ラベル）
- `updatedAt`（ms）
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy`（設定されている場合のセッション オーバーライド）
- `lastChannel`、`lastTo`
- `deliveryContext`（利用可能な場合の正規化された `{ channel, to, accountId }`）
- `transcriptPath`（ストア ディレクトリ + sessionId から導出したベストエフォートのパス）
- `messages?`（`messageLimit > 0` の場合のみ）

## sessions_history

1 つのセッションのトランスクリプトを取得します。

パラメータ：

- `sessionKey`（必須；セッション キーまたは `sessions_list` の `sessionId` を受け付けます）
- `limit?: number` 最大メッセージ数（サーバーでクランプ）
- `includeTools?: boolean`（デフォルト false）

挙動：

- `includeTools=false` は `role: "toolResult"` メッセージをフィルターします。
- 生のトランスクリプト形式でメッセージ配列を返します。
- `sessionId` が与えられた場合、OpenClaw は対応するセッション キーに解決します（欠落した id はエラー）。

## sessions_send

別のセッションにメッセージを送信します。

パラメータ：

- `sessionKey`（必須；セッション キーまたは `sessions_list` の `sessionId` を受け付けます）
- `message`（必須）
- `timeoutSeconds?: number`（デフォルト >0；0 = fire-and-forget）

挙動：

- `timeoutSeconds = 0`：キューに入れて `{ runId, status: "accepted" }` を返します。
- `timeoutSeconds > 0`：完了まで最大 N 秒待機し、その後 `{ runId, status: "ok", reply }` を返します。
- 待機がタイムアウトした場合：`{ runId, status: "timeout", error }`。実行は継続され、後で `sessions_history` を呼び出してください。 実行を続けます; 後で `sessions_history` を呼び出します。
- 実行が失敗した場合：`{ runId, status: "error", error }`。
- 配信のアナウンス実行は一次実行の完了後に行われ、ベストエフォートです。`status: "ok"` はアナウンスの配信を保証しません。
- 待機はゲートウェイ `agent.wait`（サーバー側）経由で行われるため、再接続で待機が中断されません。
- 一次実行には、エージェント間メッセージのコンテキストが注入されます。
- 一次実行の完了後、OpenClaw は **reply-back ループ** を実行します：
  - ラウンド2+は、要求者とターゲットエージェントを交互に切り替えます。
  - ping‑pong を停止するには、正確に `REPLY_SKIP` と返信してください。
  - 最大ターン数は `session.agentToAgent.maxPingPongTurns`（0–5、デフォルト 5）です。
- ループ終了後、OpenClaw は **エージェント間アナウンス ステップ**（ターゲット エージェントのみ）を実行します：
  - 何も送信しない場合は、正確に `ANNOUNCE_SKIP` と返信してください。
  - それ以外の返信は、ターゲット チャンネルに送信されます。
  - アナウンス ステップには、元のリクエスト + ラウンド 1 の返信 + 最新の ping‑pong 返信が含まれます。

## チャンネル フィールド

- グループの場合、`channel` はセッション エントリーに記録されたチャンネルです。
- ダイレクト チャットの場合、`channel` は `lastChannel` からマッピングされます。
- cron/hook/node の場合、`channel` は `internal` です。
- 欠落している場合、`channel` は `unknown` です。

## セキュリティ / 送信ポリシー

チャンネル／チャット種別ごとのポリシー ベースのブロック（セッション id ごとではありません）。

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

実行時オーバーライド（セッション エントリーごと）：

- `sendPolicy: "allow" | "deny"`（未設定 = 設定を継承）
- `sessions.patch` またはオーナーのみの `/send on|off|inherit`（スタンドアロン メッセージ）で設定可能。

強制ポイント：

- `chat.send` / `agent`（ゲートウェイ）
- 自動返信の配信ロジック

## sessions_spawn

隔離されたセッションでサブ エージェント実行を起動し、結果をリクエスターのチャット チャンネルにアナウンスします。

パラメータ：

- `task`（必須）
- `label?`（任意；ログ/UI 用）
- `agentId?`（任意；許可されていれば別のエージェント id の配下で起動）
- `model?`（任意；サブ エージェントのモデルを上書き；無効な値はエラー）
- `runTimeoutSeconds?`（デフォルト 0；設定時は N 秒後にサブ エージェント実行を中止）
- `cleanup?`（`delete|keep`、デフォルト `keep`）

許可リスト：

- `agents.list[].subagents.allowAgents`：`agentId`（任意を許可する場合は `["*"]`）経由で許可されるエージェント id の一覧。デフォルト：リクエスター エージェントのみ。 デフォルト: リクエスターエージェントのみ。

検出：

- `agents_list` を使用して、`sessions_spawn` に対して許可されているエージェント id を検出します。

挙動：

- `deliver: false` を伴う新しい `agent:<agentId>:subagent:<uuid>` セッションを開始します。
- サブ エージェントは既定で、**セッション ツールを除く** フル ツール セットを使用します（`tools.subagents.tools` で設定可能）。
- サブ エージェントは `sessions_spawn` を呼び出すことはできません（サブ エージェント → サブ エージェントの起動は不可）。
- 常にノンブロッキング：即座に `{ status: "accepted", runId, childSessionKey }` を返します。
- 完了後、OpenClaw はサブ エージェントの **アナウンス ステップ** を実行し、結果をリクエスターのチャット チャンネルに投稿します。
- アナウンス ステップ中に何も送信しない場合は、正確に `ANNOUNCE_SKIP` と返信してください。
- アナウンス返信は `Status`/`Result`/`Notes` に正規化されます。`Status` は実行時の結果に由来します（モデルのテキストではありません）。
- サブ エージェント セッションは `agents.defaults.subagents.archiveAfterMinutes` 後に自動アーカイブされます（デフォルト：60）。
- アナウンス返信には、統計行（実行時間、トークン数、sessionKey/sessionId、トランスクリプト パス、および任意のコスト）が含まれます。

## サンドボックス セッションの可視性

サンドボックス化されたセッションはセッション ツールを使用できますが、既定では `sessions_spawn` によって生成したセッションのみを参照できます。

設定：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
