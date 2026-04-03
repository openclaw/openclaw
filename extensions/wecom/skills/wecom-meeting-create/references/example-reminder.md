# 创建会议 - 响铃提醒场景示例

## 场景 2: 仅提醒主持人 + 提前提醒时间

**用户意图**: "帮我创建一个会议, 只提醒主持人, 并在会议开始前15分钟和1小时各提醒一次"

```json
{
  "title": "项目启动会",
  "meeting_start_datetime": "2026-03-21 10:00",
  "meeting_duration": 3600,
  "invitees": {
    "userid": ["zhangsan", "lisi"]
  },
  "settings": {
    "remind_scope": 2,
    "ring_users": {
      "userid": ["zhangsan"]
    }
  }
}
```

---

## 场景 3: 指定部分人响铃 (remind_scope=4)

**用户意图**: "帮我创建一个会议, 只响铃提醒张三和李四, 其他人不提醒"

```json
{
  "title": "紧急故障复盘",
  "meeting_start_datetime": "2026-03-18 20:00",
  "meeting_duration": 3600,
  "invitees": {
    "userid": ["zhangsan", "lisi", "wangwu", "zhaoliu"]
  },
  "settings": {
    "remind_scope": 4,
    "ring_users": {
      "userid": ["zhangsan", "lisi"]
    },
    "allow_enter_before_host": true
  }
}
```
