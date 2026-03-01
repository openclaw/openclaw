---
summary: "`openclaw memory` のCLIリファレンス（status/index/search）"
read_when:
  - セマンティックメモリのインデックス作成や検索を行いたい場合
  - メモリの可用性やインデックス作成をデバッグしている場合
title: "memory"
---

# `openclaw memory`

セマンティックメモリのインデックス作成と検索を管理します。
アクティブなメモリプラグインによって提供されます（デフォルト：`memory-core`、無効にするには `plugins.slots.memory = "none"` を設定）。

関連：

- メモリの概念：[Memory](/concepts/memory)
- プラグイン：[Plugins](/tools/plugin)

## 使用例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory search --query "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## オプション

共通：

- `--agent <id>`: 単一のエージェントにスコープを限定します（デフォルト：設定済みの全エージェント）。
- `--verbose`: プローブやインデックス作成中に詳細ログを出力します。

`memory search`:

- クエリ入力：位置引数の `[query]` または `--query <text>` のいずれかを渡します。
- 両方が指定された場合、`--query` が優先されます。
- どちらも指定されない場合、コマンドはエラーで終了します。

注意事項：

- `memory status --deep` はベクトル + エンベディングの可用性をプローブします。
- `memory status --deep --index` はストアがダーティな場合にリインデックスを実行します。
- `memory index --verbose` はフェーズごとの詳細（プロバイダー、モデル、ソース、バッチアクティビティ）を表示します。
- `memory status` には `memorySearch.extraPaths` で設定された追加パスも含まれます。
