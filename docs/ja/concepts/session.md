---
summary: "チャットのためのセッション管理ルール、キー、および永続化"
read_when:
  - セッション処理やストレージを変更する場合
title: "セッション管理"
x-i18n:
  source_path: concepts/session.md
  source_hash: e2040cea1e0738a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:59Z
---

# セッション管理

OpenClaw は、**エージェントごとに 1 つのダイレクトチャットセッション**を基本として扱います。ダイレクトチャットは `agent:<agentId>:<mainKey>`（デフォルトは `main`）に集約され、グループ／チャンネルチャットはそれぞれ独自のキーを持ちます。`session.mainKey` は尊重されます。

**ダイレクトメッセージ**のグルーピング方法は `session.dmScope` で制御します。

- `main`（デフォルト）: すべての DM が継続性のためにメインセッションを共有します。
- `per-peer`: チャンネルをまたいで送信者 ID ごとに分離します。
- `per-channel-peer`: チャンネル + 送信者で分離します（マルチユーザー受信箱に推奨）。
- `per-account-channel-peer`: アカウント + チャンネル + 送信者で分離します（マルチアカウント受信箱に推奨）。
  `session.identityLinks` を使用すると、プロバイダー接頭辞付きのピア ID を正規化された ID にマップでき、`per-peer`、`per-channel-peer`、または `per-account-channel-peer` 使用時に、同一人物がチャンネルをまたいでも同じ DM セッションを共有できます。

## セキュア DM モード（マルチユーザー構成に推奨）

> **セキュリティ警告:** エージェントが**複数人**から DM を受信できる場合は、セキュア DM モードを有効にすることを強く推奨します。無効の場合、すべてのユーザーが同じ会話コンテキストを共有し、ユーザー間で個人情報が漏洩する可能性があります。

**デフォルト設定で発生する問題の例:**

- Alice（`<SENDER_A>`）が、個人的な話題（例: 医療予約）についてエージェントにメッセージを送信します。
- Bob（`<SENDER_B>`）が、「さっき何を話していましたか？」とエージェントにメッセージを送信します。
- 両方の DM が同じセッションを共有しているため、モデルが Alice の以前の文脈を使って Bob に回答してしまう可能性があります。

**対処方法:** ユーザーごとにセッションを分離するよう `dmScope` を設定します。

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**有効にすべき場合:**

- 複数の送信者に対するペアリング承認がある
- 複数エントリを含む DM 許可リストを使用している
- `dmPolicy: "open"` を設定している
- 複数の電話番号やアカウントからエージェントにメッセージできる

注記:

- デフォルトは継続性重視の `dmScope: "main"`（すべての DM がメインセッションを共有）です。単一ユーザー構成では問題ありません。
- 同一チャンネル上のマルチアカウント受信箱では、`per-account-channel-peer` を推奨します。
- 同一人物が複数チャンネルから連絡してくる場合は、`session.identityLinks` を使用して DM セッションを 1 つの正規 ID に集約します。
- DM 設定は `openclaw security audit` で確認できます（[security](/cli/security) を参照）。

## Gateway（ゲートウェイ）が信頼できる唯一の情報源

すべてのセッション状態は **ゲートウェイ**（「マスター」OpenClaw）が所有します。UI クライアント（macOS アプリ、WebChat など）は、ローカルファイルを読むのではなく、セッション一覧やトークン数をゲートウェイに問い合わせる必要があります。

- **リモートモード**では、重要なセッションストアは Mac ではなく、リモートの Gateway ホスト上に存在します。
- UI に表示されるトークン数は、ゲートウェイのストアフィールド（`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`）に基づきます。クライアントが JSONL トランスクリプトを解析して合計を「補正」することはありません。

## 状態の保存場所

- **Gateway ホスト**上:
  - ストアファイル: `~/.openclaw/agents/<agentId>/sessions/sessions.json`（エージェントごと）。
- トランスクリプト: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram のトピックセッションでは `.../<SessionId>-topic-<threadId>.jsonl` を使用）。
- ストアは `sessionKey -> { sessionId, updatedAt, ... }` のマップです。エントリの削除は安全で、必要に応じて再作成されます。
- グループエントリには、UI でセッションを識別するために `displayName`、`channel`、`subject`、`room`、および `space` が含まれる場合があります。
- セッションエントリには、セッションの由来を UI が説明できるよう、`origin` メタデータ（ラベル + ルーティングヒント）が含まれます。
- OpenClaw は、従来の Pi/Tau セッションフォルダーを**読み込みません**。

## セッションのプルーニング

OpenClaw はデフォルトで、LLM 呼び出し直前に、メモリ上のコンテキストから**古いツール結果**を削除します。
これは JSONL 履歴を書き換えるものではありません。詳細は [/concepts/session-pruning](/concepts/session-pruning) を参照してください。

## 事前コンパクション時のメモリフラッシュ

セッションが自動コンパクションに近づくと、OpenClaw は**サイレントなメモリフラッシュ**ターンを実行し、モデルに対して永続的なメモをディスクに書き出すよう促すことがあります。これはワークスペースが書き込み可能な場合にのみ実行されます。詳細は [Memory](/concepts/memory) および [Compaction](/concepts/compaction) を参照してください。

## トランスポート → セッションキーの対応付け

- ダイレクトチャットは `session.dmScope` に従います（デフォルトは `main`）。
  - `main`: `agent:<agentId>:<mainKey>`（デバイス／チャンネルをまたいだ継続性）。
    - 複数の電話番号やチャンネルが同じエージェントのメインキーにマップされ、1 つの会話へのトランスポートとして機能します。
  - `per-peer`: `agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountId のデフォルトは `default`）。
  - `session.identityLinks` がプロバイダー接頭辞付きのピア ID（例: `telegram:123`）に一致する場合、正規キーが `<peerId>` を置き換え、同一人物がチャンネルをまたいでもセッションを共有します。
- グループチャットは状態を分離します: `agent:<agentId>:<channel>:group:<id>`（ルーム／チャンネルでは `agent:<agentId>:<channel>:channel:<id>` を使用）。
  - Telegram のフォーラムトピックは、分離のためにグループ ID に `:topic:<threadId>` を付加します。
  - 従来の `group:<id>` キーも移行目的で引き続き認識されます。
- インバウンドコンテキストでは `group:<id>` が使われる場合があります。チャンネルは `Provider` から推定され、正規の `agent:<agentId>:<channel>:group:<id>` 形式に正規化されます。
- その他のソース:
  - Cron ジョブ: `cron:<job.id>`
  - Webhook: `hook:<uuid>`（フックで明示的に設定されていない場合）
  - ノード実行: `node-<nodeId>`

## ライフサイクル

- リセットポリシー: セッションは期限切れになるまで再利用され、期限判定は次のインバウンドメッセージ時に行われます。
- デイリーリセット: デフォルトは **Gateway ホストのローカル時刻で午前 4:00** です。最終更新が直近のデイリーリセット時刻より前の場合、セッションは古いとみなされます。
- アイドルリセット（任意）: `idleMinutes` により、スライディングなアイドルウィンドウが追加されます。デイリーリセットとアイドルリセットの両方が設定されている場合、**先に期限切れになった方**が新しいセッションを強制します。
- 従来のアイドルのみモード: `session.idleMinutes` を設定し、`session.reset`/`resetByType` の設定がない場合、後方互換性のため OpenClaw はアイドルのみモードのまま動作します。
- タイプ別オーバーライド（任意）: `resetByType` により、`dm`、`group`、および `thread` セッションのポリシーを上書きできます（thread = Slack/Discord スレッド、Telegram トピック、コネクターが提供する場合は Matrix スレッド）。
- チャンネル別オーバーライド（任意）: `resetByChannel` はチャンネル単位でリセットポリシーを上書きします（そのチャンネルのすべてのセッションタイプに適用され、`reset`/`resetByType` より優先されます）。
- リセットトリガー: 正確な `/new` または `/reset`（および `resetTriggers` 内の追加要素）に一致すると、新しいセッション ID が開始され、残りのメッセージが処理されます。`/new <model>` はモデルエイリアス、`provider/model`、またはプロバイダー名（あいまい一致）を受け取り、新しいセッションモデルを設定します。`/new` または `/reset` のみが送信された場合、OpenClaw は短い「hello」挨拶ターンを実行してリセットを確認します。
- 手動リセット: ストアから特定のキーを削除するか、JSONL トランスクリプトを削除します。次のメッセージで再作成されます。
- 分離された Cron ジョブは、実行ごとに常に新しい `sessionId` を生成します（アイドル再利用なし）。

## 送信ポリシー（任意）

個別 ID を列挙せずに、特定のセッションタイプへの配信をブロックします。

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

実行時オーバーライド（オーナーのみ）:

- `/send on` → このセッションを許可
- `/send off` → このセッションを拒否
- `/send inherit` → オーバーライドをクリアし、設定ルールを使用
  これらは単独のメッセージとして送信してください。そうしないと登録されません。

## 設定（任意のリネーム例）

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## 検査

- `openclaw status` — ストアパスと最近のセッションを表示します。
- `openclaw sessions --json` — すべてのエントリをダンプします（`--active <minutes>` でフィルタ）。
- `openclaw gateway call sessions.list --params '{}'` — 実行中のゲートウェイからセッションを取得します（リモート Gateway（ゲートウェイ）アクセスには `--url`/`--token` を使用）。
- チャットで `/status` を単独メッセージとして送信すると、エージェントが到達可能かどうか、セッションコンテキストの使用量、現在の thinking/verbose トグル、WhatsApp Web 認証情報の最終更新時刻（再リンクが必要かどうかの判別に有用）が確認できます。
- `/context list` または `/context detail` を送信すると、システムプロンプトや注入されたワークスペースファイルの内容（および最大のコンテキスト寄与要素）を確認できます。
- `/stop` を単独メッセージとして送信すると、現在の実行を中断し、そのセッションにキューされたフォローアップをクリアし、そこから起動されたすべてのサブエージェント実行を停止します（応答には停止件数が含まれます）。
- `/compact`（任意の指示）を単独メッセージとして送信すると、古いコンテキストを要約してウィンドウ領域を解放します。詳細は [/concepts/compaction](/concepts/compaction) を参照してください。
- JSONL トランスクリプトは直接開いて、完全なターンを確認できます。

## ヒント

- プライマリキーは 1:1 トラフィック専用に保ち、グループは独自のキーを使用させてください。
- クリーンアップを自動化する場合は、ストア全体ではなく個々のキーを削除して、他のコンテキストを保持してください。

## セッション起点メタデータ

各セッションエントリには、その由来が（ベストエフォートで）`origin` に記録されます。

- `label`: 人間向けラベル（会話ラベル + グループ件名／チャンネルから解決）
- `provider`: 正規化されたチャンネル ID（拡張を含む）
- `from`/`to`: インバウンドエンベロープからの生のルーティング ID
- `accountId`: プロバイダーのアカウント ID（マルチアカウント時）
- `threadId`: チャンネルがサポートする場合のスレッド／トピック ID
  起点フィールドは、ダイレクトメッセージ、チャンネル、グループに対して設定されます。コネクターが配信ルーティングのみを更新する場合（例: DM のメインセッションを新鮮に保つため）でも、セッションが説明用メタデータを保持できるよう、インバウンドコンテキストを提供する必要があります。拡張機能は、インバウンドコンテキストに `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace`、および `SenderName` を送信し、`recordSessionMetaFromInbound` を呼び出す（または同じコンテキストを `updateLastRoute` に渡す）ことでこれを実現できます。
