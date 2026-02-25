# Security Audit Report: openclaw

**日期:** 2026-02-24
**稽核方式:** Claude Code Multi-Agent Security Audit

## 摘要

- Critical: 0 | High: 0 | Medium: 2 | Low: 0 | Info: 1
- 整體風險等級: Medium

## 專案概述

- 技術棧簡述
  - TypeScript / ESM 專案，使用 pnpm 管理依賴
  - Multi-channel AI gateway，支援多種通訊頻道（Discord、Telegram、Slack 等）
  - 插件系統支援工具、HTTP 路由、頻道、Provider 等擴充
  - Gateway server 提供 HTTP/WebSocket 介面，搭配認證中介層
- 攻擊面分析
  - Gateway HTTP/WebSocket 端點（認證、rate limiting、origin 檢查）
  - Plugin HTTP routes（由插件註冊，繞過閘道認證中介層）
  - 瀏覽器控制端點（CDP 遠端連線）
  - 工具執行系統（sandbox、safe bins、elevated exec）
  - 設定檔與狀態目錄的檔案系統權限
  - 環境變數載入（shell profile）

## 發現

### [Medium] O1: Gateway 密碼模式無強度檢查

**狀態:** 已修復
**檔案:** `src/security/audit.ts`
**說明:** token 模式有 `gateway.token_too_short` 檢查，但 password 模式沒有對應的強度檢查。
**影響:** 使用者可能設定過短的密碼，降低閘道安全性。
**修復方式:** 新增 `gateway.password_too_short` audit finding，密碼長度 < 16 時發出警告。
**驗證方法:** 執行 `pnpm test` 確認測試通過。

### [Medium] O2: Plugin HTTP Routes 無認證檢查

**狀態:** 已修復（新增 audit warning）
**檔案:** `src/security/audit.ts`
**說明:** 插件可以透過 registry 註冊 HTTP routes，這些路由不經過閘道認證中介層。
**影響:** 惡意或設計不當的插件可能暴露未受保護的端點。
**修復方式:** 新增 `plugin.http_routes_no_auth` audit info finding，提醒管理者檢視插件路由。
**驗證方法:** 執行 `pnpm test` 確認測試通過。

### [Info] O3: Shell 環境變數載入

**狀態:** 已接受風險
**說明:** `OPENCLAW_LOAD_SHELL_ENV` 選項可從 shell profile 載入環境變數，這是設計意圖。
**影響:** 若 shell profile 被竄改，可能注入惡意環境變數。
**建議:** 在文件中明確說明此選項的安全影響。

## 正面安全觀察

1. **timing-safe secret comparison** -- 使用 node:crypto 的 timingSafeEqual
2. **Rate limiting** -- IP 追蹤、滑動窗口、鎖定機制
3. **Input validation** -- Zod + AJV 雙重驗證
4. **Output sanitization** -- UI 使用 dompurify
5. **Audit logging** -- 完整的稽核日誌系統
6. **Tool policy** -- 工具執行策略與危險工具偵測
7. **Path guards** -- 目錄走訪防護
8. **Secrets detection** -- detect-secrets 整合
9. **Trusted proxy support** -- 可信代理標頭驗證

## 建議

1. 考慮為 plugin HTTP routes 加入可選的認證中介層
2. 定期更新依賴套件以修補已知漏洞
3. 考慮加入 CSP headers 到 gateway HTTP 回應

## 附錄：修改檔案清單

- `src/security/audit.ts` -- 新增 password 強度與 plugin route 的 audit findings
