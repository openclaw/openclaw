---
read_when:
    - macメニューUIやステータスロジックを調整する場合
summary: メニューバーのステータスロジックとユーザーに表示される内容
title: メニューバー
x-i18n:
    generated_at: "2026-04-02T07:48:06Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8eb73c0e671a76aae4ebb653c65147610bf3e6d3c9c0943d150e292e7761d16d
    source_path: platforms/mac/menu-bar.md
    workflow: 15
---

# メニューバーのステータスロジック

## 表示される内容

- メニューバーアイコンとメニューの最初のステータス行に、現在のエージェントの作業状態を表示します。
- ヘルスステータスは作業中は非表示になり、すべてのセッションがアイドル状態になると再表示されます。
- メニュー内の「Nodes」ブロックは**デバイス**のみ（`node.list` 経由のペアリング済みノード）をリスト表示し、クライアント/プレゼンスエントリは表示しません。
- プロバイダーの使用量スナップショットが利用可能な場合、Contextの下に「Usage」セクションが表示されます。

## 状態モデル

- セッション: イベントはペイロード内の `runId`（実行ごと）と `sessionKey` とともに到着します。「main」セッションはキー `main` です。存在しない場合は、最後に更新されたセッションにフォールバックします。
- 優先度: mainが常に優先されます。mainがアクティブな場合、その状態が即座に表示されます。mainがアイドルの場合、最後にアクティブだったmain以外のセッションが表示されます。アクティビティの途中で切り替えは行いません。現在のセッションがアイドルになるか、mainがアクティブになった場合にのみ切り替わります。
- アクティビティの種類:
  - `job`: 高レベルのコマンド実行（`state: started|streaming|done|error`）。
  - `tool`: `phase: start|result`、`toolName` および `meta/args` 付き。

## IconState列挙型（Swift）

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)`（デバッグオーバーライド）

### ActivityKind → グリフ

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- デフォルト → 🛠️

### ビジュアルマッピング

- `idle`: 通常のクリッター。
- `workingMain`: グリフ付きバッジ、フルティント、脚の「作業中」アニメーション。
- `workingOther`: グリフ付きバッジ、ミュートティント、スカリーなし。
- `overridden`: アクティビティに関係なく、選択されたグリフ/ティントを使用。

## ステータス行テキスト（メニュー）

- 作業中: `<セッションロール> · <アクティビティラベル>`
  - 例: `Main · exec: pnpm test`、`Other · read: apps/macos/Sources/OpenClaw/AppState.swift`。
- アイドル時: ヘルスサマリーにフォールバック。

## イベント取り込み

- ソース: コントロールチャネルの `agent` イベント（`ControlChannel.handleAgentEvent`）。
- パースされるフィールド:
  - `stream: "job"`、開始/停止用の `data.state` 付き。
  - `stream: "tool"`、`data.phase`、`name`、オプションの `meta`/`args` 付き。
- ラベル:
  - `exec`: `args.command` の最初の行。
  - `read`/`write`: 短縮パス。
  - `edit`: パスと `meta`/diff カウントから推測される変更種別。
  - フォールバック: ツール名。

## デバッグオーバーライド

- 設定 ▸ デバッグ ▸ 「Icon override」ピッカー:
  - `System (auto)`（デフォルト）
  - `Working: main`（ツール種別ごと）
  - `Working: other`（ツール種別ごと）
  - `Idle`
- `@AppStorage("iconOverride")` を介して保存され、`IconState.overridden` にマッピングされます。

## テストチェックリスト

- mainセッションのジョブをトリガー: アイコンが即座に切り替わり、ステータス行にmainラベルが表示されることを確認。
- mainがアイドル中にmain以外のセッションのジョブをトリガー: アイコン/ステータスにmain以外が表示され、終了まで安定していることを確認。
- 他がアクティブ中にmainを開始: アイコンが即座にmainに切り替わることを確認。
- 高速なツールバースト: バッジがちらつかないことを確認（ツール結果のTTL猶予）。
- すべてのセッションがアイドルになるとヘルス行が再表示されることを確認。
