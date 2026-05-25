# starter-imperative — 命令式 Pack 示例

**直接原语**：事件触发 + 直接调用核心原语，无需通用框架。

## 演示功能

### echo_message.yaml — 消息回显

- 事件模式触发（监听 `starter.echo_requested` 事件）
- 直接使用 `comms.send` 原语回复消息
- 记录审计日志

### kb_lookup.yaml — 知识库查询

- 事件触发，监听 `starter.lookup_requested`
- 调用 `kb.search` 检索知识库
- 条件分支：有结果则回复，无结果则提示
- 演示 `condition` + `then/else` 结构

## 使用方式

```bash
# 将此目录放到 packs 路径下
cp -r contrib/examples/starter-imperative ~/.claworks/packs/

# 测试消息回显
node claworks.mjs event publish starter.echo_requested '{"text": "hello", "channel": "feishu"}'

# 测试知识库查询
node claworks.mjs event publish starter.lookup_requested '{"query": "请假流程"}'
```

## 文件结构

```
starter-imperative/
├── pack.json                    # Pack 清单（必须）
└── playbooks/
    ├── echo_message.yaml        # 消息回显 Playbook（最简命令式）
    └── kb_lookup.yaml           # 知识库查询 Playbook（条件分支示例）
```

## 升级为混合模式（加入 TypeScript）

如需更复杂的逻辑，添加 `index.ts` 并在 `pack.json` 加入 `"entry": "index.js"`：

```typescript
// index.ts
import type { PackFactory } from "@claworks/runtime";

const factory: PackFactory = (runtime) => ({
  scripts: [
    {
      id: "my-script",
      name: "我的脚本",
      run: async (params) => {
        return { result: `处理完毕: ${JSON.stringify(params)}` };
      },
    },
  ],
  onLoad: async (rt) => {
    rt.logger?.("[starter-imperative] Pack 已加载");
  },
});

export default factory;
```

## 关键原语

| 原语                      | 说明                        |
| ------------------------- | --------------------------- |
| `trigger.kind: event`     | 事件触发，支持 pattern 匹配 |
| `comms.send`              | 发送消息到 IM 渠道          |
| `kb.search`               | 检索知识库，返回最相关条目  |
| `condition` + `then/else` | 条件分支，支持嵌套步骤      |
| `observe.audit_log`       | 记录审计日志                |
