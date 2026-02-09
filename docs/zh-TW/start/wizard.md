---
summary: "CLI 入門引導精靈：引導式設定 Gateway 閘道器、工作區、頻道與 Skills"
read_when:
  - 執行或設定入門引導精靈
  - 設定新機器
title: "入門引導精靈（CLI）"
sidebarTitle: "Onboarding: CLI"
---

# 入門引導精靈（CLI）

The onboarding wizard is the **recommended** way to set up OpenClaw on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

```bash
openclaw onboard
```

<Info>

最快速的第一次聊天：開啟 Control UI（不需要設定頻道）。執行
`openclaw dashboard`，並在瀏覽器中聊天。文件：[Dashboard](/web/dashboard)。
 Run
`openclaw dashboard` and chat in the browser. 文件：[Dashboard](/web/dashboard)。
</Info>

稍後要重新設定：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>

`--json` 並不代表非互動模式。用於腳本時，請使用 `--non-interactive`。
 For scripts, use `--non-interactive`.
</Note>

<Tip>

建議：設定 Brave Search API 金鑰，讓代理程式可以使用 `web_search`
（`web_fetch` 無需金鑰也可運作）。最簡單的路徑：`openclaw configure --section web`，
它會儲存 `tools.web.search.apiKey`。文件：[Web tools](/tools/web)。
 Easiest path: `openclaw configure --section web`
which stores `tools.web.search.apiKey`. 1. 文件：[Web 工具](/tools/web)。
</Tip>

## 快速開始 vs 進階

2. 精靈以 **QuickStart**（預設值）或 **Advanced**（完整控制）開始。

<Tabs>
  <Tab title="QuickStart (defaults)">
    - 本機 Gateway 閘道器（loopback）
    - 工作區預設值（或既有工作區）
    - Gateway 閘道器連接埠 **18789**
    - Gateway 閘道器身分驗證 **Token**（即使在 loopback 也會自動產生）
    - Tailscale 對外暴露 **關閉**
    - Telegram + WhatsApp 私訊預設為 **allowlist**（系統會提示你輸入電話號碼）
  </Tab>
  <Tab title="Advanced (full control)">
    - 公開每個步驟（模式、工作區、Gateway、頻道、常駐程式、技能）。
  </Tab>
</Tabs>

## 精靈會設定的項目

**本機模式（預設）** 會引導你完成以下步驟：

1. **模型／身分驗證** — Anthropic API 金鑰（建議）、OAuth、OpenAI，或其他提供者。選擇預設模型。 3. 選擇預設模型。
2. **工作區** — 代理程式檔案的位置（預設為 `~/.openclaw/workspace`）。建立啟動所需的初始檔案。 4. 產生種子（seeds）啟動檔案。
3. 5. **Gateway** — 連接埠、綁定位址、驗證模式、Tailscale 暴露設定。
4. **頻道** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles，或 iMessage。
5. **常駐程式** — 安裝 LaunchAgent（macOS）或 systemd 使用者單元（Linux/WSL2）。
6. **健康檢查** — 啟動 Gateway 閘道器並確認其正在執行。
7. **Skills** — 安裝建議的 Skills 與選用相依項目。

<Note>
6. 重新執行精靈**不會**清除任何內容，除非你明確選擇 **Reset**（或傳入 `--reset`）。
7. 如果設定無效或包含舊版金鑰，精靈會要求你先執行 `openclaw doctor`。
</Note>

**遠端模式** 僅會設定本機用戶端以連線至其他位置的 Gateway 閘道器。
它**不會**在遠端主機上安裝或變更任何內容。
It does **not** install or change anything on the remote host.

## 新增另一個代理程式

8. 使用 `openclaw agents add <name>` 建立一個具有獨立工作區、工作階段與驗證設定檔的代理。 Running without `--workspace` launches the wizard.

它會設定的內容：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意事項：

- 預設工作區遵循 `~/.openclaw/workspace-<agentId>`。
- 9. 新增 `bindings` 以路由傳入訊息（精靈可以代勞）。
- 非互動旗標：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完整參考

如需逐步的詳細說明、非互動式腳本、Signal 設定、
RPC API，以及精靈會寫入的完整設定欄位清單，請參閱
[Wizard Reference](/reference/wizard)。

## Related docs

- CLI 指令參考：[`openclaw onboard`](/cli/onboard)
- macOS 應用程式入門引導：[Onboarding](/start/onboarding)
- 代理程式首次執行儀式：[Agent Bootstrapping](/start/bootstrapping)
