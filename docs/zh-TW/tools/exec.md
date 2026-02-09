---
summary: "Exec 工具的使用方式、stdin 模式與 TTY 支援"
read_when:
  - 使用或修改 exec 工具時
  - 偵錯 stdin 或 TTY 行為時
title: "Exec 工具"
---

# Exec 工具

在工作區中執行 shell 指令。 Supports foreground + background execution via `process`.
若 `process` 被拒絕，`exec` 會同步執行並忽略 `yieldMs`/`background`。
49. 背景工作階段以代理為範圍；`process` 只能看到同一代理的工作階段。

## 參數

- `command`（必要）
- `workdir`（預設為 cwd）
- `env`（鍵／值覆寫）
- `yieldMs`（預設 10000）：延遲後自動轉為背景
- `background`（bool）：立即在背景執行
- `timeout`（秒，預設 1800）：到期時終止
- `pty`（bool）：可用時在虛擬終端中執行（僅限 TTY 的 CLI、編碼代理程式、終端介面）
- `host`（`sandbox | gateway | node`）：執行位置
- `security`（`deny | allowlist | full`）：`gateway`/`node` 的強制模式
- `ask`（`off | on-miss | always`）：`gateway`/`node` 的核准提示
- `node`（string）：`host=node` 的節點 id／名稱
- `elevated`（bool）：請求提升模式（Gateway 閘道器主機）；只有當提升解析為 `full` 時，`security=full` 才會被強制

注意事項：

- `host` 預設為 `sandbox`。
- 當沙箱隔離關閉時，`elevated` 會被忽略（exec 已在主機上執行）。
- `gateway`/`node` 的核准由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要已配對的節點（配套應用程式或無介面節點主機）。
- 若有多個節點可用，請設定 `exec.node` 或 `tools.exec.node` 來選擇其中一個。
- 在非 Windows 主機上，當設定時 exec 會使用 `SHELL`；若 `SHELL` 為 `fish`，則偏好使用 `bash`（或 `sh`）
  來自 `PATH` 以避免與 fish 不相容的指令碼，若兩者皆不存在則回退到 `SHELL`。
- 主機執行（`gateway`/`node`）會拒絕 `env.PATH` 與載入器覆寫（`LD_*`/`DYLD_*`），
  以防止二進位檔劫持或注入程式碼。
- 50. 重要：沙箱化**預設為關閉**。 If sandboxing is off, `host=sandbox` runs directly on
      the gateway host (no container) and **does not require approvals**. To require approvals, run with
      `host=gateway` and configure exec approvals (or enable sandboxing).

## 設定

- `tools.exec.notifyOnExit`（預設：true）：為 true 時，背景執行的 exec 工作階段會排入系統事件，並在結束時請求心跳。
- `tools.exec.approvalRunningNoticeMs`（預設：10000）：當需核准的 exec 執行時間超過此值時，發出單一的「執行中」通知（0 表示停用）。
- `tools.exec.host`（預設：`sandbox`）
- `tools.exec.security`（預設：沙箱為 `deny`；Gateway 閘道器 + 節點在未設定時為 `allowlist`）
- `tools.exec.ask`（預設：`on-miss`）
- `tools.exec.node`（預設：未設定）
- `tools.exec.pathPrepend`：要在 exec 執行時前置到 `PATH` 的目錄清單。
- `tools.exec.safeBins`：僅 stdin 的安全二進位檔，可在沒有明確允許清單項目的情況下執行。

範例：

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH 處理

- `host=gateway`：將你的登入殼層 `PATH` 合併到 exec 環境中。主機執行時會拒絕 `env.PATH` 覆寫。
  守護程式本身仍以最小化的 `PATH` 執行： `env.PATH` overrides are
  rejected for host execution. The daemon itself still runs with a minimal `PATH`:
  - macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux：`/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`：在容器內執行 `sh -lc`（登入殼層），因此 `/etc/profile` 可能會重設 `PATH`。
  OpenClaw 會在設定檔載入後，透過內部環境變數前置 `env.PATH`（不進行殼層插值）；
  `tools.exec.pathPrepend` 亦適用於此。
  OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation);
  `tools.exec.pathPrepend` applies here too.
- `host=node`：只會將你傳入且未被封鎖的環境變數覆寫送至節點。主機執行時會拒絕 `env.PATH` 覆寫。
  無介面節點主機僅在其前置節點主機 PATH（不取代）時才接受 `PATH`。
  macOS 節點會完全捨棄 `PATH` 覆寫。 `env.PATH` overrides are
  rejected for host execution. Headless node hosts accept `PATH` only when it prepends the node host
  PATH (no replacement). macOS nodes drop `PATH` overrides entirely.

每個代理程式的節點綁定（在設定中使用代理程式清單索引）：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制 UI：Nodes 分頁包含一個小型的「Exec 節點綁定」面板，提供相同的設定。

## Session overrides (`/exec`)

30. 使用 `/exec` 設定**每個工作階段**的 `host`、`security`、`ask` 與 `node` 預設值。
    Send `/exec` with no arguments to show the current values.

範例：

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 授權模型

`/exec` 僅對**已授權的寄件者**生效（頻道允許清單／配對加上 `commands.useAccessGroups`）。
它只會更新**工作階段狀態**，不會寫入設定。若要硬性停用 exec，請透過工具
政策（`tools.deny: ["exec"]` 或每個代理程式）來拒絕。除非你明確設定
`security=full` 與 `ask=off`，否則主機核准仍然適用。
It updates **session state only** and does not write config. To hard-disable exec, deny it via tool
policy (`tools.deny: ["exec"]` or per-agent). Host approvals still apply unless you explicitly set
`security=full` and `ask=off`.

## Exec approvals (companion app / node host)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host.
See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.

31. 當需要核准時，exec 工具會立即回傳 `status: "approval-pending"` 與一個核准 ID。 Once approved (or denied / timed out),
    the Gateway emits system events (`Exec finished` / `Exec denied`). If the command is still
    running after `tools.exec.approvalRunningNoticeMs`, a single `Exec running` notice is emitted.

## 允許清單 + 安全二進位檔

Allowlist enforcement matches **resolved binary paths only** (no basename matches). When
`security=allowlist`, shell commands are auto-allowed only if every pipeline segment is
allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections are rejected in
allowlist mode.

## 範例

前景：

```json
{ "tool": "exec", "command": "ls -la" }
```

背景 + 輪詢：

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

傳送按鍵（tmux 風格）：

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

提交（僅送出 CR）：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (bracketed by default):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch（實驗性）

`apply_patch` 是 `exec` 的子工具，用於結構化的多檔案編輯。
請明確啟用：
32. 請明確啟用它：

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

注意事項：

- 僅適用於 OpenAI／OpenAI Codex 模型。
- 工具政策仍然適用；`allow: ["exec"]` 會隱含允許 `apply_patch`。
- 設定位於 `tools.exec.applyPatch` 之下。
