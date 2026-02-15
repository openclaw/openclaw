---
summary: "OpenClaw 日誌：滾動式診斷檔案日誌 + 統一日誌隱私標記"
read_when:
  - 擷取 macOS 日誌或調查隱私資料記錄時
  - 偵錯語音喚醒/工作階段生命週期問題時
title: "macOS 日誌記錄"
---

# 日誌記錄 (macOS)

## 滾動式診斷檔案日誌 (Debug 面板)

OpenClaw 透過 swift-log（預設為統一日誌記錄）傳輸 macOS 應用程式日誌，並可在您需要持久擷取時，將本機滾動式檔案日誌寫入磁碟。

- 詳細程度：**Debug 面板 → Logs → App logging → Verbosity**
- 啟用：**Debug 面板 → Logs → App logging → 「Write rolling diagnostics log (JSONL)」**
- 位置：`~/Library/Logs/OpenClaw/diagnostics.jsonl`（自動滾動；舊檔案會加上 `.1`、`.2` … 等字尾）
- 清除：**Debug 面板 → Logs → App logging → 「Clear」**

注意事項：

- 此功能**預設為關閉**。僅在主動偵錯時啟用。
- 請將此檔案視為敏感資訊；未經檢查請勿分享。

## macOS 上的統一日誌隱私資料

除非子系統選擇加入 `privacy -off`，否則統一日誌記錄會遮蔽大多數的承載資料 (payload)。根據 Peter 關於 macOS [日誌隱私機制](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) 的文章，這由 `/Library/Preferences/Logging/Subsystems/` 中以子系統名稱命名的 plist 控制。只有新的日誌分錄會套用此標記，因此請在重現問題前啟用它。

## 為 OpenClaw (`bot.molt`) 啟用

- 先將 plist 寫入暫存檔，然後以 root 身分進行原子化安裝：

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

- 不需要重啟；logd 會迅速偵測到該檔案，但只有新的日誌行會包含隱私承載資料。
- 使用現有的輔助工具查看更豐富的輸出，例如：`./scripts/clawlog.sh --category WebChat --last 5m`。

## 偵錯後停用

- 移除覆寫設定：`sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`。
- 可選擇執行 `sudo log config --reload` 來強制 logd 立即捨棄覆寫設定。
- 請記住，這些資料可能包含電話號碼和訊息內容；僅在主動需要額外詳細資訊時才保留此 plist。
