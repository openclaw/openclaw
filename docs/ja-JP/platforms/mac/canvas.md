---
read_when:
    - macOS Canvasパネルを実装する場合
    - ビジュアルワークスペースにエージェントコントロールを追加する場合
    - WKWebViewのCanvasロードをデバッグする場合
summary: WKWebView + カスタムURLスキームで埋め込まれたエージェント制御のCanvasパネル
title: Canvas
x-i18n:
    generated_at: "2026-04-02T07:47:45Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b6c71763d693264d943e570a852208cce69fc469976b2a1cdd9e39e2550534c1
    source_path: platforms/mac/canvas.md
    workflow: 15
---

# Canvas（macOSアプリ）

macOSアプリは `WKWebView` を使用してエージェント制御の**Canvasパネル**を埋め込みます。HTML/CSS/JS、A2UI、および小規模なインタラクティブUI要素のための軽量なビジュアルワークスペースです。

## Canvasの保存場所

Canvasの状態はApplication Support以下に保存されます:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvasパネルは**カスタムURLスキーム**を介してこれらのファイルを配信します:

- `openclaw-canvas://<session>/<path>`

例:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

ルートに `index.html` が存在しない場合、アプリは**組み込みのスキャフォールドページ**を表示します。

## パネルの動作

- メニューバー（またはマウスカーソル）付近に固定される、ボーダーレスでリサイズ可能なパネル。
- セッションごとにサイズ/位置を記憶します。
- ローカルのCanvasファイルが変更されると自動リロードされます。
- 一度に表示されるCanvasパネルは1つだけです（必要に応じてセッションが切り替わります）。

Canvasは設定 → **Allow Canvas** から無効にできます。無効にすると、Canvasノードコマンドは `CANVAS_DISABLED` を返します。

## エージェントAPIサーフェス

Canvasは**Gateway ゲートウェイWebSocket**を介して公開されるため、エージェントは以下の操作が可能です:

- パネルの表示/非表示
- パスまたはURLへのナビゲーション
- JavaScriptの実行
- スナップショット画像のキャプチャ

CLIの例:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

注意事項:

- `canvas.navigate` は**ローカルCanvasパス**、`http(s)` URL、`file://` URLを受け付けます。
- `"/"` を渡すと、Canvasはローカルのスキャフォールドまたは `index.html` を表示します。

## Canvas内のA2UI

A2UIはGateway ゲートウェイのCanvasホストによってホストされ、Canvasパネル内でレンダリングされます。Gateway ゲートウェイがCanvasホストをアドバタイズすると、macOSアプリは初回オープン時にA2UIホストページへ自動ナビゲーションします。

デフォルトのA2UIホストURL:

```
http://<gateway-host>:18789/__openclaw__/a2ui/
```

### A2UIコマンド（v0.8）

Canvasは現在 **A2UI v0.8** のサーバー→クライアントメッセージを受け付けます:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface`（v0.9）はサポートされていません。

CLIの例:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

簡易テスト:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvasからエージェント実行をトリガーする

Canvasはディープリンクを介して新しいエージェント実行をトリガーできます:

- `openclaw://agent?...`

例（JSの場合）:

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

有効なキーが提供されない限り、アプリは確認を求めます。

## セキュリティに関する注意事項

- Canvasスキームはディレクトリトラバーサルをブロックします。ファイルはセッションルート以下に存在する必要があります。
- ローカルCanvasコンテンツはカスタムスキームを使用します（local loopbackサーバーは不要です）。
- 外部の `http(s)` URLは、明示的にナビゲーションされた場合にのみ許可されます。
