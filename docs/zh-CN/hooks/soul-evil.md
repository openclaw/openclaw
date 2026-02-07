---
read_when:
  - 你想要启用或调整 SOUL Evil 钩子
  - 你想要设置清除窗口或随机概率的人格替换
summary: SOUL Evil 钩子（将 SOUL.md 替换为 SOUL_EVIL.md）
title: SOUL Evil 钩子
x-i18n:
  generated_at: "2026-02-01T20:42:18Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: cc32c1e207f2b6923a6ede8299293f8fc07f3c8d6b2a377775237c0173fe8d1b
  source_path: hooks/soul-evil.md
  workflow: 14
---

# SOUL Evil 钩子

SOUL Evil 钩子在清除窗口期间或随机概率下，将**注入的** `SOUL.md` 内容替换为 `SOUL_EVIL.md`。它**不会**修改磁盘上的文件。

## 工作原理

当 `agent:bootstrap` 运行时，该钩子可以在系统提示词组装之前，在内存中替换 `SOUL.md` 的内容。如果 `SOUL_EVIL.md` 缺失或为空，OpenClaw 会记录警告并保留正常的 `SOUL.md`。

子智能体运行**不会**在其引导文件中包含 `SOUL.md`，因此此钩子对子智能体没有影响。

## 启用

```bash
openclaw hooks enable soul-evil
```

然后设置配置：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

在智能体工作区根目录（`SOUL.md` 旁边）创建 `SOUL_EVIL.md`。

## 选项

- `file`（字符串）：替代的 SOUL 文件名（默认：`SOUL_EVIL.md`）
- `chance`（数字 0–1）：每次运行使用 `SOUL_EVIL.md` 的随机概率
- `purge.at`（HH:mm）：每日清除开始时间（24 小时制）
- `purge.duration`（时长）：窗口长度（例如 `30s`、`10m`、`1h`）

**优先级：** 清除窗口优先于随机概率。

**时区：** 设置了 `agents.defaults.userTimezone` 时使用该时区；否则使用主机时区。

## 注意事项

- 不会在磁盘上写入或修改任何文件。
- 如果 `SOUL.md` 不在引导列表中，该钩子不执行任何操作。

## 另请参阅

- [钩子](/automation/hooks)
