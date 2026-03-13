---
summary: "How OpenClaw sandboxing works: modes, scopes, workspace access, and images"
title: Sandboxing
read_when: >-
  You want a dedicated explanation of sandboxing or need to tune
  agents.defaults.sandbox.
status: active
---

# Sandboxing

OpenClaw 可以在 **Docker 容器內執行工具** 以減少影響範圍。這是 **可選的**，並由設定控制 (`agents.defaults.sandbox` 或 `agents.list[].sandbox`). 如果沙盒功能關閉，工具將在主機上執行。網關保持在主機上；當啟用時，工具執行將在隔離的沙盒中執行。

這並不是一個完美的安全邊界，但當模型做出愚蠢的行為時，它實質上限制了檔案系統和進程的訪問。

## 什麼會被沙盒化

- 工具執行 (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`，等等)。
- 可選的沙盒瀏覽器 (`agents.defaults.sandbox.browser`)。
  - 預設情況下，當瀏覽器工具需要時，沙盒瀏覽器會自動啟動（確保 CDP 可達）。
    透過 `agents.defaults.sandbox.browser.autoStart` 和 `agents.defaults.sandbox.browser.autoStartTimeoutMs` 進行設定。
  - 預設情況下，沙盒瀏覽器容器使用專用的 Docker 網路 (`openclaw-sandbox-browser`)，而不是全域的 `bridge` 網路。
    透過 `agents.defaults.sandbox.browser.network` 進行設定。
  - 可選的 `agents.defaults.sandbox.browser.cdpSourceRange` 限制容器邊緣 CDP 的進入，使用 CIDR 允許清單（例如 `172.21.0.1/32`）。
  - noVNC 觀察者訪問預設是受密碼保護的；OpenClaw 會發出一個短期有效的 token URL，該 URL 提供本地啟動頁面並在 URL 片段中打開 noVNC，密碼不會出現在查詢/標頭日誌中。
  - `agents.defaults.sandbox.browser.allowHostControl` 允許沙盒會話明確針對主機瀏覽器。
  - 可選的允許清單控制 `target: "custom"`：`allowedControlUrls`，`allowedControlHosts`，`allowedControlPorts`。

Not sandboxed:

- Gateway 過程本身。
- 任何明確允許在主機上執行的工具（例如 `tools.elevated`）。
  - **提升的執行在主機上執行並繞過沙盒限制。**
  - 如果沙盒限制關閉，`tools.elevated` 不會改變執行（已經在主機上）。請參見 [提升模式](/tools/elevated)。

## Modes

`agents.defaults.sandbox.mode` 控制 **何時** 使用沙盒化：

- `"off"`: 無沙盒環境。
- `"non-main"`: 只對 **非主要** 會話進行沙盒處理（如果您希望在主機上進行正常聊天，則為預設選項）。
- `"all"`: 每個會話都在沙盒中執行。  
  注意：`"non-main"` 是基於 `session.mainKey`（預設 `"main"`），而不是代理 ID。  
  群組/頻道會話使用自己的金鑰，因此它們被視為非主要會話，並將進行沙盒處理。

## 範圍

`agents.defaults.sandbox.scope` 控制 **創建多少個容器**：

- `"session"` (預設): 每個會話一個容器。
- `"agent"`: 每個代理一個容器。
- `"shared"`: 所有沙盒會話共用一個容器。

## Workspace access

`agents.defaults.sandbox.workspaceAccess` 控制 **沙盒可以看到的內容**：

- `"none"` (預設): 工具在 `~/.openclaw/sandboxes` 下看到一個沙盒工作區。
- `"ro"`: 以唯讀方式掛載代理工作區於 `/agent` (禁用 `write`/`edit`/`apply_patch`)。
- `"rw"`: 以可讀寫方式掛載代理工作區於 `/workspace`。

進入的媒體被複製到活動的沙盒工作區 (`media/inbound/*`)。  
技能注意：`read` 工具是沙盒根據的。使用 `workspaceAccess: "none"`，OpenClaw 將符合條件的技能鏡像到沙盒工作區 (`.../skills`)，以便可以被讀取。使用 `"rw"`，工作區技能可以從 `/workspace/skills` 讀取。

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` 將額外的主機目錄掛載到容器中。  
格式：`host:container:mode`（例如，`"/home/user/source:/source:rw"`）。

全域和每個代理的綁定是**合併**的（而不是替換）。在 `scope: "shared"` 下，每個代理的綁定會被忽略。

`agents.defaults.sandbox.browser.binds` 僅將額外的主機目錄掛載到 **sandbox browser** 容器中。

- 當設定時（包括 `[]`），它會替換 `agents.defaults.sandbox.docker.binds` 以用於瀏覽器容器。
- 當省略時，瀏覽器容器會回退到 `agents.defaults.sandbox.docker.binds`（向後相容）。

範例（只讀來源 + 額外資料目錄）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/data/myapp:/data:ro"],
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

安全注意事項：

- 綁定繞過沙盒檔案系統：它們以您設定的任何模式暴露主機路徑 (`:ro` 或 `:rw`)。
- OpenClaw 阻擋危險的綁定來源（例如：`docker.sock`、`/etc`、`/proc`、`/sys`、`/dev`，以及會暴露它們的父掛載）。
- 敏感掛載（秘密、SSH 金鑰、服務憑證）應該 `:ro`，除非絕對必要。
- 如果您只需要對工作區的讀取存取，請結合 `workspaceAccess: "ro"`；綁定模式保持獨立。
- 有關綁定如何與工具政策和提升執行互動，請參見 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)。

## Images + setup

Default image: `openclaw-sandbox:bookworm-slim`

[[BLOCK_1]]  
Build it once:  
[[BLOCK_1]]

```bash
scripts/sandbox-setup.sh
```

注意：預設映像檔**不**包含 Node。如果一個技能需要 Node（或其他執行環境），請自訂映像檔或透過 `sandbox.docker.setupCommand` 安裝（需要網路出口 + 可寫入的根目錄 + 根使用者）。

如果您想要一個功能更完整的沙盒映像，並包含常用工具（例如 `curl`, `jq`, `nodejs`, `python3`, `git`），請建置：

```bash
scripts/sandbox-common-setup.sh
```

然後將 `agents.defaults.sandbox.docker.image` 設定為 `openclaw-sandbox-common:bookworm-slim`。

[[BLOCK_1]]

```bash
scripts/sandbox-browser-setup.sh
```

預設情況下，沙盒容器執行時 **沒有網路**。可以用 `agents.defaults.sandbox.docker.network` 來覆蓋此設定。

捆綁的沙盒瀏覽器映像也為容器化工作負載應用了保守的 Chromium 啟動預設值。目前的容器預設值包括：

- `--remote-debugging-address=127.0.0.1`
- `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
- `--user-data-dir=${HOME}/.chrome`
- `--no-first-run`
- `--no-default-browser-check`
- `--disable-3d-apis`
- `--disable-gpu`
- `--disable-dev-shm-usage`
- `--disable-background-networking`
- `--disable-extensions`
- `--disable-features=TranslateUI`
- `--disable-breakpad`
- `--disable-crash-reporter`
- `--disable-software-rasterizer`
- `--no-zygote`
- `--metrics-recording-only`
- `--renderer-process-limit=2`
- `--no-sandbox` 和 `--disable-setuid-sandbox` 當 `noSandbox` 被啟用時。
- 三個圖形強化標誌 (`--disable-3d-apis`, `--disable-software-rasterizer`, `--disable-gpu`) 是可選的，當容器缺乏 GPU 支援時非常有用。如果您的工作負載需要 WebGL 或其他 3D/瀏覽器功能，請設置 `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0`。
- `--disable-extensions` 預設為啟用狀態，並可以透過 `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` 在依賴擴充的流程中禁用。
- `--renderer-process-limit=2` 由 `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>` 控制，其中 `0` 保持 Chromium 的預設值。

如果您需要不同的執行時設定，請使用自訂的瀏覽器映像並提供您自己的入口點。對於本地（非容器）Chromium 設定，請使用 `browser.extraArgs` 來附加額外的啟動標誌。

安全預設：

- `network: "host"` 被封鎖。
- `network: "container:<id>"` 預設被封鎖（命名空間加入繞過風險）。
- 緊急解鎖覆蓋：`agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`。

Docker 安裝和容器化的閘道位於這裡：
[Docker](/install/docker)

對於 Docker 網關部署，`docker-setup.sh` 可以啟動沙盒設定。設定 `OPENCLAW_SANDBOX=1`（或 `true`/`yes`/`on`）以啟用該路徑。您可以使用 `OPENCLAW_DOCKER_SOCKET` 來覆蓋套接字位置。完整的設置和環境參考： [Docker](/install/docker#enable-agent-sandbox-for-docker-gateway-opt-in)。

## setupCommand (一次性容器設置)

`setupCommand` 在沙盒容器創建後 **執行一次**（而不是每次執行時）。它透過 `sh -lc` 在容器內部執行。

Paths:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

[[BLOCK_1]]

- 預設 `docker.network` 是 `"none"`（無出口），因此套件安裝將會失敗。
- `docker.network: "container:<id>"` 需要 `dangerouslyAllowContainerNamespaceJoin: true`，並且僅限於緊急情況使用。
- `readOnlyRoot: true` 防止寫入；請設定 `readOnlyRoot: false` 或製作自訂映像。
- `user` 必須是 root 才能進行套件安裝（省略 `user` 或設定 `user: "0:0"`）。
- 沙盒執行不會繼承主機 `process.env`。請使用 `agents.defaults.sandbox.docker.env`（或自訂映像）來獲取技能 API 金鑰。

## 工具政策 + 逃生通道

工具的允許/拒絕政策仍然適用於沙盒規則之前。如果一個工具在全域或每個代理上被拒絕，沙盒化不會恢復它。

`tools.elevated` 是一個明確的逃生閥，會在主機上執行 `exec`。`/exec` 指令僅適用於授權的發送者，並且在每個會話中持續存在；要強制禁用 `exec`，請使用工具政策拒絕 (請參見 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated))。

[[BLOCK_1]]

- 使用 `openclaw sandbox explain` 來檢查有效的沙盒模式、工具政策和修正設定鍵。
- 請參閱 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) 以了解「為什麼這被阻擋？」的思維模型。
  保持其鎖定狀態。

## Multi-agent overrides

每個代理都可以覆蓋沙盒 + 工具：
`agents.list[].sandbox` 和 `agents.list[].tools`（加上 `agents.list[].tools.sandbox.tools` 用於沙盒工具政策）。
請參閱 [多代理沙盒與工具](/tools/multi-agent-sandbox-tools) 以了解優先順序。

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

- [沙盒設定](/gateway/configuration#agentsdefaults-sandbox)
- [多代理沙盒與工具](/tools/multi-agent-sandbox-tools)
- [安全性](/gateway/security)
