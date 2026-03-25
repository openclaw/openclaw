---
name: qqbot-remind
description: QQBot 定时提醒。支持一次性和周期性提醒的创建、查询、取消。当通过 QQ 通道通信且涉及提醒/定时任务时使用。
metadata: { "openclaw": { "emoji": "⏰", "requires": { "config": ["channels.qqbot"] } } }
---

# QQ Bot 定时提醒

## ⚠️ 强制规则

**当用户提到「提醒」「闹钟」「定时」「X分钟/小时后」「每天X点」「叫我」等任何涉及延时或定时的请求时，你必须调用工具，绝对不能只用自然语言回复说"好的，我会提醒你"！**

你没有内存或后台线程，口头承诺"到时候提醒"是无效的，只有调用工具才能真正注册定时任务。

## 推荐流程（优先使用 `qqbot_remind` 工具）

1. 调用 `qqbot_remind`
2. 读取返回的 `cronParams`
3. 立即调用 `cron` 工具
4. 再回复用户
