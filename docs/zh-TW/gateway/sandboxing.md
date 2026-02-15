---
summary: "OpenClaw 沙箱隔離的運作方式：模式、範圍、工作區存取和映像"
title: 沙箱隔離
read_when: "您需要專門解釋沙箱隔離，或需要調整 agents.defaults.sandbox 設定。"
status: active
---

# 沙箱隔離

OpenClaw 可以**在 Docker 容器內執行工具**以減少影響範圍。
這是**選用的**，由設定控制（`agents.defaults.sandbox` 或
`agents.list[].sandbox`）。如果沙箱隔離關閉，工具會在主機上執行。
Gateway會留在主機上；啟用時，工具執行會在隔離的沙箱隔離中執行。

這不是一個完美的安全性邊界，但當模型執行錯誤操作時，它能實質性地限制檔案系統和程序存取。

## 哪些內容會被沙箱隔離

- 工具執行（`exec`、`read`、`write`、`edit`、`apply_patch`、`process` 等）。
- 選用的沙箱隔離瀏覽器（`agents.defaults.sandbox.browser`）。
  - 預設情況下，當瀏覽器工具需要時，沙箱隔離瀏覽器會自動啟動（確保 CDP 可達）。
    透過 `agents.defaults.sandbox.browser.autoStart` 和 `agents.defaults.sandbox.browser.autoStartTimeoutMs` 設定。
  - `agents.defaults.sandbox.browser.allowHostControl` 允許沙箱隔離工作階段明確地鎖定主機瀏覽器。
  - 選用的允許列表會限制 `target: "custom"`：`allowedControlUrls`、`allowedControlHosts`、`allowedControlPorts`。

不會被沙箱隔離：

- Gateway程序本身。
- 任何明確允許在主機上執行的工具（例如 `tools.elevated`）。
  - **提權 exec 會在主機上執行並繞過沙箱隔離。**
  - 如果沙箱隔離關閉，`tools.elevated` 不會改變執行（已在主機上）。請參閱[提權模式](/tools/elevated)。

## 模式

`agents.defaults.sandbox.mode` 控制**何時**使用沙箱隔離：

- `"off"`：不使用沙箱隔離。
- `"non-main"`：僅沙箱隔離**非主要**工作階段（如果您希望一般聊天在主機上執行，這是預設值）。
- `"all"`：每個工作階段都在沙箱隔離中執行。
  注意：`"non-main"` 是基於 `session.mainKey`（預設值為 `"main"`），而不是智慧代理 ID。
  群組/頻道工作階段使用它們自己的鍵，因此它們被視為非主要工作階段並將被沙箱隔離。

## 範圍

`agents.defaults.sandbox.scope` 控制**會建立多少容器**：

- `"session"`（預設）：每個工作階段一個容器。
- `"agent"`：每個智慧代理一個容器。
- `"shared"`：所有沙箱隔離工作階段共用一個容器。

## 工作區存取

`agents.defaults.sandbox.workspaceAccess` 控制**沙箱隔離可以看到什麼**：

- `"none"`（預設）：工具會看到 `~/.openclaw/sandboxes` 下的沙箱隔離工作區。
- `"ro"`：以唯讀方式在 `/agent` 掛載智慧代理工作區（禁用 `write`/`edit`/`apply_patch`）。
- `"rw"`：以讀寫方式在 `/workspace` 掛載智慧代理工作區。

入站媒體會複製到啟用的沙箱隔離工作區（`media/inbound/*`）。
Skills 注意事項：`read` 工具以沙箱隔離為根。當 `workspaceAccess: "none"` 時，OpenClaw 會將符合條件的 Skills 鏡像到沙箱隔離工作區（`.../skills`），以便可以讀取。當使用 `"rw"` 時，工作區 Skills 可以從 `/workspace/skills` 讀取。

## 自訂綁定掛載

`agents.defaults.sandbox.docker.binds` 會將額外的主機目錄掛載到容器中。
格式：`host:container:mode`（例如 `"/home/user/source:/source:rw"`）。

全域和每個智慧代理的綁定會**合併**（而不是替換）。在 `scope: "shared"` 下，每個智慧代理的綁定會被忽略。

範例（唯讀來源 + docker socket）：

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

安全注意事項：

- 綁定會繞過沙箱隔離檔案系統：它們會以您設定的任何模式（`:ro` 或 `:rw`）暴露主機路徑。
- 敏感掛載（例如 `docker.sock`、機密、SSH 金鑰）應該是 `:ro`，除非絕對必要。
- 如果您只需要對工作區的讀取權限，請結合 `workspaceAccess: "ro"`；綁定模式保持獨立。
- 請參閱[沙箱隔離 vs 工具策略 vs 提權](/gateway/sandbox-vs-tool-policy-vs-elevated)，了解綁定如何與工具策略和提權 exec 互動。

## 映像 + 設定

預設映像：`openclaw-sandbox:bookworm-slim`

建置一次：

```bash
scripts/sandbox-setup.sh
```

注意：預設映像**不**包含 Node。如果 Skills 需要 Node（或其他執行環境），要嘛建置自訂映像，要嘛透過
`sandbox.docker.setupCommand` 安裝（需要網路出站 + 可寫入的根 + root 使用者）。

沙箱隔離瀏覽器映像：

```bash
scripts/sandbox-browser-setup.sh
```

預設情況下，沙箱隔離容器執行時**沒有網路**。
透過 `agents.defaults.sandbox.docker.network` 覆寫。

Docker 安裝和容器化 Gateway在此：
[Docker](/install/docker)

## setupCommand（一次性容器設定）

`setupCommand` 會在沙箱隔離容器建立後**執行一次**（而不是每次執行）。
它透過 `sh -lc` 在容器內執行。

路徑：

- 全域：`agents.defaults.sandbox.docker.setupCommand`
- 每個智慧代理：`agents.list[].sandbox.docker.setupCommand`

常見的陷阱：

- 預設的 `docker.network` 是 `"none"`（無出站），因此套件安裝會失敗。
- `readOnlyRoot: true` 會阻止寫入；設定 `readOnlyRoot: false` 或建置自訂映像。
- `user` 必須是 root 才能安裝套件（省略 `user` 或設定 `user: "0:0"`）。
- 沙箱隔離 exec **不會**繼承主機的 `process.env`。請使用
  `agents.defaults.sandbox.docker.env`（或自訂映像）來設定 Skills API 金鑰。

## 工具策略 + 逃逸通道

工具允許/拒絕策略仍然在沙箱隔離規則之前應用。如果工具被全域或每個智慧代理拒絕，沙箱隔離不會使其恢復。

`tools.elevated` 是一個明確的逃逸通道，可在主機上執行 `exec`。
`/exec` 指令僅適用於授權的傳送者並在每個工作階段持續存在；若要硬性禁用 `exec`，請使用工具策略拒絕（請參閱[沙箱隔離 vs 工具策略 vs 提權](/gateway/sandbox-vs-tool-policy-vs-elevated)）。

偵錯：

- 使用 `openclaw sandbox explain` 來檢查有效的沙箱隔離模式、工具策略和修正設定鍵。
- 請參閱[沙箱隔離 vs 工具策略 vs 提權](/gateway/sandbox-vs-tool-policy-vs-elevated)，了解「為什麼這會被阻止？」的心智模型。
  保持鎖定。

## 多智慧代理覆寫

每個智慧代理都可以覆寫沙箱隔離 + 工具：
`agents.list[].sandbox` 和 `agents.list[].tools`（以及 `agents.list[].tools.sandbox.tools` 用於沙箱隔離工具策略）。
請參閱[多智慧代理沙箱隔離與工具](/tools/multi-agent-sandbox-tools)以了解優先順序。

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

- [沙箱隔離設定](/gateway/configuration#agentsdefaults-sandbox)
- [多智慧代理沙箱隔離與工具](/tools/multi-agent-sandbox-tools)
- [安全](/gateway/security)
