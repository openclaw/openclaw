---
summary: "OpenClaw logging: rolling diagnostics file log + unified log privacy flags"
read_when:
  - Capturing macOS logs or investigating private data logging
  - Debugging voice wake/session lifecycle issues
title: macOS Logging
---

# 日誌記錄（macOS）

## 迴轉診斷檔案日誌（除錯面板）

OpenClaw 透過 swift-log（預設為統一日誌）來路由 macOS 應用程式日誌，並且在需要持久保存時，可以寫入本地的迴轉檔案日誌到磁碟。

- 詳細程度：**除錯面板 → 日誌 → 應用程式日誌 → 詳細程度**
- 啟用：**除錯面板 → 日誌 → 應用程式日誌 → “寫入迴轉診斷日誌（JSONL）”**
- 位置：`~/Library/Logs/OpenClaw/diagnostics.jsonl`（會自動迴轉；舊檔案會加上 `.1`、`.2` 等後綴）
- 清除：**除錯面板 → 日誌 → 應用程式日誌 → “清除”**

注意事項：

- 預設為**關閉**。僅在積極除錯時啟用。
- 將該檔案視為敏感資料；未經審查請勿分享。

## macOS 上的統一日誌私人資料

統一日誌會遮蔽大部分內容，除非子系統選擇加入 `privacy -off`。根據 Peter 在 macOS [日誌隱私問題](https://steipete.me/posts/2025/logging-privacy-shenanigans)（2025年）的說明，這是由 `/Library/Preferences/Logging/Subsystems/` 中以子系統名稱為鍵的 plist 控制。只有新的日誌條目會套用此標記，因此請在重現問題前啟用。

## 為 OpenClaw 啟用 (`ai.openclaw`)

- 先將 plist 寫入暫存檔案，再以 root 權限原子性安裝：

```bash
cat <<'EOF' >/tmp/ai.openclaw.plist
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
sudo install -m 644 -o root -g wheel /tmp/ai.openclaw.plist /Library/Preferences/Logging/Subsystems/ai.openclaw.plist
```

- 不需重新啟動；logd 會快速偵測該檔案，但只有新的日誌行會包含私人內容。
- 可使用現有的輔助工具查看更豐富的輸出，例如 `./scripts/clawlog.sh --category WebChat --last 5m`。

## 除錯後停用

- 移除覆寫設定：`sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`。
- 可選擇執行 `sudo log config --reload` 以強制 logd 立即放棄覆寫。
- 請記得此介面可能包含電話號碼和訊息內容；僅在積極需要額外細節時保留該 plist。
