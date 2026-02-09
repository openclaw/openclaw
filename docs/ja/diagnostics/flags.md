---
summary: "対象を絞ったデバッグログのための診断フラグ"
read_when:
  - グローバルなログレベルを上げずに、対象を絞ったデバッグログが必要な場合
  - サポートのためにサブシステム固有のログを取得する必要がある場合
title: "診断フラグ"
---

# 診断フラグ

診断フラグを使用すると、全体で冗長なログを有効にすることなく、対象を絞ったデバッグログを有効化できます。フラグはオプトインであり、サブシステムがそれらをチェックしない限り影響はありません。 フラグはオプトインで、サブシステムがチェックしない限り効果はありません。

## How it works

- フラグは文字列です（大文字と小文字は区別されません）。
- 設定、または環境変数によるオーバーライドでフラグを有効化できます。
- ワイルドカードがサポートされています:
  - `telegram.*` は `telegram.http` にマッチします
  - `*` はすべてのフラグを有効化します

## 設定による有効化

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

フラグを変更した後は、ゲートウェイを再起動してください。

## Envオーバーライド（ワンオフ）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

すべてのフラグを無効化する場合:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## ログがどこに行くか

フラグは標準の診断ログファイルにログを出力します。デフォルトでは次の場所です: デフォルト:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` を設定した場合は、代わりにそのパスを使用してください。 `logging.file` を設定した場合は、そのパスが使用されます。ログは JSONL（1 行につき 1 つの JSON オブジェクト）です。リダクションは `logging.redactSensitive` に基づいて引き続き適用されます。 リアクションは `logging.redactSensitive` に基づいて適用されます。

## ログの抽出

最新のログファイルを選択します:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram の HTTP 診断ログでフィルタリングします:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

または、再現しながら tail します:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

リモートのゲートウェイでは、`openclaw logs --follow` も使用できます（[/cli/logs](/cli/logs) を参照）。

## 注記

- `logging.level` が `warn` より高く設定されている場合、これらのログは抑制される可能性があります。デフォルトの `info` で問題ありません。 デフォルトの `info` で問題ありません。
- フラグは有効のままでも安全です。特定のサブシステムに対するログ量にのみ影響します。
- ログの出力先、レベル、リダクションを変更するには、[/logging](/logging) を使用してください。
