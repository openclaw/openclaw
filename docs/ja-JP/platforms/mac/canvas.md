---
summary: "WKWebView + カスタムURLスキームで埋め込まれたエージェント制御のCanvasパネル"
read_when:
  - macOS Canvasパネルの実装
  - ビジュアルワークスペースへのエージェントコントロールの追加
  - WKWebView Canvasロードのデバッグ
title: "Canvas"
---

# Canvas（macOSアプリ）

macOSアプリは`WKWebView`を使用してエージェント制御の**Canvasパネル**を埋め込みます。HTML/CSS/JS、A2UI、および小さなインタラクティブUIサーフェスのための軽量なビジュアルワークスペースです。

## Canvasの保存場所

Canvasの状態はApplication Support配下に保存されます：

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvasパネルは**カスタムURLスキーム**を介してこれらのファイルを提供します：

- `openclaw-canvas://<session>/<path>`

例：

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

ルートに`index.html`が存在しない場合、アプリは**ビルトインのスキャフォールドページ**を表示します。

## パネルの動作

- メニューバー（またはマウスカーソル）付近に固定されたボーダーレスでリサイズ可能なパネルです。
- セッションごとにサイズ/位置を記憶します。
- ローカルCanvasファイルが変更されると自動リロードします。
- 一度に表示されるCanvasパネルは1つだけです（必要に応じてセッションが切り替わります）。

Canvasは設定 → **Allow Canvas** から無効化できます。無効化すると、Canvasノードコマンドは`CANVAS_DISABLED`を返します。

## エージェントAPIサーフェス

Canvasは**Gateway WebSocket**を介して公開されるため、エージェントは以下の操作が可能です：

- パネルの表示/非表示
- パスまたはURLへのナビゲーション
- JavaScriptの実行
- スナップショット画像のキャプチャ

CLIの例：

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

注意事項：

- `canvas.navigate`は**ローカルCanvasパス**、`http(s)` URL、`file://` URLを受け付けます。
- `"/"`を渡すと、Canvasはローカルスキャフォールドまたは`index.html`を表示します。

## CanvasでのA2UI

A2UIはGateway Canvas Hostによってホストされ、Canvasパネル内でレンダリングされます。GatewayがCanvas Hostをアドバタイズすると、macOSアプリは最初のオープン時にA2UIホストページに自動ナビゲートします。

デフォルトのA2UIホストURL：

```
http://<gateway-host>:18789/__openclaw__/a2ui/
```

### A2UIコマンド（v0.8）

Canvasは現在、**A2UI v0.8**のサーバー→クライアントメッセージを受け付けます：

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface`（v0.9）はサポートされていません。

CLIの例：

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

簡易スモークテスト：

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvasからのエージェント実行のトリガー

Canvasはディープリンクを介して新しいエージェント実行をトリガーできます：

- `openclaw://agent?...`

例（JSの場合）：

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

有効なキーが提供されない限り、アプリは確認を求めます。

## セキュリティに関する注意事項

- Canvasスキームはディレクトリトラバーサルをブロックします。ファイルはセッションルート配下に存在する必要があります。
- ローカルCanvasコンテンツはカスタムスキームを使用します（ループバックサーバーは不要です）。
- 外部の`http(s)` URLは明示的にナビゲートされた場合にのみ許可されます。
