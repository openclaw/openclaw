# DING 消息 (ding) 命令参考

## 命令总览

### 发送 DING 消息
```
Usage:
  dws ding message send [flags]
Example:
  dws ding message send --robot-code <ROBOT_CODE> --users <USER_ID_1>,<USER_ID_2> --content "请查看"
Flags:
      --content string      消息内容 (必填)
      --robot-code string   机器人 ID (必填, 可从 应用管理→机器人 获取, 或设 DINGTALK_DING_ROBOT_CODE)
      --users string         接收人 userId 列表 (必填)
      --type string         提醒类型: app/sms/call (默认 app)
```

### 撤回 DING 消息
```
Usage:
  dws ding message recall [flags]
Example:
  dws ding message recall --robot-code <ROBOT_CODE> --id <OPEN_DING_ID>
Flags:
      --id string           DING 消息 ID (必填)
      --robot-code string   机器人 ID (必填, 或设 DINGTALK_DING_ROBOT_CODE)
```

## 意图判断

用户说"DING 一下/紧急通知/电话提醒" → `message send`
用户说"撤回 DING" → `message recall`

关键区分:
- ding(紧急提醒, 支持电话/短信) vs bot(常规群/单聊消息)
- sms/call 类型有通信费用

## 核心工作流

```bash
# 应用内 DING (免费)
dws ding message send --robot-code <ROBOT_CODE> --type app --users userId1,userId2 --content "请查看" --format json

# 电话 DING (紧急, 有成本!)
dws ding message send --robot-code <ROBOT_CODE> --type call --users userId1 --content "紧急告警" --format json

# 撤回
dws ding message recall --robot-code <ROBOT_CODE> --id <OPEN_DING_ID> --format json
```
## 上下文传递表
| 操作 | 提取 | 用于 |
|------|------|------|
| `message send` | `openDingId` | message recall 的 --id |
## 注意事项
- `--robot-code` 从钉钉开放平台 **应用管理 → 机器人** 中获取，也可设环境变量 `DINGTALK_DING_ROBOT_CODE`
- sms/call 类型有通信费用，使用前需和用户确认
- 默认 `--type app`（应用内 DING，免费）
