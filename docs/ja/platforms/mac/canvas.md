---
summary: "WKWebView とカスタム URL スキームを介して埋め込まれた、エージェント制御の Canvas パネル"
read_when:
  - macOS Canvas パネルを実装する場合
  - 視覚的ワークスペース向けのエージェント制御を追加する場合
  - WKWebView の Canvas 読み込みをデバッグする場合
title: "Canvas"
---

# Canvas（macOS アプリ）

macOS アプリは、`WKWebView` を使用して、エージェント制御の **Canvas パネル** を埋め込みます。これは、HTML/CSS/JS、A2UI、および小規模なインタラクティブ UI サーフェス向けの軽量な視覚的ワークスペースです。 It
は、HTML/CSS/JS、A2UI、小型対話型
UI サーフェス用の軽量なビジュアルワークスペースです。

## Canvas の保存場所

Canvas の状態は Application Support 配下に保存されます。

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas パネルは、**カスタム URL スキーム** を介してこれらのファイルを提供します。

- `openclaw-canvas://<session>/<path>`

例:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

ルートに `index.html` が存在しない場合、アプリは **組み込みのスキャフォールドページ** を表示します。

## パネルの挙動

- メニューバー（またはマウスカーソル）付近に固定される、枠線なしでサイズ変更可能なパネルです。
- セッションごとにサイズと位置を記憶します。
- ローカルの Canvas ファイルが変更されると自動的に再読み込みします。
- 同時に表示される Canvas パネルは 1 つのみです（必要に応じてセッションが切り替わります）。

キャンバスは設定 → **キャンバスを許可**から無効にできます。 Canvas は、設定 → **Allow Canvas** から無効化できます。無効化すると、canvas ノードのコマンドは `CANVAS_DISABLED` を返します。

## エージェント API の提供範囲

Canvas は **Gateway WebSocket** を介して公開されているため、エージェントは次を実行できます。

- パネルの表示／非表示
- パスまたは URL へのナビゲーション
- JavaScript の評価
- スナップショット画像の取得

CLI の例:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

注記:

- `canvas.navigate` は **ローカル Canvas のパス**、`http(s)` の URL、および `file://` の URL を受け付けます。
- `"/"` を渡すと、Canvas はローカルのスキャフォールド、または `index.html` を表示します。

## Canvas における A2UI

A2UI はゲートウェイの canvas ホストによってホストされ、Canvas パネル内でレンダリングされます。
A2UI は Gateway の canvas host によってホストされ、Canvas パネル内にレンダリングされます。Gateway が Canvas host をアドバタイズすると、macOS アプリは初回オープン時に A2UI host ページへ自動的にナビゲートします。

デフォルトの A2UI host URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI コマンド（v0.8）

Canvas は現在、**A2UI v0.8** の server→client メッセージを受け付けます。

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface`（v0.9）はサポートされていません。

CLI の例:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

クイックスモーク:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas からエージェント実行をトリガーする

Canvas はディープリンクを介して新しいエージェント実行をトリガーできます。

- `openclaw://agent?...`

例（JS）:

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

有効なキーが提供されていない場合、アプリは確認を求めます。

## セキュリティに関する注記

- Canvas スキームはディレクトリトラバーサルをブロックします。ファイルはセッションルート配下に存在する必要があります。
- ローカルの Canvas コンテンツはカスタムスキームを使用します（ループバックサーバーは不要です）。
- 外部の `http(s)` URL は、明示的にナビゲートされた場合にのみ許可されます。
