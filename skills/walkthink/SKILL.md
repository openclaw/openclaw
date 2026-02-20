---
name: walkthink
description: WalkThink 语音日记自动处理系统 - 收到语音消息时自动保存到日记系统
---

# WalkThink 技能

散步思考记录系统（现名 WalkThink）的语音日记自动处理。

## 核心机制

**注意**：WalkThink 主要通过 SOUL.md 规则自动触发，不是通过技能选择机制。

### 自动触发规则（SOUL.md）

当用户发送语音时，**由 `discord_poller.py` 自动处理**。  
Agent 不直接执行 `auto_process.py`，避免重复处理与重复建档。

## 功能

- **自动语音转文字**：使用 Whisper 或本地语音识别
- **智能日记生成**：创建结构化日记条目
- **会话管理**：智能合并30分钟内的语音会话
- **内容分类**：自动分类（工作/学习/思考/生活/技术/创意）
- **关键词提取**：自动提取思考关键词
- **情感分析**：分析语音内容的情感倾向

## 三大优化功能

1. **智能会话合并**：30分钟内语音自动合并为同一会话
2. **语音分类**：自动按主题分类
3. **关键词提取**：提取核心思考关键词

## 处理模式

- **smart_session**（默认）：智能合并30分钟内会话
- **daily**：按天合并所有语音
- **separate**：每个语音单独处理

## 项目结构

```
/Users/lizhihong/WalkThink/
├── scripts/
│   ├── auto_process.py      # 自动处理脚本
│   ├── weekly_report.py     # 周报分析
│   ├── monthly_report.py    # 月度分析
│   └── walkthink_smart_processor.py  # 智能处理器
├── data/
│   ├── entries/             # 日记条目
│   ├── reports/             # 分析报告
│   └── recovery_state.json  # 恢复状态
└── logs/                    # 系统日志
```

## 定时任务

- **周报推送**：每周六晚19:00（Asia/Shanghai）
- **月度报告**：每月1日早9:00（Asia/Shanghai）
- **智能补推**：系统重启后自动补推错过的报告

## 集成状态

- **OpenClaw 集成**：✓ 已集成（通过 SOUL.md 规则）
- **Discord 通道**：✓ 已配置（频道: #walkthink）
- **实时处理**：✓ 支持（MacBook "open" 状态时）
- **离线处理**：✗ 不支持（简化设计）

## 使用说明

1. **自动处理**：发送语音到 Discord #walkthink → poller 自动处理
2. **手动检查**：运行 `voice-diary sync` 检查漏跑任务
3. **查看日记**：日记保存在 `data/entries/` 目录
4. **查看报告**：周报/月报在 `data/reports/` 目录

## 注意事项

- 真正的 WalkThink 功能通过 SOUL.md 规则自动生效
- 此技能文档仅作为系统参考
- 如需修改规则，请更新 SOUL.md 文件
