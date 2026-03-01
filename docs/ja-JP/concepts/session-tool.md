---
summary: "セッションの一覧表示、履歴の取得、クロスセッションメッセージの送信のためのエージェントセッションツール"
read_when:
  - セッションツールを追加または変更しているとき
title: "セッションツール"
---

# セッションツール

目標: エージェントがセッションを一覧表示し、履歴を取得し、別のセッションに送信できる、誤用しにくい小さなツールセットです。

## ツール名

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## キーモデル

- メインのダイレクトチャットバケットは常にリテラルキー `"main"`（現在のエージェントのメインキーに解決される）です。
- グループチャットは `agent:<agentId>:<channel>:group:<id>` または `agent:<agentId>:<channel>:channel:<id>` を使用します（フルキーを渡す）。
- Cron ジョブは `cron:<job.id>` を使用します。
- フックは明示的に設定されていない限り `hook:<uuid>` を使用します。
- ノードセッションは明示的に設定されていない限り `node-<nodeId>` を使用します。

`global` と `unknown` は予約済みの値であり、リストに表示されません。`session.scope = "global"` の場合、すべてのツールで `main` にエイリアスされるため、呼び出し元が `global` を参照することはありません。

## sessions_list

セッションを行の配列として一覧表示します。

パラメーター:

- `kinds?: string[]` フィルター: `"main" | "group" | "cron" | "hook" | "node" | "other"` のいずれか
- `limit?: number` 最大行数（デフォルト: サーバーデフォルト、例: 200 で制限）
- `activeMinutes?: number` N 分以内に更新されたセッションのみ
- `messageLimit?: number` 0 = メッセージなし（デフォルト 0）; >0 = 最後の N 件のメッセージを含める

動作:

- `messageLimit > 0` の場合はセッションごとに `chat.history` を取得して最後の N 件のメッセージを含めます。
- ツール結果はリスト出力でフィルタリングされます。ツールメッセージには `sessions_history` を使用してください。
- **サンドボックス**エージェントセッションで実行している場合、セッションツールはデフォルトで**スポーンのみの可視性**になります（以下を参照）。

行の形状（JSON）:

- `key`: セッションキー（文字列）
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName`（グループ表示ラベル、利用可能な場合）
- `updatedAt`（ミリ秒）
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy`（設定されている場合のセッションオーバーライド）
- `lastChannel`、`lastTo`
- `deliveryContext`（利用可能な場合の正規化された `{ channel, to, accountId }`）
- `transcriptPath`（ストアディレクトリ + sessionId から派生したベストエフォートのパス）
- `messages?`（`messageLimit > 0` の場合のみ）

## sessions_history

1 つのセッションのトランスクリプトを取得します。

パラメーター:

- `sessionKey`（必須; `sessions_list` からのセッションキーまたは `sessionId` を受け付ける）
- `limit?: number` 最大メッセージ数（サーバーが制限する）
- `includeTools?: boolean`（デフォルト false）

動作:

- `includeTools=false` は `role: "toolResult"` メッセージをフィルタリングします。
- メッセージ配列を生のトランスクリプト形式で返します。
- `sessionId` が指定された場合、OpenClaw は対応するセッションキーに解決します（見つからない ID はエラー）。

## sessions_send

別のセッションにメッセージを送信します。

パラメーター:

- `sessionKey`（必須; `sessions_list` からのセッションキーまたは `sessionId` を受け付ける）
- `message`（必須）
- `timeoutSeconds?: number`（デフォルト >0; 0 = fire-and-forget）

動作:

- `timeoutSeconds = 0`: エンキューして `{ runId, status: "accepted" }` を返します。
- `timeoutSeconds > 0`: 完了まで最大 N 秒待機し、`{ runId, status: "ok", reply }` を返します。
- 待機タイムアウト時: `{ runId, status: "timeout", error }`。実行は継続します。後で `sessions_history` を呼び出してください。
- 実行失敗時: `{ runId, status: "error", error }`。
- アナウンスデリバリーはプライマリ実行完了後にベストエフォートで実行されます。`status: "ok"` はアナウンスの配信を保証しません。
- Gateway の `agent.wait`（サーバーサイド）で待機するため、再接続しても待機が失われません。
- プライマリ実行にはエージェント間メッセージコンテキストが注入されます。
- セッション間メッセージは `message.provenance.kind = "inter_session"` で永続化されるため、トランスクリプトリーダーはルーティングされたエージェント指示と外部ユーザー入力を区別できます。
- プライマリ実行完了後、OpenClaw は**返信ループ**を実行します:
  - ラウンド 2 以降はリクエスターとターゲットエージェントが交互に実行されます。
  - `REPLY_SKIP` と正確に返信するとピンポンが停止します。
  - 最大ターン数は `session.agentToAgent.maxPingPongTurns`（0～5、デフォルト 5）です。
- ループ終了後、OpenClaw は**エージェント間アナウンスステップ**（ターゲットエージェントのみ）を実行します:
  - `ANNOUNCE_SKIP` と正確に返信するとサイレントになります。
  - その他の返信はターゲットチャンネルに送信されます。
  - アナウンスステップには元のリクエスト + ラウンド 1 の返信 + 最新のピンポン返信が含まれます。

## チャンネルフィールド

- グループの場合、`channel` はセッションエントリに記録されたチャンネルです。
- ダイレクトチャットの場合、`channel` は `lastChannel` からマッピングされます。
- cron/hook/node の場合、`channel` は `internal` です。
- 存在しない場合、`channel` は `unknown` です。

## セキュリティ / 送信ポリシー

チャンネル/チャット種別によるポリシーベースのブロッキング（セッション ID ごとではない）。

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

ランタイムオーバーライド（セッションエントリごと）:

- `sendPolicy: "allow" | "deny"`（未設定 = 設定を継承）
- `sessions.patch` または所有者のみの `/send on|off|inherit`（スタンドアロンメッセージ）で設定可能。

強制ポイント:

- `chat.send` / `agent`（Gateway）
- 自動返信デリバリーロジック

## sessions_spawn

サブエージェント実行を分離されたセッションでスポーンし、結果をリクエスターのチャットチャンネルにアナウンスします。

パラメーター:

- `task`（必須）
- `label?`（オプション; ログ/UI 用）
- `agentId?`（オプション; 許可されている場合は別のエージェント ID でスポーン）
- `model?`（オプション; サブエージェントのモデルをオーバーライド; 無効な値はエラー）
- `thinking?`（オプション; サブエージェント実行のシンキングレベルをオーバーライド）
- `runTimeoutSeconds?`（デフォルトは `agents.defaults.subagents.runTimeoutSeconds` が設定されている場合はその値、それ以外は `0`; 設定時、N 秒後にサブエージェント実行を中断）
- `thread?`（デフォルト false; チャンネル/プラグインがサポートしている場合、このスポーンのスレッドバインドルーティングをリクエスト）
- `mode?`（`run|session`; デフォルトは `run`、`thread=true` の場合は `session`; `mode="session"` は `thread=true` が必要）
- `cleanup?`（`delete|keep`、デフォルト `keep`）

アローリスト:

- `agents.list[].subagents.allowAgents`: `agentId` で許可されるエージェント ID のリスト（任意を許可する場合は `["*"]`）。デフォルト: リクエスターエージェントのみ。

ディスカバリー:

- `agents_list` を使用して `sessions_spawn` で許可されているエージェント ID を確認します。

動作:

- `deliver: false` で新しい `agent:<agentId>:subagent:<uuid>` セッションを開始します。
- サブエージェントはデフォルトで**セッションツールを除く**フルツールセット（`tools.subagents.tools` で設定可能）を使用します。
- サブエージェントは `sessions_spawn` を呼び出すことは許可されていません（サブエージェント → サブエージェントのスポーンなし）。
- 常に非ブロッキング: 直ちに `{ status: "accepted", runId, childSessionKey }` を返します。
- `thread=true` の場合、チャンネルプラグインはデリバリー/ルーティングをスレッドターゲットにバインドできます（Discord のサポートは `session.threadBindings.*` と `channels.discord.threadBindings.*` で制御）。
- 完了後、OpenClaw はサブエージェントの**アナウンスステップ**を実行し、リクエスターのチャットチャンネルに結果を投稿します。
  - アシスタントの最終返信が空の場合、サブエージェント履歴の最新 `toolResult` が `Result` として含まれます。
- アナウンスステップ中に `ANNOUNCE_SKIP` と正確に返信するとサイレントになります。
- アナウンス返信は `Status`/`Result`/`Notes` に正規化されます。`Status` はモデルのテキストではなくランタイムの結果から取得されます。
- サブエージェントセッションは `agents.defaults.subagents.archiveAfterMinutes`（デフォルト: 60）後に自動アーカイブされます。
- アナウンス返信には統計行（ランタイム、トークン、sessionKey/sessionId、トランスクリプトパス、オプションのコスト）が含まれます。

## サンドボックスセッションの可視性

セッションツールはクロスセッションアクセスを削減するためにスコープを設定できます。

デフォルト動作:

- `tools.sessions.visibility` はデフォルトで `tree`（現在のセッション + スポーンされたサブエージェントセッション）。
- サンドボックスセッションの場合、`agents.defaults.sandbox.sessionToolsVisibility` で可視性をハードクランプできます。

設定:

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      // デフォルト: "tree"
      visibility: "tree",
    },
  },
  agents: {
    defaults: {
      sandbox: {
        // デフォルト: "spawned"
        sessionToolsVisibility: "spawned", // または "all"
      },
    },
  },
}
```

注意:

- `self`: 現在のセッションキーのみ。
- `tree`: 現在のセッション + 現在のセッションからスポーンされたセッション。
- `agent`: 現在のエージェント ID に属する任意のセッション。
- `all`: 任意のセッション（クロスエージェントアクセスには引き続き `tools.agentToAgent` が必要）。
- セッションがサンドボックス化されており `sessionToolsVisibility="spawned"` の場合、`tools.sessions.visibility="all"` を設定しても OpenClaw は可視性を `tree` にクランプします。
