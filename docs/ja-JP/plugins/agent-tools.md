---
summary: "プラグインでエージェントツールを作成する（スキーマ、オプションツール、許可リスト）"
read_when:
  - プラグインに新しいエージェントツールを追加したい場合
  - 許可リストでツールをオプトインにする必要がある場合
title: "プラグインエージェントツール"
---

# プラグインエージェントツール

OpenClaw プラグインは、エージェント実行中に LLM に公開される**エージェントツール**（JSON スキーマ関数）を登録できます。ツールは**必須**（常に利用可能）または**オプション**（オプトイン）にすることができます。

エージェントツールは、メイン設定の `tools` の下、またはエージェントごとに `agents.list[].tools` の下で設定されます。許可リスト/拒否リストのポリシーがエージェントが呼び出せるツールを制御します。

## 基本ツール

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## オプションツール（オプトイン）

オプションツールは**自動的に有効化されることはありません**。ユーザーはエージェントの許可リストに追加する必要があります。

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

`agents.list[].tools.allow`（またはグローバルの `tools.allow`）でオプションツールを有効にします。

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // 特定のツール名
            "workflow", // プラグイン ID（そのプラグインのすべてのツールを有効化）
            "group:plugins", // すべてのプラグインツール
          ],
        },
      },
    ],
  },
}
```

ツールの可用性に影響するその他の設定:

- プラグインツールのみをリストした許可リストはプラグインのオプトインとして扱われます。コアツールは、許可リストにコアツールやグループを含めない限り有効のままです。
- `tools.profile` / `agents.list[].tools.profile`（ベース許可リスト）
- `tools.byProvider` / `agents.list[].tools.byProvider`（プロバイダー固有の許可/拒否）
- `tools.sandbox.tools.*`（サンドボックス化された場合のサンドボックスツールポリシー）

## ルールとヒント

- ツール名はコアのツール名と**衝突してはなりません**。競合するツールはスキップされます。
- 許可リストで使用されるプラグイン ID はコアのツール名と衝突してはなりません。
- 副作用を引き起こすツールや追加のバイナリ/認証情報が必要なツールには `optional: true` を優先してください。
