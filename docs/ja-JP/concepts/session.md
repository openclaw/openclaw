---
read_when:
    - セッションのルーティングと分離について理解したい場合
    - マルチユーザー環境でダイレクトメッセージのスコープを設定したい場合
summary: OpenClawが会話セッションを管理する仕組み
title: セッション管理
x-i18n:
    generated_at: "2026-04-02T07:40:12Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: ab985781e54b22a034489dafa4b52cc204b1a5da22ee9b62edc7f6697512cea1
    source_path: concepts/session.md
    workflow: 15
---

# セッション管理

OpenClawは会話を**セッション**として整理します。各メッセージは送信元（ダイレクトメッセージ、グループチャット、cronジョブなど）に基づいてセッションにルーティングされます。

## メッセージのルーティング方法

| 送信元            | 動作                          |
| ----------------- | ----------------------------- |
| ダイレクトメッセージ | デフォルトで共有セッション     |
| グループチャット     | グループごとに分離             |
| ルーム/チャネル      | ルームごとに分離               |
| cronジョブ          | 実行ごとに新しいセッション     |
| Webhook            | フックごとに分離               |

## ダイレクトメッセージの分離

デフォルトでは、すべてのダイレクトメッセージは継続性のために1つのセッションを共有します。シングルユーザー環境ではこれで問題ありません。

<Warning>
複数の人がエージェントにメッセージを送信できる場合は、ダイレクトメッセージの分離を有効にしてください。有効にしないと、すべてのユーザーが同じ会話コンテキストを共有し、AliceのプライベートメッセージがBobに見えてしまいます。
</Warning>

**対処方法:**

```json5
{
  session: {
    dmScope: "per-channel-peer", // チャネル + 送信者で分離
  },
}
```

その他のオプション:

- `main`（デフォルト）-- すべてのダイレクトメッセージが1つのセッションを共有します。
- `per-peer` -- 送信者ごとに分離します（チャネル横断）。
- `per-channel-peer` -- チャネル + 送信者ごとに分離します（推奨）。
- `per-account-channel-peer` -- アカウント + チャネル + 送信者ごとに分離します。

<Tip>
同じ人が複数のチャネルから連絡してくる場合は、`session.identityLinks`を使用してIDをリンクし、1つのセッションを共有できるようにしてください。
</Tip>

セットアップの確認には`openclaw security audit`を使用してください。

## セッションのライフサイクル

セッションは有効期限が切れるまで再利用されます:

- **日次リセット**（デフォルト）-- Gateway ゲートウェイホストのローカル時間で午前4:00に新しいセッションが開始されます。
- **アイドルリセット**（オプション）-- 一定期間操作がないと新しいセッションが開始されます。`session.reset.idleMinutes`で設定します。
- **手動リセット** -- チャットで`/new`または`/reset`と入力します。`/new <model>`でモデルの切り替えも可能です。

日次リセットとアイドルリセットの両方が設定されている場合、先に期限が切れた方が適用されます。

## 状態の保存場所

すべてのセッション状態は**Gateway ゲートウェイ**が所有します。UIクライアントはGateway ゲートウェイにセッションデータを問い合わせます。

- **ストア:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- **トランスクリプト:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

## セッションのメンテナンス

OpenClawは時間の経過とともにセッションストレージを自動的に制限します。デフォルトでは`warn`モード（クリーンアップ対象をレポート）で動作します。自動クリーンアップを行うには`session.maintenance.mode`を`"enforce"`に設定してください:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
    },
  },
}
```

`openclaw sessions cleanup --dry-run`でプレビューできます。

## セッションの確認

- `openclaw status` -- セッションストアのパスと最近のアクティビティ。
- `openclaw sessions --json` -- すべてのセッション（`--active <minutes>`でフィルタ可能）。
- チャットで`/status` -- コンテキスト使用量、モデル、トグル。
- `/context list` -- システムプロンプトの内容。

## 関連資料

- [セッションプルーニング](/concepts/session-pruning) -- ツール結果のトリミング
- [コンパクション](/concepts/compaction) -- 長い会話の要約
- [セッションツール](/concepts/session-tool) -- クロスセッション作業用のエージェントツール
- [セッション管理の詳細](/reference/session-management-compaction) --
  ストアスキーマ、トランスクリプト、送信ポリシー、オリジンメタデータ、高度な設定
- [マルチエージェント](/concepts/multi-agent) — エージェント間のルーティングとセッション分離
- [バックグラウンドタスク](/automation/tasks) — 分離された作業がセッション参照付きのタスクレコードを作成する仕組み
- [チャネルルーティング](/channels/channel-routing) — 受信メッセージがセッションにルーティングされる仕組み
