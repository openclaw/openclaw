---
name: "cursor-operator"
description: "Guides opening the Cursor app and executing workspace changes. Invoke when users want Cursor-driven input or to control Cursor actions."
---

# Cursor Operator

## 适用场景

- 用户希望通过 Cursor 执行需求、生成修改或运行项目操作
- 用户要求在 Cursor 中输入需求并执行

## 能力边界

- 如果没有桌面级自动化能力，无法直接在 Cursor 内自动键入
- 仍可通过工作区文件修改与本地命令完成同等效果

## 操作流程

1. 使用 app_control 打开 Cursor（如果在 macOS 上）
2. 明确需求并直接修改仓库文件来实现目标
3. 必要时提示用户在 Cursor 中查看改动或自行执行 UI 内操作
4. 若需要日志或运行结果，使用本地命令或 log tail 读取

## 示例

```json
{
  "action": "open",
  "app": "Cursor"
}
```
