---
summary: "OpenClaw 沙箱隔離運作方式：模式、範圍、工作區存取權及映像檔"
title: 沙箱隔離
read_when: "如果您需要沙箱隔離的專屬說明，或需要調整 agents.defaults.sandbox 時。"
status: active
---

# 沙箱隔離

OpenClaw 可以將 **工具在 Docker 容器內執行** 以減少受損範圍。
這是 **選用的**，並透過設定（`agents.defaults.sandbox` 或 `agents.list[].sandbox`）進行控制。如果沙箱隔離已關閉，工具會在主機上執行。
Gateway 會保留在主機上；啟用時，工具執行則會在隔離的沙箱中運作。

這並非完美的安全性邊界，但能在模型執行錯誤操作時，實質限制檔案系統與處理程序的存取。

## 哪些部分會被沙箱隔離

- 工具執行（`exec`、`read`、`write`、`edit`、`apply_patch`、`process` 等）。
- 選用的沙箱隔離瀏覽器（`agents.defaults.sandbox.browser`）。
  - 預設情況下，當瀏覽器工具需要時，沙箱瀏覽器會自動啟動（確保 CDP 可連通）。
    透過 `agents.defaults.sandbox.browser.autoStart` 和 `agents.defaults.sandbox.browser.autoStartTimeoutMs` 進行設定。
  - `agents.defaults.sandbox.browser.allowHostControl` 讓沙箱隔離工作階段能明確指定主機瀏覽器。
  - 選用的白名單用於控管 `target: "custom"`：`allowedControlUrls`、`allowedControlHosts`、`allowedControlPorts`。

未經沙箱隔離：

- Gateway 處理程序本身。
- 任何明確允許在主機上執行的工具（例如 `tools.elevated`）。
  - **提權執行（Elevated exec）會在主機上執行並繞過沙箱隔離。**
  - 如果沙箱隔離已關閉，`tools.elevated` 不會改變執行方式（本來就在主機上）。請參閱 [提權模式](/tools/elevated)。

## 模式

`agents.defaults.sandbox.mode` 控制 **何時** 使用沙箱隔離：

- `"off"`：不使用沙箱隔離。
- `"non-main"`：僅對 **非主要** 工作階段進行沙箱隔離（如果您希望在主機上進行一般對話，這是預設值）。
- `"all"`：每個工作階段都在沙箱中執行。
  注意：`\"non-main\"` 是基於 `session.mainKey`（預設為 `\"main\"`），而非智慧代理 ID。
  群組/頻道工作階段使用自己的鍵名，因此被視為非主要工作階段，將會被沙箱隔離。

## 範圍

`agents.defaults.sandbox.scope` 控制建立 **多少個容器**：

- `"session"`（預設）：每個工作階段一個容器。
- `"agent"`：每個智慧代理一個容器。
- `"shared"`：所有經沙箱隔離的工作階段共享一個容器。

## 工作區存取權

`agents.defaults.sandbox.workspaceAccess` 控制 **沙箱可以看到什麼**：

- `"none"`（預設）：工具看到的是位於 `~/.openclaw/sandboxes` 下的沙箱工作區。
- `"ro"`：將智慧代理工作區以唯讀方式掛載於 `/agent`（停用 `write`/`edit`/`apply_patch`）。
- `"rw"`：將智慧代理工作區以讀寫方式掛載於 `/workspace`。

傳入的媒體檔案會複製到當前沙箱工作區中（`media/inbound/*`）。
Skills 注意事項：`read` 工具是以沙箱為根目錄的。當 `workspaceAccess: \"none\"` 時，OpenClaw 會將符合條件的 Skills 鏡像到沙箱工作區（`.../skills`）以便讀取。當設為 `\"rw\"` 時，工作區的 Skills 可從 `/workspace/skills` 讀取。

## 自訂掛載

`agents.defaults.sandbox.docker.binds` 將額外的主機目錄掛載到容器中。
格式：`主機:容器:模式`（例如：`\"/home/user/source:/source:rw\"`）。

全域與個別智慧代理的掛載會 **合併**（而非取代）。在 `scope: \"shared\"` 模式下，個別智慧代理的掛載將被忽略。

範例（唯讀原始碼 + docker socket）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

安全性注意事項：

- 掛載（Binds）會繞過沙箱檔案系統：它們會以您設定的模式（`:ro` 或 `:rw`）公開主機路徑。
- 除非絕對必要，否則敏感的掛載（例如 `docker.sock`、私密資訊、SSH 金鑰）應設為 `:ro`。
- 如果您只需要對工作區的讀取權限，請搭配 `workspaceAccess: \"ro\"` 使用；掛載模式保持獨立。
- 請參閱 [沙箱 vs 工具政策 vs 提權執行](/gateway/sandbox-vs-tool-policy-vs-elevated) 以了解掛載如何與工具政策及提權執行互動。

## 映像檔 + 設定

預設映像檔：`openclaw-sandbox:bookworm-slim`

建置一次即可：

```bash
scripts/sandbox-setup.sh
```

注意：預設映像檔 **不包含** Node。如果某個 Skill 需要 Node（或其他執行環境），請建置自訂映像檔，或透過 `sandbox.docker.setupCommand` 安裝（需要網路連出 + 可寫入的根目錄 + root 使用者）。

沙箱隔離瀏覽器映像檔：

```bash
scripts/sandbox-browser-setup.sh
```

預設情況下，沙箱容器在執行時 **沒有網路連線**。
可透過 `agents.defaults.sandbox.docker.network` 覆蓋此設定。

Docker 安裝與容器化 Gateway 位於此處：
[Docker](/install/docker)

## setupCommand (容器單次設定)

`setupCommand` 在沙箱容器建立後執行 **一次**（而非每次執行時）。
它透過 `sh -lc` 在容器內執行。

路徑：

- 全域：`agents.defaults.sandbox.docker.setupCommand`
- 個別智慧代理：`agents.list[].sandbox.docker.setupCommand`

常見問題：

- 預設的 `docker.network` 為 `\"none\"`（無連出網路），因此套件安裝會失敗。
- `readOnlyRoot: true` 會阻止寫入；請設定 `readOnlyRoot: false` 或建置自訂映像檔。
- 安裝套件時 `user` 必須為 root（省略 `user` 或設定 `user: \"0:0\"`）。
- 沙箱執行 **不會** 繼承主機的 `process.env`。請使用 `agents.defaults.sandbox.docker.env`（或自訂映像檔）來設定 Skill 的 API 金鑰。

## 工具政策 + 逃生口

在沙箱規則套用前，工具的允許/拒絕政策仍然適用。如果工具在全域或個別智慧代理中被禁用，沙箱隔離也不會讓它恢復。

`tools.elevated` 是一個明確的逃生口，可在主機上執行 `exec`。
`/exec` 指令僅適用於授權的傳送者，並在每個工作階段中持續存在；若要完全停用 `exec`，請使用工具政策拒絕（請參閱 [沙箱 vs 工具政策 vs 提權執行](/gateway/sandbox-vs-tool-policy-vs-elevated)）。

偵錯：

- 使用 `openclaw sandbox explain` 來檢查生效的沙箱模式、工具政策及修復設定鍵名。
- 請參閱 [沙箱 vs 工具政策 vs 提權執行](/gateway/sandbox-vs-tool-policy-vs-elevated) 以了解「為什麼這被封鎖了？」的思維模型。
  請保持嚴格限制。

## 多智慧代理覆蓋

每個智慧代理都可以覆蓋沙箱與工具設定：
`agents.list[].sandbox` 和 `agents.list[].tools`（以及用於沙箱工具政策的 `agents.list[].tools.sandbox.tools`）。
請參閱 [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) 以了解優先順序。

## 最小啟用範例

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## 相關文件

- [沙箱設定](/gateway/configuration#agentsdefaults-sandbox)
- [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools)
- [安全性](/gateway/security)
