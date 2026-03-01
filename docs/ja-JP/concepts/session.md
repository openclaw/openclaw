---
summary: "セッション管理ルール、キー、チャットの永続化"
read_when:
  - Modifying session handling or storage
title: "セッション管理"
---

# セッション管理

OpenClawは**エージェントごとに1つのダイレクトチャットセッション**をプライマリとして扱います。ダイレクトチャットは`agent:<agentId>:<mainKey>`（デフォルト`main`）に集約され、グループ/チャンネルチャットはそれぞれ独自のキーを持ちます。`session.mainKey`は尊重されます。

`session.dmScope`を使用して、**ダイレクトメッセージ**のグループ化方法を制御します:

- `main`（デフォルト）: すべてのDMが継続性のためにメインセッションを共有します。
- `per-peer`: チャンネルをまたいで送信者IDごとに分離します。
- `per-channel-peer`: チャンネル + 送信者ごとに分離します（マルチユーザーの受信ボックスに推奨）。
- `per-account-channel-peer`: アカウント + チャンネル + 送信者ごとに分離します（マルチアカウントの受信ボックスに推奨）。
  `session.identityLinks`を使用して、プロバイダープレフィックス付きのピアIDを正規IDにマッピングし、`per-peer`、`per-channel-peer`、または`per-account-channel-peer`を使用している場合に同一人物がチャンネルをまたいでDMセッションを共有できるようにします。

## セキュアDMモード（マルチユーザーセットアップに推奨）

> **セキュリティ警告:** エージェントが**複数の人**からDMを受信できる場合、セキュアDMモードの有効化を強く検討してください。有効にしないと、すべてのユーザーが同じ会話コンテキストを共有し、ユーザー間でプライベート情報が漏洩する可能性があります。

**デフォルト設定での問題例:**

- Alice（`<SENDER_A>`）がプライベートなトピック（例: 医療の予約）についてエージェントにメッセージを送信
- Bob（`<SENDER_B>`）がエージェントに「何について話していましたか？」とメッセージを送信
- 両方のDMが同じセッションを共有しているため、モデルがAliceの以前のコンテキストを使用してBobに回答する可能性があります

**修正方法:** `dmScope`を設定してユーザーごとにセッションを分離します:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // セキュアDMモード: チャンネル + 送信者ごとにDMコンテキストを分離。
    dmScope: "per-channel-peer",
  },
}
```

**有効にすべきタイミング:**

- 複数の送信者のペアリング承認がある場合
- 複数エントリのDM許可リストを使用している場合
- `dmPolicy: "open"`を設定している場合
- 複数の電話番号やアカウントがエージェントにメッセージを送信できる場合

注意事項:

- デフォルトは継続性のための`dmScope: "main"`です（すべてのDMがメインセッションを共有）。シングルユーザーセットアップでは問題ありません。
- ローカルCLIオンボーディングは未設定時にデフォルトで`session.dmScope: "per-channel-peer"`を書き込みます（既存の明示的な値は保持されます）。
- 同じチャンネルのマルチアカウント受信ボックスには`per-account-channel-peer`を推奨します。
- 同一人物が複数のチャンネルから連絡する場合、`session.identityLinks`を使用してDMセッションを1つの正規IDに集約します。
- `openclaw security audit`でDM設定を確認できます（[セキュリティ](/cli/security)を参照）。

## Gatewayが信頼できる情報源

すべてのセッション状態はGateway（「マスター」OpenClaw）が**所有**しています。UIクライアント（macOSアプリ、WebChatなど）は、ローカルファイルを読み取る代わりに、セッションリストとトークン数をGatewayに問い合わせる必要があります。

- **リモートモード**では、重要なセッションストアはMacではなくリモートGatewayホスト上に存在します。
- UIに表示されるトークン数はGatewayのストアフィールド（`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`）から取得されます。クライアントはJSONLトランスクリプトを解析して合計を「修正」することはありません。

## 状態の保存場所

- **Gatewayホスト**上:
  - ストアファイル: `~/.openclaw/agents/<agentId>/sessions/sessions.json`（エージェントごと）。
- トランスクリプト: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegramトピックセッションは`.../<SessionId>-topic-<threadId>.jsonl`を使用）。
- ストアは`sessionKey -> { sessionId, updatedAt, ... }`のマップです。エントリの削除は安全で、次のメッセージで再作成されます。
- グループエントリにはUIでセッションをラベル付けするための`displayName`、`channel`、`subject`、`room`、`space`が含まれることがあります。
- セッションエントリにはUIがセッションの出所を説明できるように`origin`メタデータ（ラベル + ルーティングヒント）が含まれます。
- OpenClawはレガシーのPi/Tauセッションフォルダを**読み込みません**。

## メンテナンス

OpenClawは`sessions.json`とトランスクリプトのアーティファクトを時間とともに制限するためにセッションストアメンテナンスを適用します。

### デフォルト

- `session.maintenance.mode`: `warn`
- `session.maintenance.pruneAfter`: `30d`
- `session.maintenance.maxEntries`: `500`
- `session.maintenance.rotateBytes`: `10mb`
- `session.maintenance.resetArchiveRetention`: `pruneAfter`にデフォルト（`30d`）
- `session.maintenance.maxDiskBytes`: 未設定（無効）
- `session.maintenance.highWaterBytes`: バジェット有効時に`maxDiskBytes`の`80%`にデフォルト

### 動作の仕組み

メンテナンスはセッションストアの書き込み時に実行され、`openclaw sessions cleanup`でオンデマンドでトリガーできます。

- `mode: "warn"`: 排除対象を報告しますが、エントリ/トランスクリプトを変更しません。
- `mode: "enforce"`: 以下の順序でクリーンアップを適用します:
  1. `pruneAfter`より古い陳腐化したエントリを削除
  2. エントリ数を`maxEntries`に制限（古い順）
  3. 参照されなくなった削除エントリのトランスクリプトファイルをアーカイブ
  4. リテンションポリシーに基づいて古い`*.deleted.<timestamp>`および`*.reset.<timestamp>`アーカイブを削除
  5. `sessions.json`が`rotateBytes`を超えた場合にローテーション
  6. `maxDiskBytes`が設定されている場合、`highWaterBytes`に向けてディスクバジェットを適用（古いアーティファクトから、次に古いセッション）

### 大規模ストアのパフォーマンスに関する注意

大規模なセッションストアは高負荷セットアップでよく見られます。メンテナンス処理は書き込みパスの作業であるため、非常に大きなストアでは書き込みレイテンシが増加する可能性があります。

コストが最も増加する要因:

- 非常に高い`session.maintenance.maxEntries`の値
- 陳腐化したエントリを残す長い`pruneAfter`ウィンドウ
- `~/.openclaw/agents/<agentId>/sessions/`内の多くのトランスクリプト/アーカイブアーティファクト
- 合理的なプルーニング/キャップ制限なしでディスクバジェット（`maxDiskBytes`）を有効にする

対処法:

- 本番環境では`mode: "enforce"`を使用して成長を自動的に制限する
- 時間とカウントの両方の制限（`pruneAfter` + `maxEntries`）を設定する（片方だけではない）
- 大規模デプロイメントではハード上限として`maxDiskBytes` + `highWaterBytes`を設定する
- `highWaterBytes`を`maxDiskBytes`より意味のある程度低く保つ（デフォルトは80%）
- 設定変更後に`openclaw sessions cleanup --dry-run --json`を実行して、適用前に予想される影響を確認する
- アクティブなセッションが頻繁にある場合、手動クリーンアップ実行時に`--active-key`を渡す

### カスタマイズ例

保守的なenforceポリシーを使用:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "45d",
      maxEntries: 800,
      rotateBytes: "20mb",
      resetArchiveRetention: "14d",
    },
  },
}
```

セッションディレクトリにハードディスクバジェットを有効化:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      maxDiskBytes: "1gb",
      highWaterBytes: "800mb",
    },
  },
}
```

大規模インストール向けのチューニング（例）:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "14d",
      maxEntries: 2000,
      rotateBytes: "25mb",
      maxDiskBytes: "2gb",
      highWaterBytes: "1.6gb",
    },
  },
}
```

CLIからメンテナンスをプレビューまたは強制実行:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

## セッションプルーニング

OpenClawはデフォルトでLLM呼び出しの直前にインメモリコンテキストから**古いツール結果**をトリミングします。
これはJSONL履歴を書き換え**ません**。[/concepts/session-pruning](/concepts/session-pruning)を参照してください。

## コンパクション前のメモリフラッシュ

セッションが自動コンパクションに近づくと、OpenClawはコンテキストがコンパクションされる**前に**モデルに永続的なメモを書き込むよう促す**サイレントメモリフラッシュ**ターンを実行できます。これはワークスペースが書き込み可能な場合にのみ実行されます。[メモリ](/concepts/memory)および[コンパクション](/concepts/compaction)を参照してください。

## トランスポート → セッションキーのマッピング

- ダイレクトチャットは`session.dmScope`に従います（デフォルト`main`）。
  - `main`: `agent:<agentId>:<mainKey>`（デバイス/チャンネル間の継続性）。
    - 複数の電話番号とチャンネルが同じエージェントメインキーにマッピングできます。1つの会話へのトランスポートとして機能します。
  - `per-peer`: `agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountIdのデフォルトは`default`）。
  - `session.identityLinks`がプロバイダープレフィックス付きのピアID（例: `telegram:123`）に一致する場合、正規キーが`<peerId>`を置き換え、同一人物がチャンネルをまたいでセッションを共有します。
- グループチャットは状態を分離します: `agent:<agentId>:<channel>:group:<id>`（ルーム/チャンネルは`agent:<agentId>:<channel>:channel:<id>`を使用）。
  - Telegramフォーラムトピックは分離のためにグループIDに`:topic:<threadId>`を追加します。
  - レガシーの`group:<id>`キーは移行のために引き続き認識されます。
- 受信コンテキストは依然として`group:<id>`を使用することがあります。チャンネルは`Provider`から推論され、正規の`agent:<agentId>:<channel>:group:<id>`形式に正規化されます。
- その他のソース:
  - Cronジョブ: `cron:<job.id>`
  - Webhooks: `hook:<uuid>`（フックで明示的に設定されていない限り）
  - ノード実行: `node-<nodeId>`

## ライフサイクル

- リセットポリシー: セッションは期限切れになるまで再利用され、期限切れは次の受信メッセージで評価されます。
- 日次リセット: デフォルトで**Gatewayホストのローカルタイムで午前4:00**。最後の更新が直近の日次リセット時刻より前のセッションは陳腐化と判定されます。
- アイドルリセット（オプション）: `idleMinutes`はスライディングアイドルウィンドウを追加します。日次リセットとアイドルリセットの両方が設定されている場合、**先に期限切れになった方**が新しいセッションを強制します。
- レガシーアイドルのみ: `session.reset`/`resetByType`設定なしで`session.idleMinutes`を設定した場合、OpenClawは後方互換性のためにアイドルのみモードを維持します。
- タイプごとのオーバーライド（オプション）: `resetByType`で`direct`、`group`、`thread`セッションのポリシーをオーバーライドできます（thread = Slack/Discordスレッド、Telegramトピック、コネクタが提供する場合のMatrixスレッド）。
- チャンネルごとのオーバーライド（オプション）: `resetByChannel`はチャンネルのリセットポリシーをオーバーライドします（そのチャンネルのすべてのセッションタイプに適用され、`reset`/`resetByType`より優先されます）。
- リセットトリガー: 正確な`/new`または`/reset`（および`resetTriggers`内の追加分）は新しいセッションIDを開始し、メッセージの残りを通過させます。`/new <model>`はモデルエイリアス、`provider/model`、またはプロバイダー名（ファジーマッチ）を受け入れて新しいセッションモデルを設定します。`/new`または`/reset`が単独で送信された場合、OpenClawはリセットを確認するための短い「hello」グリーティングターンを実行します。
- 手動リセット: ストアから特定のキーを削除するか、JSONLトランスクリプトを削除します。次のメッセージで再作成されます。
- 分離されたCronジョブは実行ごとに常に新しい`sessionId`を生成します（アイドル再利用なし）。

## 送信ポリシー（オプション）

個々のIDをリストせずに、特定のセッションタイプの配信をブロックします。

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        // 生のセッションキー（`agent:<id>:`プレフィックスを含む）にマッチ。
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

ランタイムオーバーライド（オーナーのみ）:

- `/send on` → このセッションで許可
- `/send off` → このセッションで拒否
- `/send inherit` → オーバーライドをクリアして設定ルールを使用
  これらは独立したメッセージとして送信して登録してください。

## 設定（オプションのリネーム例）

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // グループキーを分離
    dmScope: "main", // DM継続性（共有受信ボックスにはper-channel-peer/per-account-channel-peerを設定）
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // デフォルト: mode=daily, atHour=4（Gatewayホストのローカルタイム）。
      // idleMinutesも設定した場合、先に期限切れになった方が優先されます。
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
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

- `openclaw status` -- ストアパスと最近のセッションを表示します。
- `openclaw sessions --json` -- すべてのエントリをダンプします（`--active <minutes>`でフィルタリング）。
- `openclaw gateway call sessions.list --params '{}'` -- 実行中のGatewayからセッションを取得します（リモートGatewayアクセスには`--url`/`--token`を使用）。
- チャットで独立したメッセージとして`/status`を送信すると、エージェントが到達可能かどうか、セッションコンテキストの使用量、現在のthinking/verboseの切り替え状態、WhatsApp Web資格情報の最終更新日時（再リンクの必要性の検出に役立ちます）を確認できます。
- `/context list`または`/context detail`を送信すると、システムプロンプトに含まれるものと注入されたワークスペースファイル（および最大のコンテキスト貢献者）を確認できます。
- `/stop`（またはスタンドアロンの中止フレーズ: `stop`、`stop action`、`stop run`、`stop openclaw`）を送信すると、現在の実行を中止し、そのセッションのキューに入れられたフォローアップをクリアし、そこから生成されたサブエージェント実行を停止します（返信には停止数が含まれます）。
- `/compact`（オプションの指示）を独立したメッセージとして送信すると、古いコンテキストを要約してウィンドウスペースを解放します。[/concepts/compaction](/concepts/compaction)を参照してください。
- JSONLトランスクリプトを直接開いて完全なターンを確認できます。

## ヒント

- プライマリキーを1:1のトラフィック専用にし、グループには独自のキーを保持させてください。
- クリーンアップを自動化する場合、他のコンテキストを保持するためにストア全体ではなく個々のキーを削除してください。

## セッションオリジンメタデータ

各セッションエントリは`origin`にその出所を記録します（ベストエフォート）:

- `label`: 人間用ラベル（会話ラベル + グループサブジェクト/チャンネルから解決）
- `provider`: 正規化されたチャンネルID（エクステンションを含む）
- `from`/`to`: 受信エンベロープからの生のルーティングID
- `accountId`: プロバイダーアカウントID（マルチアカウント時）
- `threadId`: チャンネルがサポートする場合のスレッド/トピックID
  オリジンフィールドはダイレクトメッセージ、チャンネル、グループに対して入力されます。コネクタが配信ルーティングのみを更新する場合（例: DMメインセッションを最新に保つため）でも、セッションが説明メタデータを維持できるように受信コンテキストを提供する必要があります。エクステンションは受信コンテキストで`ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace`、`SenderName`を送信し、`recordSessionMetaFromInbound`を呼び出す（または同じコンテキストを`updateLastRoute`に渡す）ことでこれを行えます。
