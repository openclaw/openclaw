---
read_when:
    - セマンティックメモリのインデックスや検索をしたい
    - メモリの可用性やインデックスをデバッグしている
summary: '`openclaw memory`（ステータス/インデックス/検索）のCLIリファレンス'
title: memory
x-i18n:
    generated_at: "2026-04-02T07:33:53Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a5b73731b37e1d3f6d0ddb17d58077a76d85d531ead51f59611e254d94337ba0
    source_path: cli/memory.md
    workflow: 15
---

# `openclaw memory`

セマンティックメモリのインデックスと検索を管理します。
アクティブなメモリプラグインによって提供されます（デフォルト: `memory-core`。無効にするには`plugins.slots.memory = "none"`を設定）。

関連:

- メモリの概念: [メモリ](/concepts/memory)
- プラグイン: [プラグイン](/tools/plugin)

## 例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## オプション

`memory status`と`memory index`:

- `--agent <id>`: 単一のエージェントにスコープを限定します。指定しない場合、これらのコマンドは設定された各エージェントに対して実行されます。エージェントリストが設定されていない場合は、デフォルトのエージェントにフォールバックします。
- `--verbose`: プローブおよびインデックス中に詳細なログを出力します。

`memory status`:

- `--deep`: ベクトル＋埋め込みの可用性をプローブします。
- `--index`: ストアがダーティな場合に再インデックスを実行します（`--deep`を含みます）。
- `--json`: JSON出力を表示します。

`memory index`:

- `--force`: 完全な再インデックスを強制します。

`memory search`:

- クエリ入力: 位置引数`[query]`または`--query <text>`のいずれかを渡します。
- 両方が指定された場合、`--query`が優先されます。
- どちらも指定されない場合、コマンドはエラーで終了します。
- `--agent <id>`: 単一のエージェントにスコープを限定します（デフォルト: デフォルトエージェント）。
- `--max-results <n>`: 返される結果の数を制限します。
- `--min-score <n>`: 低スコアのマッチを除外します。
- `--json`: JSON結果を表示します。

注意事項:

- `memory index --verbose`はフェーズごとの詳細（プロバイダー、モデル、ソース、バッチアクティビティ）を表示します。
- `memory status`には`memorySearch.extraPaths`で設定された追加パスも含まれます。
- 実質的にアクティブなメモリリモートAPIキーフィールドがSecretRefとして設定されている場合、コマンドはアクティブなGateway ゲートウェイスナップショットからそれらの値を解決します。Gateway ゲートウェイが利用できない場合、コマンドは即座に失敗します。
- Gateway ゲートウェイバージョンスキューに関する注意: このコマンドパスは`secrets.resolve`をサポートするGateway ゲートウェイが必要です。古いGateway ゲートウェイはunknown-methodエラーを返します。
