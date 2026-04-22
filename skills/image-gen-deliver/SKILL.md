---
name: image-gen-deliver
description: 多渠道文生图并发送的完整流程。当用户要求生成图片并发送到某个渠道时使用此技能。先用 image_generate 生成图片，然后根据渠道使用 image_sender.py 发送到对应平台。
metadata: {"openclaw":{"emoji":"🎨","channel-aware":true}}
---

# Image Gen & Deliver - 多渠道文生图技能

## 流程概述

```
用户请求 → image_generate → 解析路径 → image_sender.py → 渠道发送
```

## 步骤

### 1. 生成图片

使用 `image_generate` 工具：

```
image_generate(prompt="描述", size="2K", aspect="16:9")
```

工具返回结果中包含 `image_path`（图片保存路径，格式为 `/root/nanobanana_outputs/nanobanana_*.jpg`）。

### 2. 确定渠道和目标

根据当前会话的 `channel` 元数据判断：

| channel | 渠道 | 目标ID格式 |
|---------|------|-----------|
| telegram | Telegram | 用户数字ID |
| feishu | 飞书 | open_id (ou_xxx) |
| qqbot | QQ频道 | 子频道ID |
| openclaw-weixin | 企业微信/微信 | wxid |
| webchat | 网页chat | 自动处理，无需发送 |

### 3. 发送图片

使用 `image_sender.py` 脚本：

```bash
python3 /root/.openclaw/workspace/image_sender.py <图片路径> <渠道> <目标ID> [说明文字]
```

**示例 (Telegram)**:
```bash
python3 /root/.openclaw/workspace/image_sender.py /root/nanobanana_outputs/nanobanana_20260406_030939.jpg telegram 8561888441
```

**示例 (Feishu)**:
```bash
python3 /root/.openclaw/workspace/image_sender.py /root/nanobanana_outputs/nanobanana_20260406_030939.jpg feishu ou_6f13b06ec16cbcaea7d392aa501df980
```

### 4. 各渠道处理方式

#### Telegram ✅
- 使用 `openclaw message send --media` CLI 命令
- 图片需要先复制到 `~/.openclaw/media/outbound/`（脚本自动处理）
- 目标ID: 用户的数字 Telegram ID

#### Feishu ✅
- 调用 Feishu 官方 API 上传图片
- 需要有效的 tenant_access_token
- 目标ID: 用户的 open_id

#### QQ ⚠️
- 使用 `<qqimg>图片路径</qqimg>` 标签格式
- 通过 qqbot API 发送消息
- 注意: 需要确认目标子频道ID

#### WeChat ⚠️
- 通过 openclaw-weixin 插件发送
- 需要目标用户的 wxid
- 如果 `image_sender.py` 返回需要 agent 协助，手动调用:
  ```
  message(action=send, channel=openclaw-weixin, target=wxid, media=图片路径)
  ```

#### Webchat ✅
- `image_generate` 工具自动交付
- 无需额外操作

## 错误处理

如果 `image_sender.py` 对某个渠道失败：

1. 检查错误信息中的 `hint` 字段
2. 按提示手动使用对应渠道的工具
3. 如果是 Feishu token 问题，检查飞书应用配置
4. 如果是 Telegram 路径问题，确保图片在允许的目录

## 快速参考

```
# Telegram
python3 /root/.openclaw/workspace/image_sender.py <path> telegram <user_id> [caption]

# Feishu  
python3 /root/.openclaw/workspace/image_sender.py <path> feishu <open_id> [caption]

# QQ
python3 /root/.openclaw/workspace/image_sender.py <path> qq <channel_id> [caption]

# WeChat
python3 /root/.openclaw/workspace/image_sender.py <path> weixin <wxid> [caption]
```
