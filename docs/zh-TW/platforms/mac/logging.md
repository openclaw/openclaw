---
summary: "OpenClaw 紀錄：滾動式診斷檔案紀錄 + 統一紀錄隱私旗標"
read_when:
  - 擷取 macOS 紀錄或調查私有資料紀錄
  - 偵錯語音喚醒/工作階段生命週期問題
title: "macOS 紀錄"
---

# 紀錄 (macOS)

## 滾動式診斷檔案紀錄 (除錯面板)

OpenClaw 透過 swift-log (預設為統一紀錄) 路由 macOS 應用程式紀錄，並可在需要持久擷取時，將本地的滾動式檔案紀錄寫入磁碟。

- 詳細程度：**除錯面板 → 紀錄 → 應用程式紀錄 → 詳細程度**
- 啟用：**除錯面板 → 紀錄 → 應用程式紀錄 → “寫入滾動式診斷紀錄 (JSONL)”**
- 位置：`~/Library/Logs/OpenClaw/diagnostics.jsonl` (自動輪替；舊檔案會加上 `.1`, `.2`, … 等後綴)
- 清除：**除錯面板 → 紀錄 → 應用程式紀錄 → “清除”**

備註：

- 此功能**預設為關閉**。僅在積極偵錯時啟用。
- 請將此檔案視為敏感檔案；未經審查請勿分享。

## macOS 上的統一紀錄私有資料

統一紀錄會遮蓋大多數酬載，除非子系統選擇加入 `privacy -off`。根據 Peter 關於 macOS [紀錄隱私惡作劇](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) 的文章，這由 `/Library/Preferences/Logging/Subsystems/` 中以子系統名稱為鍵的 plist 控制。只有新的紀錄項目會擷取該旗標，因此請在重現問題之前啟用它。

## 為 OpenClaw 啟用 (`bot.molt`)

- 先將 plist 寫入暫存檔案，然後以 root 身分原子化安裝：

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

- 無需重新啟動；logd 會迅速注意到該檔案，但只有新的紀錄行會包含私有酬載。
- 使用現有的輔助程式查看更豐富的輸出，例如 `./scripts/clawlog.sh --category WebChat --last 5m`。

## 偵錯後停用

- 移除覆蓋：`sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`。
- 您可以選擇執行 `sudo log config --reload` 以強制 logd 立即捨棄覆蓋。
- 請記住，此介面可能包含電話號碼和訊息內容；僅在您積極需要額外細節時才保留 plist。
