# n8n Workflows 備份

這個資料夾保存原始的 n8n workflows，作為參考和備份。

## Workflows 清單

### 1. LINE自動發消息.json

**狀態**: ✅ 已遷移到 Vercel Serverless Function

**原始功能**:
- 接收 LINE Bot webhook
- 判斷用戶訊息是否包含觸發關鍵字（/news、新聞等）
- 從 GitHub 拉取 latest.json
- 回覆新聞內容到 LINE

**新位置**: `api/line-webhook.py`

**遷移日期**: 2025-11-08

---

### 2. 每日新聞挑戰思維邊界.json

**狀態**: ✅ 已遷移到 Python + GitHub Actions

**原始功能**:
- 每日定時觸發
- 拉取 RSS 新聞
- AI 四階段處理（摘要、分類、深度分析、HTML 生成）
- 上傳到 GitHub

**新位置**:
- `scripts/main.py` - 主要邏輯
- `.github/workflows/daily_news.yml` - 排程設定

**遷移日期**: 2025-11-07

---

## 為什麼保留這些檔案？

1. **備份** - 保留原始配置，以防需要回滾
2. **參考** - 未來可能需要參考原始邏輯
3. **文檔** - 記錄系統演進歷史
4. **學習** - 可以比較 n8n 和 Python 實作的差異

## 遷移理由

| 原因 | 說明 |
|-----|------|
| 成本 | n8n 自架成本高，GitHub Actions + Vercel 有免費額度 |
| 維護性 | Python 程式碼更容易版本控制和協作 |
| 可擴展性 | Python 生態系更豐富，更容易整合其他工具 |
| 穩定性 | GitHub Actions 和 Vercel 都是成熟的 SaaS 平台 |

## 完全離開 n8n 的清單

- [x] 新聞生成流程 → Python + GitHub Actions
- [x] LINE Bot webhook → Vercel Serverless Function
- [ ] （如果還有其他 workflows，請在這裡列出）

---

如果未來需要重新導入到 n8n，可以直接使用這些 JSON 檔案。
