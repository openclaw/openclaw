# 创建会议 - 安全设置场景示例

## 场景 4: 会议密码 + 等候室 + 主持人设置

**用户意图**: "帮我创建一个重要的客户汇报会议, 需要设置密码1234, 开启等候室, 不允许外部人员入会"

```json
{
  "title": "客户汇报会议",
  "meeting_start_datetime": "2026-03-19 14:00",
  "meeting_duration": 5400,
  "invitees": {
    "userid": ["zhangsan", "lisi", "wangwu"]
  },
  "settings": {
    "password": "1234",
    "enable_waiting_room": true,
    "allow_enter_before_host": false,
    "allow_external_user": false
  }
}
```
