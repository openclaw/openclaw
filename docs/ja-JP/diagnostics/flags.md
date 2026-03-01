---
summary: "ターゲットを絞ったデバッグログのための診断フラグ"
read_when:
  - グローバルなログレベルを上げずにターゲットを絞ったデバッグログが必要な場合
  - サポート向けにサブシステム固有のログをキャプチャする必要がある場合
title: "診断フラグ"
---

# 診断フラグ

診断フラグを使用すると、詳細ログをすべての場所で有効にすることなく、ターゲットを絞ったデバッグログを有効にできます。フラグはオプトインであり、サブシステムがチェックしない限り効果はありません。

## 仕組み

- フラグは文字列です（大文字・小文字を区別しません）。
- 設定または環境変数のオーバーライドでフラグを有効にできます。
- ワイルドカードがサポートされています。
  - `telegram.*` は `telegram.http` にマッチします
  - `*` はすべてのフラグを有効にします

## 設定で有効化

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

複数のフラグ:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

フラグを変更した後は Gateway を再起動してください。

## 環境変数でのオーバーライド（ワンオフ）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

すべてのフラグを無効化:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## ログの出力先

フラグは標準の診断ログファイルにログを出力します。デフォルト:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` を設定した場合は、そのパスが使用されます。ログは JSONL 形式です（1 行に 1 つの JSON オブジェクト）。`logging.redactSensitive` に基づいて難読化が引き続き適用されます。

## ログの抽出

最新のログファイルを取得:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP 診断でフィルタリング:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

または再現中にテール:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

リモート Gateway の場合は、`openclaw logs --follow` も使用できます（[/cli/logs](/cli/logs) を参照）。

## 注意事項

- `logging.level` が `warn` より高く設定されている場合、これらのログが抑制されることがあります。デフォルトの `info` は問題ありません。
- フラグは有効のままにしておいても安全です。特定のサブシステムのログ量にのみ影響します。
- ログの出力先、レベル、難読化を変更するには [/logging](/logging) を使用してください。
