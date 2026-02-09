---
summary: "OpenClaw 記錄：可輪替的診斷檔案記錄 + 統一記錄的隱私旗標"
read_when:
  - 擷取 macOS 記錄或調查私密資料記錄
  - 偵錯語音喚醒／工作階段生命週期問題
title: "macOS 記錄"
---

# 記錄（macOS）

## 可輪替的診斷檔案記錄（Debug pane）

OpenClaw 會透過 swift-log 將 macOS 應用程式記錄導向（預設為統一記錄），並在需要長時間保留的擷取時，將可輪替的本機檔案記錄寫入磁碟。

- 詳細程度：**Debug pane → Logs → App logging → Verbosity**
- 啟用：**Debug pane → Logs → App logging → 「Write rolling diagnostics log (JSONL)」**
- 位置：`~/Library/Logs/OpenClaw/diagnostics.jsonl`（會自動輪替；舊檔會以 `.1`、`.2`、… 作為後綴）
- 清除：**Debug pane → Logs → App logging → 「Clear」**

注意事項：

- 此功能**預設為關閉**。 僅在主動除錯時啟用。
- 將此檔案視為敏感資料；未經審查請勿分享。

## macOS 上統一記錄的私密資料

Unified logging redacts most payloads unless a subsystem opts into `privacy -off`. 除非某個子系統選擇加入 `privacy -off`，否則統一記錄會遮蔽大多數負載。依 Peter 在 macOS 的〈[logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans)〉（2025）一文所述，這由位於 `/Library/Preferences/Logging/Subsystems/` 的 plist 控制，並以子系統名稱作為索引鍵。只有新的記錄項目會套用該旗標，因此請在重現問題之前先啟用。 只有新的日誌項目會套用此旗標，因此請在重現問題前啟用。

## 為 OpenClaw 啟用（`bot.molt`）

- 先將 plist 寫入暫存檔，然後以 root 權限以原子方式安裝：

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

- 不需要重新開機；logd 會很快注意到該檔案，但只有新的記錄行才會包含私密負載。
- 使用既有的輔助工具檢視更豐富的輸出，例如：`./scripts/clawlog.sh --category WebChat --last 5m`。

## 偵錯後停用

- 移除覆寫設定：`sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`。
- 視需要執行 `sudo log config --reload`，以強制 logd 立即移除覆寫。
- 請記住此介面可能包含電話號碼與訊息內容；僅在你實際需要額外細節時才保留 plist。
