---
summary: "OpenClaw 沙箱隔離的運作方式：模式、範圍、工作區存取與映像"
title: 沙箱隔離
read_when: "當你需要關於沙箱隔離的專門說明，或需要調整 agents.defaults.sandbox。"
status: active
---

# 沙箱隔離

OpenClaw can run **tools inside Docker containers** to reduce blast radius.
This is **optional** and controlled by configuration (`agents.defaults.sandbox` or
`agents.list[].sandbox`). If sandboxing is off, tools run on the host.
The Gateway stays on the host; tool execution runs in an isolated sandbox
when enabled.

這不是完美的安全邊界，但當模型做出不當行為時，能實質限制檔案系統與行程的存取。

## 什麼會被沙箱隔離

- 工具執行（`exec`, `read`, `write`, `edit`, `apply_patch`, `process`，等）。
- 選用的沙箱隔離瀏覽器（`agents.defaults.sandbox.browser`）。
  - By default, the sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it.
    依預設，當瀏覽器工具需要時，沙箱瀏覽器會自動啟動（確保 CDP 可連線）。
    透過 `agents.defaults.sandbox.browser.autoStart` 與 `agents.defaults.sandbox.browser.autoStartTimeoutMs` 設定。
  - `agents.defaults.sandbox.browser.allowHostControl` 允許沙箱工作階段明確指向主機瀏覽器。
  - 選用的允許清單會限制 `target: "custom"`：`allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`。

不會被沙箱隔離：

- Gateway 閘道器 行程本身。
- 任何明確允許在主機上執行的工具（例如 `tools.elevated`）。
  - **提升權限的 exec 會在主機上執行並繞過沙箱隔離。**
  - 45. 若關閉沙箱，`tools.elevated` 不會改變執行方式（已在主機上）。 請參閱 [Elevated Mode](/tools/elevated)。

## 模式

`agents.defaults.sandbox.mode` 控制 **何時** 使用沙箱隔離：

- `"off"`：不使用沙箱隔離。
- 46. `"non-main"`：只對 **non-main** sessions 進行沙箱化（若你想讓一般聊天在主機上，這是預設）。
- 5. `"all"`：每個工作階段都在沙盒中執行。
     Note: `"non-main"` is based on `session.mainKey` (default `"main"`), not agent id.
     Group/channel sessions use their own keys, so they count as non-main and will be sandboxed.

## 8. 範圍

`agents.defaults.sandbox.scope` 控制 **會建立多少容器**：

- `"session"`（預設）：每個工作階段一個容器。
- `"agent"`：每個代理程式一個容器。
- `"shared"`：所有沙箱工作階段共用一個容器。

## Workspace access

`agents.defaults.sandbox.workspaceAccess` 控制 **沙箱能看到什麼**：

- `"none"`（預設）：工具只能看到位於 `~/.openclaw/sandboxes` 下的沙箱工作區。
- `"ro"`：以唯讀方式將代理程式工作區掛載到 `/agent`（會停用 `write`/`edit`/`apply_patch`）。
- `"rw"`：以可讀寫方式將代理程式工作區掛載到 `/workspace`。

10. 傳入的媒體會被複製到作用中的沙盒工作區（`media/inbound/*`）。
    Skills note: the `read` tool is sandbox-rooted. 傳入的媒體會被複製到目前作用中的沙箱工作區（`media/inbound/*`）。
    Skills 注意事項：`read` 工具以沙箱根目錄為基準。搭配 `workspaceAccess: "none"`，
    OpenClaw 會將符合條件的 skills 鏡像到沙箱工作區（`.../skills`）以供讀取。
    使用 `"rw"` 時，工作區 skills 可從 `/workspace/skills` 讀取。 With `"rw"`, workspace skills are readable from
    `/workspace/skills`.

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` 會將額外的主機目錄掛載到容器中。
格式：`host:container:mode`（例如 `"/home/user/source:/source:rw"`）。
Format: `host:container:mode` (e.g., `"/home/user/source:/source:rw"`).

Global and per-agent binds are **merged** (not replaced). Under `scope: "shared"`, per-agent binds are ignored.

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

安全性注意事項：

- 綁定會繞過沙箱檔案系統：它們會以你設定的模式（`:ro` 或 `:rw`）暴露主機路徑。
- 敏感掛載（例如 `docker.sock`、祕密、SSH 金鑰）應設為 `:ro`，除非絕對必要。
- 若你只需要對工作區的讀取權限，請搭配 `workspaceAccess: "ro"`；綁定模式彼此獨立。
- 綁定如何與工具政策與提升權限 exec 互動，請參閱 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)。

## 映像 + 設定

預設映像：`openclaw-sandbox:bookworm-slim`

建置一次即可：

```bash
scripts/sandbox-setup.sh
```

Note: the default image does **not** include Node. 注意：預設映像 **不** 包含 Node。若某個 skill 需要 Node（或
其他執行階段），請自行烘焙自訂映像，或透過
`sandbox.docker.setupCommand` 安裝（需要網路外連 + 可寫入的 root +
root 使用者）。

沙箱隔離瀏覽器映像：

```bash
scripts/sandbox-browser-setup.sh
```

By default, sandbox containers run with **no network**.
依預設，沙箱容器 **沒有網路**。
可使用 `agents.defaults.sandbox.docker.network` 覆寫。

Docker 安裝與容器化的 Gateway 閘道器 位於此處：
[Docker](/install/docker)

## setupCommand（一次性容器設定）

`setupCommand` 只會在建立沙箱容器後 **執行一次**（不會在每次執行時）。
它會透過 `sh -lc` 在容器內執行。
It executes inside the container via `sh -lc`.

路徑：

- 全域：`agents.defaults.sandbox.docker.setupCommand`
- 每個代理程式：`agents.list[].sandbox.docker.setupCommand`

常見陷阱：

- 預設的 `docker.network` 為 `"none"`（沒有外連），因此套件安裝會失敗。
- `readOnlyRoot: true` 會阻止寫入；請設定 `readOnlyRoot: false` 或烘焙自訂映像。
- 套件安裝需要 `user` 為 root（省略 `user` 或設定為 `user: "0:0"`）。
- Sandbox exec does **not** inherit host `process.env`. 沙箱 exec **不會** 繼承主機的 `process.env`。請使用
  `agents.defaults.sandbox.docker.env`（或自訂映像）來提供 skill 的 API 金鑰。

## 工具政策 + 逃生門

Tool allow/deny policies still apply before sandbox rules. If a tool is denied
globally or per-agent, sandboxing doesn’t bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` on the host.
`tools.elevated` 是一個明確的逃生門，會在主機上執行 `exec`。
`/exec` 指令僅對已授權的寄件者生效，並且會在每個工作階段中持續；若要硬性停用
`exec`，請使用工具政策的拒絕（請參閱 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)）。

24. 偵錯：

- 使用 `openclaw sandbox explain` 檢視實際生效的沙箱模式、工具政策，以及修正設定金鑰。
- 關於「為什麼會被阻擋？」的思維模型，請參閱 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)。
  請務必保持嚴格限制。
  Keep it locked down.

## 多代理程式覆寫

每個代理程式都可以覆寫沙箱與工具：
`agents.list[].sandbox` 與 `agents.list[].tools`（以及 `agents.list[].tools.sandbox.tools` 用於沙箱工具政策）。
優先順序請參閱 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)。
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

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

## Related docs

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
