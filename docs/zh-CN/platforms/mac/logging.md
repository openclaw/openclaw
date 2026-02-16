---
read_when:
  - 捕获 macOS 日志或调查隐私数据日志记录
  - 调试语音唤醒/会话生命周期问题
summary: OpenClaw 日志：滚动诊断文件日志 + 统一日志隐私标志
title: macOS 日志
x-i18n:
  generated_at: "2026-02-01T21:32:54Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c4c201d154915e0eb08bf5e32bac98fa93766f50f2a24bf56ab4424eb7781526
  source_path: platforms/mac/logging.md
  workflow: 15
---

# 日志（macOS）

## 滚动诊断文件日志（Debug 面板）

OpenClaw 通过 swift-log（默认使用统一日志）路由 macOS 应用日志，并且在需要持久化捕获时可以将本地轮转文件日志写入磁盘。

- 详细级别：**Debug 面板 → Logs → App logging → Verbosity**
- 启用：**Debug 面板 → Logs → App logging → "Write rolling diagnostics log (JSONL)"**
- 位置：`~/Library/Logs/OpenClaw/diagnostics.jsonl`（自动轮转；旧文件以 `.1`、`.2`、… 为后缀）
- 清除：**Debug 面板 → Logs → App logging → "Clear"**

注意事项：

- 此功能**默认关闭**。仅在主动调试时启用。
- 该文件包含敏感信息；分享前请先审查内容。

## macOS 上统一日志的隐私数据

统一日志会屏蔽大部分负载内容，除非子系统选择启用 `privacy -off`。根据 Peter 关于 macOS [日志隐私机制](https://steipete.me/posts/2025/logging-privacy-shenanigans)（2025）的文章，这通过 `/Library/Preferences/Logging/Subsystems/` 中以子系统名称为键的 plist 文件来控制。只有新的日志条目才会应用该标志，因此请在复现问题之前启用它。

## 为 OpenClaw 启用（`bot.molt`）

- 先将 plist 写入临时文件，然后以 root 身份原子性地安装：

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- 无需重启；logd 会很快检测到该文件，但只有新的日志行才会包含隐私负载。
- 使用现有的辅助脚本查看更丰富的输出，例如 `./scripts/clawlog.sh --category WebChat --last 5m`。

## 调试后禁用

- 移除覆盖配置：`sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`。
- 可选择运行 `sudo log config --reload` 强制 logd 立即丢弃覆盖配置。
- 请注意此数据可能包含电话号码和消息正文；仅在确实需要额外详细信息时才保留该 plist 文件。
