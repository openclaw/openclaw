# 認知鐵律 (Iron Rules) — Claude Code 行為準則

> 本文件定義 Claude Code 在操作時必須遵守的認知鐵律。
> 這些規則確保我「越用越聰明，不再重蹈覆轍」。

---

## 鐵律一：踩坑必記 (Save on Failure)

**觸發條件：**

- 任何指令執行失敗 (exit code ≠ 0)
- 工具調用報錯或返回異常
- 解決了一個花費 >5 分鐘的 Bug
- 發現環境配置差異導致的問題
- 部署失敗或回滾

**必須動作：**

```bash
~/Clawd/workspace/experience-memory/save_experience \
  -p "現象描述" \
  -c "根因分析" \
  -s "解決方案" \
  -m "方法論/架構原則" \
  -t "tag1,tag2" \
  --severity critical|warning|info
```

**記錄格式要求：**

- `phenomenon`: 精確描述錯誤現象，包含錯誤訊息原文
- `cause`: 分析根因，不只是表象
- `solution`: 具體可執行的解決步驟
- `methodology`: 抽象出通用方法論，防止同類問題
- `severity`: critical=影響線上服務, warning=影響開發效率, info=知識補充

---

## 鐵律二：行動前檢索 (Search Before Action)

**觸發條件：**

- 開始一項新任務
- 配置新環境或新服務
- 遇到報錯準備重試
- 修改架構或部署流程
- 處理不熟悉的技術棧

**必須動作：**

```bash
~/Clawd/workspace/experience-memory/search_experience "相關關鍵詞"
```

**執行規範：**

1. 在動手之前，先用關鍵詞搜索記憶庫
2. 如果有相關經驗（score > 0.35），必須先閱讀
3. 根據歷史教訓調整行動策略
4. 如果歷史經驗與當前方案矛盾，優先遵循歷史教訓
5. 搜索失敗不阻斷工作流程，但必須嘗試

---

## 鐵律三：交叉驗證 (Cross-Validate)

**觸發條件：**

- 撰寫或修改程式碼後
- 修改配置文件後
- 部署之前

**必須動作：**

1. 搜索記憶庫中的「安全」和「架構」相關經驗
2. 對照檢查清單：
   - [ ] 是否引入了 OWASP Top 10 漏洞？
   - [ ] 是否違反了已知的路徑映射規則？
   - [ ] 是否可能造成 Token 衝突或 Rate Limit？
   - [ ] 是否遺漏了環境變數或密鑰？
   - [ ] 是否有重複的服務實例可能衝突？
3. 如果發現風險，先修復再繼續

---

## 快速參考

### 經驗記憶工具

| 操作     | 命令                                                      |
| -------- | --------------------------------------------------------- |
| 保存經驗 | `save_experience -p "現象" -c "原因" -s "解法" -t "tags"` |
| 搜索經驗 | `search_experience "查詢" --limit 5`                      |
| 查看統計 | `search_experience --stats`                               |
| 列出全部 | `search_experience --list -n 20`                          |
| 批量導入 | `echo '[{...}]' \| save_experience --json`                |

### 路徑

```
~/Clawd/workspace/experience-memory/
├── db.py                  # 核心引擎 (LanceDB + SentenceTransformers)
├── save_experience        # 保存經驗 CLI
├── search_experience      # 搜索經驗 CLI
├── import_tg_sessions.py  # TG 歷史導入
└── data/                  # LanceDB 向量資料庫
```

### 嚴重等級指南

| 等級       | 適用場景               | 範例                         |
| ---------- | ---------------------- | ---------------------------- |
| `critical` | 影響線上服務、數據安全 | 409 衝突、密鑰洩漏、部署失敗 |
| `warning`  | 影響開發效率、潛在風險 | 超時、重試策略不當、配置錯誤 |
| `info`     | 知識補充、最佳實踐     | 架構決策、設計模式、工具用法 |
