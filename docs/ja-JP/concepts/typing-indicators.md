---
read_when:
    - タイピングインジケーターの動作やデフォルト設定を変更する場合
summary: OpenClawがタイピングインジケーターを表示するタイミングと調整方法
title: タイピングインジケーター
x-i18n:
    generated_at: "2026-04-02T07:40:02Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8ee82d02829c4ff58462be8bf5bb52f23f519aeda816c2fd8a583e7a317a2e98
    source_path: concepts/typing-indicators.md
    workflow: 15
---

# タイピングインジケーター

タイピングインジケーターは、実行がアクティブな間にチャットチャネルへ送信されます。
`agents.defaults.typingMode` でタイピングが**いつ**開始されるかを制御し、`typingIntervalSeconds`
で**どのくらいの頻度で**リフレッシュされるかを制御します。

## デフォルト

`agents.defaults.typingMode` が**未設定**の場合、OpenClawはレガシー動作を維持します：

- **ダイレクトチャット**: モデルループが開始されるとすぐにタイピングが始まります。
- **メンション付きのグループチャット**: タイピングはすぐに開始されます。
- **メンションなしのグループチャット**: メッセージテキストのストリーミングが始まった時点でタイピングが開始されます。
- **ハートビート実行**: タイピングは無効です。

## モード

`agents.defaults.typingMode` を以下のいずれかに設定します：

- `never` — タイピングインジケーターを一切表示しません。
- `instant` — 実行が後でサイレントリプライトークンのみを返す場合でも、**モデルループが開始されるとすぐに**タイピングを開始します。
- `thinking` — **最初の推論デルタ**でタイピングを開始します（実行に
  `reasoningLevel: "stream"` が必要です）。
- `message` — **最初の非サイレントテキストデルタ**でタイピングを開始します（`NO_REPLY`
  サイレントトークンは無視されます）。

「どれだけ早く発火するか」の順序：
`never` → `message` → `thinking` → `instant`

## 設定

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

セッションごとにモードやケイデンスをオーバーライドできます：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事項

- `message` モードは、サイレントのみのリプライ（例：出力を抑制するために使用される `NO_REPLY`
  トークン）に対してタイピングを表示しません。
- `thinking` は、実行が推論をストリーミングする場合（`reasoningLevel: "stream"`）にのみ発火します。
  モデルが推論デルタを出力しない場合、タイピングは開始されません。
- ハートビートは、モードに関係なくタイピングを表示しません。
- `typingIntervalSeconds` は開始時間ではなく、**リフレッシュのケイデンス**を制御します。
  デフォルトは6秒です。
