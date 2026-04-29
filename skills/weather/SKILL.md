---
name: weather
description: "Get current weather, rain, temperature, and forecasts for locations or travel planning."
homepage: https://wttr.in/:help
metadata:
  {
    "openclaw":
      {
        "emoji": "☔",
        "requires": { "bins": ["curl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# Weather Skill

获取当前天气状况和预报。

## 何时使用

✅ **使用此 skill 当：**

- "天气怎么样？"
- "今天/明天会下雨吗？"
- "[城市] 的温度"
- "本周天气预报"
- 旅行规划天气检查

## 何时不使用

❌ **不要使用此 skill 当：**

- 历史天气数据 → 使用天气档案/API
- 气候分析或趋势 → 使用专业数据源
- 超本地微气候数据 → 使用本地传感器
- 严重天气警报 → 检查官方 NWS 来源
- 航空/海洋天气 → 使用专业服务（METAR 等）

## 位置

始终在天气查询中包含城市、地区或机场代码。

## 命令

### 当前天气

```bash
# 一行摘要
curl "wttr.in/London?format=3"

# 详细当前状况
curl "wttr.in/London?0"

# 特定城市
curl "wttr.in/New+York?format=3"
```

### 预报

```bash
# 3 天预报
curl "wttr.in/London"

# 周预报
curl "wttr.in/London?format=v2"

# 特定日期（0=今天，1=明天，2=后天）
curl "wttr.in/London?1"
```

### 格式选项

```bash
# 一行
curl "wttr.in/London?format=%l:+%c+%t+%w"

# JSON 输出
curl "wttr.in/London?format=j1"

# PNG 图像
curl "wttr.in/London.png"
```

### 格式代码

- `%c` — 天气状况 emoji
- `%t` — 温度
- `%f` — "体感温度"
- `%w` — 风
- `%h` — 湿度
- `%p` — 降水量
- `%l` — 位置

## 快速响应

**"天气怎么样？"**

```bash
curl -s "wttr.in/London?format=%l:+%c+%t+(feels+like+%f),+%w+wind,+%h+humidity"
```

**"会下雨吗？"**

```bash
curl -s "wttr.in/London?format=%l:+%c+%p"
```

**"周末预报"**

```bash
curl "wttr.in/London?format=v2"
```

## 提示

- 不需要 API 密钥（使用 wttr.in）
- 有速率限制；不要频繁请求
- 适用于大多数全球城市
- 支持机场代码：`curl wttr.in/ORD`
