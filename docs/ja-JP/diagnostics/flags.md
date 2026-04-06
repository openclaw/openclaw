---
read_when:
    - グローバルなログレベルを上げずに特定のデバッグログが必要な場合
    - サポート向けにサブシステム固有のログを取得する必要がある場合
summary: 特定のデバッグログを出力するための診断フラグ
title: 診断フラグ
x-i18n:
    generated_at: "2026-04-02T07:40:28Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: daf0eca0e6bd1cbc2c400b2e94e1698709a96b9cdba1a8cf00bd580a61829124
    source_path: diagnostics/flags.md
    workflow: 15
---

# 診断フラグ

診断フラグを使用すると、すべてのログを詳細モードにすることなく、特定のデバッグログを有効にできます。フラグはオプトイン方式で、サブシステムがチェックしない限り効果はありません。

## 仕組み

- フラグは文字列です（大文字小文字を区別しません）。
- 設定ファイルまたは環境変数のオーバーライドでフラグを有効にできます。
- ワイルドカードがサポートされています：
  - `telegram.*` は `telegram.http` にマッチします
  - `*` はすべてのフラグを有効にします

## 設定ファイルで有効にする

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

複数のフラグ：

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

フラグを変更した後は Gateway ゲートウェイを再起動してください。

## 環境変数によるオーバーライド（一回限り）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

すべてのフラグを無効にする：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## ログの出力先

フラグは標準の診断ログファイルにログを出力します。デフォルトの場所：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` を設定している場合は、そのパスが代わりに使用されます。ログはJSONL形式（1行に1つのJSONオブジェクト）です。`logging.redactSensitive` に基づくリダクションは引き続き適用されます。

## ログの抽出

最新のログファイルを選択：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP診断でフィルタリング：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

または再現中にtailで追跡：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

リモートの Gateway ゲートウェイの場合は、`openclaw logs --follow` も使用できます（[/cli/logs](/cli/logs) を参照）。

## 注意事項

- `logging.level` が `warn` より高く設定されている場合、これらのログは抑制される可能性があります。デフォルトの `info` であれば問題ありません。
- フラグは有効のままにしておいても安全です。特定のサブシステムのログ量にのみ影響します。
- ログの出力先、レベル、リダクションを変更するには [/logging](/logging) を使用してください。
