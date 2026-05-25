# starter-declarative — 声明式 Pack 示例

**零代码**：只需 YAML，无需任何 TypeScript。

## 演示功能

- 定时触发（工作日每天上午 9 点）
- 调用通用 Playbook `process.scheduled_broadcast` 广播消息

## 使用方式

```bash
# 将此目录放到 packs 路径下即可生效
cp -r contrib/examples/starter-declarative ~/.claworks/packs/

# 触发健康检查验证加载
node claworks.mjs health
# 或：pnpm claworks:start 后访问 Studio
```

## 文件结构

```
starter-declarative/
├── pack.json                    # Pack 清单（必须）
└── playbooks/
    └── morning_greeting.yaml    # 定时早安广播 Playbook
```

## 关键原语

| 原语                          | 说明                              |
| ----------------------------- | --------------------------------- |
| `trigger.kind: schedule`      | 定时触发，支持 cron               |
| `call_playbook`               | 调用通用 Playbook 框架            |
| `process.scheduled_broadcast` | 核心 Pack 提供的通用广播 Playbook |
