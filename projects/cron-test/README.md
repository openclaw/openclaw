# 🤖 ThinkerCafe Cron Test Project

## 📋 專案說明

這是 ThinkerCafe monorepo 中的一個測試專案，用於驗證 Vercel Cron Job 功能與 MCP 工具整合。

## 🎯 測試目標

- ✅ Vercel Cron Job 基本功能
- ✅ 自動排程執行
- ✅ MCP Vercel 工具部署
- ✅ 日誌監控與狀態檢查

## 🚀 快速開始

### 本地開發
```bash
cd projects/cron-test
vercel dev
```

### 部署到 Vercel
```bash
vercel --prod
```

## 📊 Cron Job 設定

- **排程**：每 5 分鐘執行一次
- **端點**：`/api/cron/test`
- **功能**：記錄時間戳記與執行狀態

## 🧪 測試方式

1. 訪問部署後的網址
2. 點擊「測試 Cron Job API」按鈕
3. 查看執行結果與日誌

## 📚 相關文件

- [專案配置 (CLAUDE.md)](./CLAUDE.md)
- [Vercel 配置 (vercel.json)](./vercel.json)
- [API 端點 (api/cron/test.js)](./api/cron/test.js)

---

**ThinkerCafe** | 建立時間：2025-11-09