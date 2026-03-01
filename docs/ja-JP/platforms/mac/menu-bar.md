---
summary: "メニューバーのステータスロジックとユーザーに表示される内容"
read_when:
  - macメニューUIまたはステータスロジックの調整
title: "メニューバー"
---

# メニューバーのステータスロジック

## 表示内容

- 現在のエージェントの作業状態をメニューバーアイコンとメニューの最初のステータス行に表示します。
- ヘルスステータスは作業がアクティブな間は非表示になり、すべてのセッションがアイドルになると再び表示されます。
- メニューの「Nodes」ブロックには**デバイス**のみ（`node.list`経由のペアリング済みノード）がリストされ、クライアント/プレゼンスエントリは含まれません。
- プロバイダーの使用状況スナップショットが利用可能な場合、Contextの下に「Usage」セクションが表示されます。

## 状態モデル

- セッション：イベントはペイロード内の`runId`（実行ごと）と`sessionKey`で到着します。「main」セッションはキー`main`です。存在しない場合は、最近更新されたセッションにフォールバックします。
- 優先順位：mainが常に優先されます。mainがアクティブな場合、その状態が即座に表示されます。mainがアイドルの場合、最近アクティブだったmain以外のセッションが表示されます。アクティビティの途中では切り替わりません。現在のセッションがアイドルになるか、mainがアクティブになった場合にのみ切り替わります。
- アクティビティの種類：
  - `job`：ハイレベルなコマンド実行（`state: started|streaming|done|error`）。
  - `tool`：`phase: start|result`と`toolName`および`meta/args`。

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

- `idle`：通常のクリッター。
- `workingMain`：グリフ付きバッジ、フルティント、脚の「作業中」アニメーション。
- `workingOther`：グリフ付きバッジ、ミュートティント、スカリーなし。
- `overridden`：アクティビティに関係なく、選択されたグリフ/ティントを使用。

## ステータス行テキスト（メニュー）

- 作業がアクティブな間：`<セッションロール> · <アクティビティラベル>`
  - 例：`Main · exec: pnpm test`、`Other · read: apps/macos/Sources/OpenClaw/AppState.swift`。
- アイドル時：ヘルスサマリーにフォールバック。

## イベントインジェスチョン

- ソース：コントロールチャンネルの`agent`イベント（`ControlChannel.handleAgentEvent`）。
- パースされるフィールド：
  - `stream: "job"`と`data.state`（開始/停止用）。
  - `stream: "tool"`と`data.phase`、`name`、オプションの`meta`/`args`。
- ラベル：
  - `exec`：`args.command`の最初の行。
  - `read`/`write`：短縮パス。
  - `edit`：パスに加え`meta`/diff countから推測される変更の種類。
  - フォールバック：ツール名。

## デバッグオーバーライド

- Settings → Debug → 「Icon override」ピッカー：
  - `System (auto)`（デフォルト）
  - `Working: main`（ツール種類ごと）
  - `Working: other`（ツール種類ごと）
  - `Idle`
- `@AppStorage("iconOverride")`で保存され、`IconState.overridden`にマッピングされます。

## テストチェックリスト

- mainセッションのジョブをトリガー：アイコンが即座に切り替わり、ステータス行にmainラベルが表示されることを確認。
- mainがアイドルの状態でmain以外のセッションジョブをトリガー：アイコン/ステータスにmain以外が表示され、終了するまで安定していることを確認。
- 他がアクティブな状態でmainを開始：アイコンが即座にmainに切り替わることを確認。
- 高速なツールバースト：バッジがフリッカーしないことを確認（ツール結果のTTL猶予）。
- すべてのセッションがアイドルになるとヘルス行が再表示されることを確認。
