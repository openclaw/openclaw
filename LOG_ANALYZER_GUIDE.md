# OpenClaw 日志分析器使用指南

## 概述

`openclaw-log-analyzer.py` 是一个强大的日志分析工具，用于从 OpenClaw 的 JSON 日志中提取完整的对话流程和执行详情。

## 功能特性

### ✅ 完整提取内容

1. **时间戳** - 精确到毫秒
2. **系统 Prompt** - 包括模型、思考级别、可用工具列表
3. **用户 Session** - Session ID 和 Run ID
4. **用户 Query** - 完整的用户输入
5. **大模型思考过程**
   - 思考总结（fullThinking）
   - 子任务思考（inline thinking 块）
   - 思考签名（thoughtSignature）
6. **工具调用**
   - 工具名称和 ID
   - 完整参数（明文显示）
   - 工具类型识别（Skill/Tool/API/CLI/Subagent）
7. **工具执行结果** - 包括成功/错误状态
8. **大模型回复** - 最终答案
9. **任务耗时** - 每个轮次的执行时间

### 🎯 按时间线排序

所有操作按照实际发生时间严格排序，构成完整的 Action List。

## ⚙️ 前置要求

### 启用详细日志

为了让日志分析器提取完整的对话信息，你需要在 OpenClaw 配置中启用 **debug 日志级别**：

**配置文件**：`~/.openclaw/openclaw.json`

```json
{
  "logging": {
    "level": "debug",                           // ✅ 必须设置为 debug
    "file": "/tmp/openclaw/openclaw-{DATE}.log"
  }
}
```

**重要说明**：

- 🔴 **默认 `info` 级别不会记录详细的 Prompt、LLM 思考过程和回复内容**
- ✅ **`debug` 级别会记录所有详细信息**（系统 Prompt、用户输入、LLM 思考、工具调用参数、完整结果等）
- ⚠️ **`debug` 日志会更大**，但包含完整的诊断信息
- 💡 **仅在需要分析时启用**，平时可以使用 `info` 级别以减少日志量

**修改配置后，重启 OpenClaw Gateway**：

```bash
# 停止 OpenClaw
pkill -f openclaw

# 重新启动
openclaw gateway
```

## 使用方法

### 基本用法

```bash
# 分析今天的日志
python3 openclaw-log-analyzer.py logs/openclaw-$(date +%Y-%m-%d).log

# 分析指定日期的日志
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log
```

### 显示统计信息

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats
```

统计信息包括：

- 操作类型分布
- 工具使用频率
- 会话和运行数
- 任务平均/最大/最小耗时

### 导出为 JSON

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --json analysis.json
```

导出的 JSON 可以用于进一步的自动化分析和处理。

### 组合使用

```bash
# 分析、显示统计并导出 JSON
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats --json analysis.json
```

## 输出格式说明

### 对话轮次

每个对话轮次包含：

- Run ID
- Session ID
- 按时间顺序的所有操作

### 操作类型

| 图标 | 类型        | 说明                   |
| ---- | ----------- | ---------------------- |
| 👤   | 用户查询    | 用户的输入             |
| ⚙️   | 系统 Prompt | LLM 的系统提示词和配置 |
| 🧠   | 思考总结    | LLM 的完整思考过程汇总 |
| 💭   | 思考子任务  | LLM 思考过程中的子任务 |
| 🔧   | 工具调用    | LLM 调用的工具及其参数 |
| 📦   | 工具结果    | 工具执行的返回结果     |
| 🤖   | 模型回复    | LLM 给用户的最终回答   |
| ⏹️   | 任务结束    | 任务完成和耗时信息     |

### 工具类型识别

分析器会自动识别工具类型并标注：

- **Subagent** - 子代理
- **Weather Skill** - 天气技能
- **GitHub Skill** - GitHub 技能
- **Apple Notes Skill** - Apple 笔记技能
- **Apple Reminders Skill** - Apple 提醒技能
- **Web Search API** - 网页搜索
- **Web Fetch API** - 网页获取
- **Memory Search/Get** - 记忆搜索
- **File Tool** - 文件操作
- **Browser Tool** - 浏览器操作
- **Shell Command** - Shell 命令
- **API Call** - API 调用

## 输出示例

```
========================================================================================================================
对话轮次 #3
Run ID: dc2ad269-857e-45dd-a7b5-3266d0e92dee
Session ID: a06773be-cb56-48b4-84f0-f775ac06559b
========================================================================================================================

[03:15:44.768] 👤 用户查询:
  [Wed 2026-02-11 11:15 GMT+8] 查询几个超一线城市的天气
  [message_id: dc2ad269-857e-45dd-a7b5-3266d0e92dee]

[03:15:44.768] ⚙️  系统 Prompt:
  模型: google/gemini-3-pro-preview
  思考级别: low
  推理级别: off
  长度: 26287 字符
  可用工具 (19 个): read, write, edit, exec, process, web_search, web_fetch, browser, canvas, nodes

[03:15:44.768] 💭 大模型思考（子任务）:
  **Defining Time Frame**

  I'm currently working on defining the time frame for the "last week" query...

[03:15:44.768] 🔧 工具调用 【Weather Skill】:
  名称: exec
  ID: exec17707789582401
  思考签名: Et8DCtwDAb4+9vsrKc+8JVsoENtz6fiC8T0W3nfERJ8...
  参数:
    command: curl -s "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m"

[03:15:45.123] 📦 工具结果 ✅ 成功:
  工具 ID: exec17707789582401
  结果:
    {
      "latitude": 39.9,
      "longitude": 116.4,
      "temperature_2m": 4.5
    }

[03:16:57.536] 🤖 大模型回复:
  长度: 341 字符
  停止原因: stop
  内容:
    这里是几个超一线城市的实时天气情况（数据来自 Open-Meteo）：

    | 城市 | 温度 | 天气状况 | 风速 |
    | :--- | :--- | :--- | :--- |
    | **北京** | 4.5°C | ☀️ 晴朗 (Clear sky) | 5.1 km/h |

[03:16:57.543] ⏹️  任务结束:
  Lane: main
  耗时: 72818 ms (72.82 秒)
```

## 实际应用场景

### 1. 调试工具调用

当某个工具调用失败时，使用分析器可以：

- 查看工具的完整参数
- 检查工具返回的错误信息
- 对比成功和失败的调用差异

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -A 20 "工具调用"
```

### 2. 分析性能瓶颈

查看每个轮次的耗时，找出慢查询：

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats
```

查看统计信息中的"任务耗时"部分。

### 3. 理解 LLM 思考过程

查看 LLM 在执行任务时的思考链路：

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -E "思考|thinking"
```

### 4. 审计工具使用

查看某个 Session 中使用了哪些工具：

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats
```

查看"工具使用频率"部分。

### 5. 导出数据用于机器学习

导出 JSON 格式的完整对话数据，用于训练或分析：

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --json training-data.json
```

## 高级用法

### 分析多个日志文件

```bash
# 合并多天的日志
cat logs/openclaw-2026-02-{10,11,12}.log > merged.log
python3 openclaw-log-analyzer.py merged.log --stats
```

### 筛选特定工具的调用

```bash
# 只查看 web_search 的调用
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -A 10 "web_search"
```

### 查找错误

```bash
# 查找所有工具执行错误
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -B 5 "❌ 错误"
```

## 常见问题

### Q1: 为什么有些工具调用没有参数？

A: 某些工具（如 `memory_search`）的参数可能在日志中被省略或截断。检查 OpenClaw 的日志级别设置（应为 `debug`）。

### Q2: 如何查看完整的系统 Prompt？

A: 系统 Prompt 会被截断显示（预览 200 字符）。如需完整内容，使用 `--json` 导出并查看 JSON 文件。

### Q3: 时间戳是本地时间还是 UTC？

A: 时间戳是 UTC 时间。如需转换为本地时间，可以修改脚本中的 `_format_timestamp` 方法。

### Q4: 如何只查看某个 Session 的日志？

A: 先导出为 JSON，然后使用 `jq` 或其他工具筛选：

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --json analysis.json
jq '.actions[] | select(.session_id == "你的SessionID")' analysis.json
```

## 技术细节

### 日志格式

OpenClaw 的日志是 JSON Lines 格式，每行一个 JSON 对象。分析器会：

1. 逐行解析 JSON
2. 提取关键字段（runId、sessionId、messages、toolCalls 等）
3. 按时间戳排序
4. 识别工具类型
5. 格式化输出

### 扩展分析器

如果需要添加新的工具类型识别，编辑 `_identify_tool_type` 方法：

```python
def _identify_tool_type(self, tool_name: str, args: Any) -> Optional[str]:
    if tool_name == "my_custom_tool":
        return "My Custom Type"
    # ... 其他规则
```

## 总结

`openclaw-log-analyzer.py` 是理解 OpenClaw 运行机制的强大工具。通过分析日志，你可以：

- 🐛 调试问题
- 📊 优化性能
- 🧠 理解 AI 思考过程
- 📈 统计使用模式
- 🔍 审计操作记录

**建议**: 每次遇到问题或需要优化时，先用分析器查看完整的执行流程！

---

**作者**: AI 助手  
**版本**: 3.0  
**更新日期**: 2026-02-11  
**OpenClaw 版本**: 2026.2.1+
