---
name: walking-thoughts
description: Walking Thought Journal - 语音日记自动处理。收到语音消息时自动保存到日记系统。
---

# Walking Thought Journal (原散步思考记录系统)

## 项目信息

- **项目名称**: walking-thought-journal (英文名称)
- **项目路径**: `/Users/lizhihong/walking-thought-journal/`
- **原名**: 散步思考记录系统 (已更新为英文名称)

## 核心功能

1. **语音自动保存**: 收到语音消息 → 转录 → 保存为日记
2. **月度分析**: 每月1日自动生成分析报告

## 语音处理

### 触发条件

收到语音消息（已被Whisper转录为文本）

### 保存路径

```
/Users/lizhihong/walking-thought-journal/data/entries/YYYY-MM-DD_HHmmss.md
```

### 内容格式

```markdown
# 语音思考 (YYYY-MM-DD HH:mm)

[转录内容]

---

_记录于: YYYY-MM-DD HH:mm | 来源: Telegram_
```

### 处理后响应

"✅ 已保存思考记录"

## 月度分析

- **时间**: 每月1日 09:00 (Asia/Shanghai)
- **脚本**: `/Users/lizhihong/walking-thought-journal/scripts/monthly_report.py`
- **输出**: `/Users/lizhihong/walking-thought-journal/data/reports/monthly/monthly_report_YYYY_MM_timestamp.md`

## 目录结构

```
walking-thought-journal/
├── data/
│   ├── entries/       ← 日记条目（主存储）
│   ├── transcripts/   ← 原始转录
│   └── reports/monthly/ ← 月度报告
├── scripts/
│   ├── auto_process.py
│   ├── transcribe.py
│   └── monthly_report.py
├── config/
├── logs/
├── templates/
└── utils/
```

## 手动处理

```bash
# 处理音频文件
python3 /Users/lizhihong/walking-thought-journal/scripts/auto_process.py /path/to/audio.ogg --source telegram

# 生成月度报告
python3 /Users/lizhihong/walking-thought-journal/scripts/monthly_report.py
```

## 项目状态检查

```bash
# 检查项目状态
ls -la /Users/lizhihong/walking-thought-journal/

# 检查日记条目
ls -la /Users/lizhihong/walking-thought-journal/data/entries/

# 检查月度报告
ls -la /Users/lizhihong/walking-thought-journal/data/reports/monthly/
```

---

_版本: 2.1 | 更新: 2026-02-09 | 变更: 更新项目名称为英文 walking-thought-journal_
