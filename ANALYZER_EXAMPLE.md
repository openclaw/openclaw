# OpenClaw 日志分析器 - 使用示例

## 快速开始

```bash
# 分析今天的日志
python3 openclaw-log-analyzer.py logs/openclaw-$(date +%Y-%m-%d).log

# 显示统计信息
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats

# 导出 JSON
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --json analysis.json
```

## 实际输出示例

### 1. 完整对话流程

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

  I'm currently working on defining the time frame for the "last week" query.
  Based on today's date, February 11th, 2026, I've narrowed it down to
  roughly February 2nd to February 8th.

[03:15:44.768] 🔧 工具调用 【Shell Command】:
  名称: exec
  ID: exec17707789582401
  思考签名: Et8DCtwDAb4+9vsrKc+8JVsoENtz6fiC8T0W3nfERJ8...
  参数:
    command: ls -1 memory/2026-02-0*.md memory/2026-02-1*.md 2>/dev/null

[03:15:45.234] 📦 工具结果 ❌ 错误:
  工具 ID: exec17707789582401
  结果:
    {
      "status": "error",
      "tool": "exec",
      "error": "zsh:1: no matches found: memory/2026-02-1*.md"
    }

[03:15:44.768] 🔧 工具调用 【Weather Skill】:
  名称: exec
  ID: exec17707789703463
  参数:
    command: curl -s "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m,weather_code,wind_speed_10m"
    description: query weather for beijing

[03:15:46.123] 📦 工具结果 ✅ 成功:
  工具 ID: exec17707789703463
  结果:
    {
      "latitude": 39.875,
      "longitude": 116.375,
      "current": {
        "temperature_2m": 4.5,
        "weather_code": 0,
        "wind_speed_10m": 5.1
      }
    }

[03:16:57.536] 🤖 大模型回复:
  长度: 341 字符
  停止原因: stop
  内容:
    这里是几个超一线城市的实时天气情况（数据来自 Open-Meteo）：

    | 城市 | 温度 | 天气状况 | 风速 |
    | :--- | :--- | :--- | :--- |
    | **北京** | 4.5°C | ☀️ 晴朗 (Clear sky) | 5.1 km/h |
    | **上海** | 10.0°C | 🌤️ 多云 (Mainly clear) | 8.7 km/h |
    | **广州** | 17.3°C | ☁️ 阴 (Overcast) | 7.2 km/h |
    | **深圳** | 20.3°C | ⛅ 部分多云 (Partly cloudy) | 8.7 km/h |

[03:16:57.537] 🧠 大模型思考（总结）:
  **Verifying Current Data**

  I have successfully retrieved and validated the current weather data
  for Beijing and Shanghai, including their coordinates, temperatures,
  wind speeds, and weather codes.

[03:16:57.543] ⏹️  任务结束:
  Lane: main
  耗时: 72818 ms (72.82 秒)
```

### 2. 统计信息示例

```
========================================================================================================================
📊 统计信息
========================================================================================================================

操作类型分布:
  工具调用                              90 次
  工具结果                              90 次
  思考子任务                             77 次
  任务结束                              16 次
  用户查询                               8 次
  模型回复                               8 次
  系统Prompt                           6 次
  思考总结                               4 次

工具使用频率:
  exec                 Shell Command           41 次
  web_search           Web Search API          30 次
  read                 File Tool               17 次
  web_fetch            Web Fetch API            2 次

会话统计:
  总会话数: 1
  总运行数: 8

任务耗时:
  平均: 35959 ms (35.96 秒)
  最大: 72821 ms (72.82 秒)
  最小: 5891 ms (5.89 秒)
```

## 关键特性

### ✅ 完整时间线

所有操作按照实际发生时间严格排序，包括：

- 用户查询的精确时刻
- LLM 开始思考的时间
- 每个工具调用的发起时间
- 工具返回结果的时间
- 最终回复的时间

### ✅ 工具调用详情

对于每个工具调用，显示：

- **工具名称和类型**（自动识别 Skill/Tool/API/CLI）
- **完整参数**（明文显示，支持 JSON 格式化）
- **思考签名**（thoughtSignature，显示 LLM 调用工具前的思考）
- **执行结果**（成功/失败状态，完整输出）

### ✅ LLM 思考过程

提取两类思考：

- **思考总结**（fullThinking）- LLM 对整个过程的总结性思考
- **思考子任务**（inline thinking）- LLM 在执行过程中的实时思考

### ✅ 工具类型识别

自动识别常见工具类型：

- 🛠️ **Skills**: Weather, GitHub, Apple Notes, Apple Reminders, Things
- 🌐 **Web APIs**: web_search, web_fetch
- 📁 **File Tools**: read, write, edit
- 💾 **Memory Tools**: memory_search, memory_get
- 🌐 **Browser Tools**: browser
- 👥 **Subagent**: sessions_spawn
- 🔧 **Shell Commands**: exec (通用命令)
- 🔌 **API Calls**: curl, wget

## 实用技巧

### 1. 查找特定工具的所有调用

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -A 15 "web_search"
```

### 2. 只查看错误

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -B 5 "❌ 错误"
```

### 3. 提取所有思考过程

```bash
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -E "(思考|Thinking)" -A 5
```

### 4. 分析性能

```bash
# 查看所有任务耗时
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep "任务结束"

# 查看统计信息
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats
```

### 5. 导出结构化数据

```bash
# 导出 JSON 用于进一步处理
python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --json data.json

# 使用 jq 查询特定信息
jq '.actions[] | select(.type == "tool_call") | .data.tool_name' data.json | sort | uniq -c
```

## 实际应用场景

### 场景 1: 调试天气查询失败

**问题**: 用户反馈天气查询不准确

**步骤**:

1. 运行分析器查看天气相关的工具调用
   ```bash
   python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log | grep -B 5 -A 20 "Weather"
   ```
2. 检查传递给 API 的参数（经纬度、城市名等）
3. 查看 API 返回的原始数据
4. 对比 LLM 的最终回复，找出数据转换中的问题

### 场景 2: 优化响应速度

**问题**: 某些查询响应很慢

**步骤**:

1. 查看统计信息，找出平均和最大耗时
   ```bash
   python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --stats
   ```
2. 找出耗时最长的对话轮次
3. 分析该轮次的工具调用情况
4. 识别瓶颈（网络请求、文件读取、LLM 推理等）

### 场景 3: 理解 LLM 决策过程

**问题**: 想了解 LLM 为什么选择某个工具

**步骤**:

1. 查看系统 Prompt 中的可用工具列表
2. 阅读 LLM 的思考过程（子任务）
3. 查看 thoughtSignature 了解调用工具前的思考
4. 对比不同场景下的决策模式

### 场景 4: 审计和合规

**问题**: 需要记录 AI 助手的所有操作

**步骤**:

1. 导出完整的 JSON 数据
   ```bash
   python3 openclaw-log-analyzer.py logs/openclaw-2026-02-11.log --json audit-2026-02-11.json
   ```
2. 保存 JSON 文件作为审计记录
3. 使用脚本定期分析和归档
4. 生成合规报告

## 总结

OpenClaw 日志分析器提供了：

- 📊 **完整视图** - 从用户查询到最终回复的完整流程
- 🔍 **深度洞察** - LLM 的思考过程和工具调用细节
- 📈 **性能分析** - 识别瓶颈和优化机会
- 🐛 **调试支持** - 快速定位问题根源
- 📝 **审计记录** - 结构化的操作日志

使用这个工具可以显著提升 OpenClaw 的开发、调试和优化效率！

---

**提示**: 如果你有自定义的工具或 Skill，可以修改分析器的 `_identify_tool_type` 方法来识别它们。

**文档**: 详细指南请参考 `LOG_ANALYZER_GUIDE.md`
