---
summary: "使用裝置流程從 OpenClaw 登入 GitHub Copilot"
read_when:
  - 您想將 GitHub Copilot 作為模型供應商使用
  - 您需要 `openclaw models auth login-github-copilot` 流程
title: "GitHub Copilot"
---

# GitHub Copilot

## 什麼是 GitHub Copilot？

GitHub Copilot 是 GitHub 的 AI 程式碼助手。它根據您的 GitHub 帳戶和方案提供 Copilot 模型的存取權限。OpenClaw 可以透過兩種不同方式將 Copilot 作為模型供應商使用。

## 在 OpenClaw 中使用 Copilot 的兩種方式

### 1) 內建 GitHub Copilot 供應商 (`github-copilot`)

使用原生的裝置登入流程來取得 GitHub 權杖，然後在 OpenClaw 執行時將其交換為 Copilot API 權杖。這是**預設**且最簡單的路徑，因為它不需要 VS Code。

### 2) Copilot Proxy 外掛程式 (`copilot-proxy`)

使用 **Copilot Proxy** VS Code 擴充功能作為本地橋接器。OpenClaw 與代理伺服器的 `/v1` 端點通訊，並使用您在該處設定的模型列表。如果您已經在 VS Code 中執行 Copilot Proxy 或需要透過它進行路由，請選擇此選項。您必須啟用該外掛程式並保持 VS Code 擴充功能處於執行狀態。

將 GitHub Copilot 作為模型供應商 (`github-copilot`) 使用。登入指令會執行 GitHub 裝置流程，儲存驗證設定檔，並更新您的設定以使用該設定檔。

## CLI 設定

```bash
openclaw models auth login-github-copilot
```

系統會提示您造訪一個網址並輸入一次性代碼。在完成之前，請保持終端機開啟。

### 選用旗標

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## 設定預設模型

```bash
openclaw models set github-copilot/gpt-4o
```

### 設定片段

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 注意事項

- 需要互動式 TTY；請直接在終端機中執行。
- Copilot 模型的可用性取決於您的方案；如果某個模型被拒絕，請嘗試另一個 ID（例如 `github-copilot/gpt-4.1`）。
- 登入時會將 GitHub 權杖儲存在驗證設定檔儲存區中，並在 OpenClaw 執行時將其交換為 Copilot API 權杖。
