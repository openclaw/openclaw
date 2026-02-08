---
summary: "「openclaw memory」（status/index/search）の CLI リファレンスです。"
read_when:
  - セマンティックメモリをインデックス化または検索したい場合
  - メモリの可用性やインデックス作成のデバッグを行っている場合
title: "メモリ"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:09Z
---

# `openclaw memory`

セマンティックメモリのインデックス作成と検索を管理します。  
アクティブなメモリプラグインによって提供されます（デフォルト：`memory-core`。無効化するには `plugins.slots.memory = "none"` を設定してください）。

関連項目：

- メモリの概念：[Memory](/concepts/memory)
- プラグイン：[Plugins](/tools/plugin)

## 例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## オプション

共通：

- `--agent <id>`：単一のエージェントにスコープします（デフォルト：設定されているすべてのエージェント）。
- `--verbose`：プローブおよびインデックス作成中に詳細なログを出力します。

注記：

- `memory status --deep` は、ベクターおよび埋め込みの可用性をプローブします。
- `memory status --deep --index` は、ストアがダーティな場合に再インデックスを実行します。
- `memory index --verbose` は、フェーズごとの詳細（プロバイダー、モデル、ソース、バッチの活動）を出力します。
- `memory status` には、`memorySearch.extraPaths` を介して設定された追加のパスが含まれます。
