---
summary: "プラグインでエージェントツール（スキーマ、任意ツール、許可リスト）を作成します"
read_when:
  - プラグインに新しいエージェントツールを追加したい場合
  - 許可リストによってツールをオプトインにする必要がある場合
title: "プラグインのエージェントツール"
---

# プラグインのエージェントツール

OpenClaw プラグインは、エージェント実行中に LLM に公開される **エージェントツール**（JSON‑schema 関数）を登録できます。ツールは **必須**（常に利用可能）または **任意**（オプトイン）にできます。 2. ツールは **必須**（常に利用可能）または
**オプション**（オプトイン）にすることができます。

エージェントツールは、メイン設定の `tools`、またはエージェントごとの `agents.list[].tools` 配下で設定します。許可リスト／拒否リストのポリシーにより、エージェントが呼び出せるツールが制御されます。 許可リスト/デニリストポリシーは、エージェント
が呼び出せるツールを制御します。

## 基本的なツール

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

## 任意ツール（オプトイン）

任意ツールは **自動では有効化されません**。ユーザーがエージェントの許可リストに追加する必要があります。 ユーザーはエージェント
許可リストに追加する必要があります。

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

`agents.list[].tools.allow`（またはグローバルの `tools.allow`）で任意ツールを有効化します。

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

ツールの利用可否に影響するその他の設定項目：

- プラグインツールのみを指定した許可リストは、プラグインのオプトインとして扱われます。コアツールは、許可リストにコアツールやグループを含めない限り、有効のままです。
- `tools.profile` / `agents.list[].tools.profile`（ベース許可リスト）
- `tools.byProvider` / `agents.list[].tools.byProvider`（プロバイダー固有の許可／拒否）
- `tools.sandbox.tools.*`（サンドボックス化時のサンドボックスツールポリシー）

## ルールとヒント

- ツール名はコアツール名と **衝突してはいけません**。衝突するツールはスキップされます。
- 許可リストで使用するプラグイン ID は、コアツール名と衝突してはいけません。
- 副作用を引き起こす、または追加のバイナリ／資格情報を必要とするツールには、`optional: true` の使用を推奨します。
