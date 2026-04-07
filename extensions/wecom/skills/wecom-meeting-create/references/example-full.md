# 创建会议 - 全参数综合场景示例

## 场景 1: 高规格会议 (全参数)

**用户意图**: "帮我创建一个高规格的季度战略会议: 下周一上午9点, 时长4小时, 邀请全团队, 设置密码, 开启等候室, 开启屏幕水印, 全员静音"

```json
{
  "title": "Q2季度战略规划会",
  "meeting_start_datetime": "2026-03-23 09:00",
  "meeting_duration": 14400,
  "description": "Q2季度战略规划, 请各部门负责人提前准备汇报材料",
  "location": "总部大会议室",
  "invitees": {
    "userid": ["zhangsan", "lisi", "wangwu", "zhaoliu", "sunqi"]
  },
  "settings": {
    "password": "2026",
    "enable_waiting_room": true,
    "allow_enter_before_host": false,
    "enable_enter_mute": 1,
    "allow_external_user": false,
    "enable_screen_watermark": true,
    "remind_scope": 3,
    "ring_users": {
      "userid": ["zhangsan", "lisi", "wangwu", "zhaoliu", "sunqi"]
    }
  }
}
```
