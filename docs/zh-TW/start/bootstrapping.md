```
---
summary: "為工作區和身分檔案建立種子的智慧代理引導儀式"
read_when:
  - 了解智慧代理首次執行時會發生什麼事
  - 解釋引導檔案的儲存位置
  - 偵錯新手導覽身分設定
title: "智慧代理引導"
sidebarTitle: "引導"
---

# 智慧代理引導

引導是準備智慧代理工作區並收集身分詳細資料的**首次執行**儀式。它發生在新手導覽之後，即智慧代理首次啟動時。

## 引導的作用

在智慧代理首次執行時，OpenClaw 會引導工作區 (預設為 `~/.openclaw/workspace`)：

- 為 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md` 建立種子。
- 執行簡短的問答儀式 (一次一個問題)。
- 將身分 + 偏好設定寫入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成後移除 `BOOTSTRAP.md`，使其只執行一次。

## 執行位置

引導始終在 **Gateway 主機**上執行。如果 macOS 應用程式連接到遠端 Gateway，則工作區和引導檔案會儲存在該遠端機器上。

<Note>
當 Gateway 在另一台機器上執行時，請在 Gateway 主機上編輯工作區檔案 (例如，`user @gateway-host:~/.openclaw/workspace`)。
</Note>

## 相關檔案

- macOS 應用程式新手導覽：[新手導覽](/start/onboarding)
- 工作區佈局：[智慧代理工作區](/concepts/agent-workspace)
```
