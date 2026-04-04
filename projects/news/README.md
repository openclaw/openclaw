# @thinker-cafe/news

AI 驅動的每日新聞摘要系統，自動抓取、摘要、分析台灣新聞並生成精美報告。

## 功能

- 每日自動抓取台灣新聞（7 個新聞源）
- AI 摘要與主題分類（Gemini + OpenAI GPT-4）
- 台灣本地化篩選與評分
- 多格式輸出（HTML、JSON、LINE 訊息）
- LINE Bot 整合
- Notion 自動同步

## 技術棧

- **語言**: Python 3.11+
- **AI**: OpenAI GPT-4, Google Gemini
- **部署**: GitHub Actions (定時任務)
- **API**: Vercel Serverless Functions
- **通知**: LINE Messaging API, Slack Webhook

## 快速開始

### 本地開發

```bash
# 1. 安裝依賴
pip install -r requirements.txt

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env 填入 API keys

# 3. 執行主程式
python scripts/main.py
```

### 部署

系統已配置 GitHub Actions，每天 UTC 22:00 (台灣時間 06:00) 自動執行。

需要在 GitHub Settings → Secrets 設定以下環境變數：
- `GOOGLE_API_KEY` - Gemini API Key
- `OPENAI_API_KEY` - OpenAI API Key
- `LINE_CHANNEL_ACCESS_TOKEN` - LINE Bot Token
- `LINE_CHANNEL_SECRET` - LINE Bot Secret
- `SLACK_WEBHOOK_URL` - Slack 通知 (可選)

## 專案結構

```
projects/news/
├── scripts/           # Python 腳本
│   ├── main.py       # 主程式
│   ├── rss_fetcher.py
│   ├── news_filter.py
│   ├── ai_processor.py
│   ├── html_generator.py
│   └── utils.py
├── api/              # Vercel Serverless Functions
│   └── line-webhook.py
├── docs/             # 文件
├── .github/workflows/
│   └── daily_news.yml
├── CLAUDE.md         # AI 記憶檔案
├── package.json
└── requirements.txt
```

## 更多資訊

詳見 `CLAUDE.md` 了解完整架構與使用指南。

## 維護者

- Cruz Tang (@tangcruz)
- Claude Code (AI Assistant)

## License

Private - ThinkerCafe 內部專案
