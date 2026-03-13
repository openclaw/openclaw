---
summary: "Community plugins: quality bar, hosting requirements, and PR submission path"
read_when:
  - You want to publish a third-party OpenClaw plugin
  - You want to propose a plugin for docs listing
title: Community plugins
---

# 社群外掛

本頁面追蹤高品質的 **社群維護外掛**，適用於 OpenClaw。

我們接受符合品質標準的 PR，將社群外掛新增至此處。

## 列表要求

- 外掛套件已發佈於 npmjs（可透過 `openclaw plugins install <npm-spec>` 安裝）。
- 原始碼託管於 GitHub（公開倉庫）。
- 倉庫包含安裝/使用文件及問題追蹤系統。
- 外掛有明確的維護狀態（活躍維護者、近期更新或積極回應問題）。

## 如何提交

開啟 PR，將您的外掛新增至本頁，並提供：

- 外掛名稱
- npm 套件名稱
- GitHub 倉庫網址
- 一行描述
- 安裝指令

## 審核標準

我們偏好實用、文件齊全且安全的外掛。
低成本包裝、所有權不明或無維護的套件可能會被拒絕。

## 範例格式

新增條目時請使用以下格式：

- **外掛名稱** — 簡短描述  
  npm: `@scope/package`  
  repo: `https://github.com/org/repo`  
  install: `openclaw plugins install @scope/package`

## 已列出外掛

- **WeChat** — 透過 WeChatPadPro（iPad 協議）將 OpenClaw 連接至微信個人帳號。支援文字、圖片及檔案交換，並可透過關鍵字觸發對話。  
  npm: `@icesword760/openclaw-wechat`  
  repo: `https://github.com/icesword0760/openclaw-wechat`  
  install: `openclaw plugins install @icesword760/openclaw-wechat`
