---
summary: "关于 OpenClaw 设置、配置和使用的常见问题"
read_when:
  - 回答常见的设置、安装、入职或运行时支持问题
  - 在深入调试之前对用户报告的问题进行分类
title: "常见问题"
---

# 常见问题

针对真实世界设置（本地开发、VPS、多代理、OAuth/API 密钥、模型故障转移）的快速答案和更深入的故障排除。有关运行时诊断，请参阅 [故障排除](/gateway/troubleshooting)。有关完整配置参考，请参阅 [配置](/gateway/configuration)。

## 如果出现问题的前 60 秒

1. **快速状态（首次检查）**

   ```bash
   openclaw status
   ```

   快速本地摘要：操作系统 + 更新、网关/服务可达性、代理/会话、提供者配置 + 运行时问题（当网关可达时）。

2. **可粘贴报告（安全共享）**

   ```bash
   openclaw status --all
   ```

   只读诊断，带有日志尾部（令牌已编辑）。

3. **守护进程 + 端口状态**

   ```bash
   openclaw gateway status
   ```

   显示监督运行时与 RPC 可达性、探测目标 URL 以及服务可能使用的配置。

4. **深度探测**

   ```bash
   openclaw status --deep
   ```

   运行实时网关健康探测，包括支持时的频道探测
   （需要可达的网关）。请参阅 [健康](/gateway/health)。

5. **跟踪最新日志**

   ```bash
   openclaw logs --follow
   ```

   如果 RPC 关闭，回退到：

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   文件日志与服务日志分开；请参阅 [日志记录](/logging) 和 [故障排除](/gateway/troubleshooting)。

6. **运行医生（修复）**

   ```bash
   openclaw doctor
   ```

   修复/迁移配置/状态 + 运行健康检查。请参阅 [Doctor](/gateway/doctor)。

7. **网关快照**

   ```bash
   openclaw health --json
   openclaw health --verbose   # 在错误时显示目标 URL + 配置路径
   ```

   向运行中的网关请求完整快照（仅 WS）。请参阅 [健康](/gateway/health)。

## 快速开始和首次运行设置

<AccordionGroup>
  <Accordion title="我卡住了，最快的解决方法">
    使用可以**看到您机器**的本地 AI 代理。这比在 Discord 中询问要有效得多，因为大多数"我卡住了"的情况都是**本地配置或环境问题**，远程帮助者无法检查。

    - **Claude Code**：[https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
    - **OpenAI Codex**：[https://openai.com/codex/](https://openai.com/codex/)

    这些工具可以读取仓库、运行命令、检查日志并帮助修复您的机器级设置（PATH、服务、权限、认证文件）。通过可破解（git）安装给它们**完整的源代码检出**：

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    这会**从 git 检出**安装 OpenClaw，因此代理可以读取代码 + 文档并推理您正在运行的确切版本。您可以通过重新运行安装程序而不使用 `--install-method git` 随时切换回稳定版本。

    提示：请代理**计划和监督**修复（一步一步），然后只执行必要的命令。这样可以保持更改小且更容易审计。

    如果您发现真正的错误或修复，请在 GitHub 上提交问题或发送 PR：
    [https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
    [https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

    从这些命令开始（寻求帮助时分享输出）：

    ```bash
    openclaw status
    openclaw models status
    openclaw doctor
    ```

    它们的作用：

    - `openclaw status`：网关/代理健康 + 基本配置的快速快照。
    - `openclaw models status`：检查提供者认证 + 模型可用性。
    - `openclaw doctor`：验证并修复常见的配置/状态问题。

    其他有用的 CLI 检查：`openclaw status --all`、`openclaw logs --follow`、`openclaw gateway status`、`openclaw health --verbose`。

    快速调试循环：[如果出现问题的前 60 秒](#first-60-seconds-if-something-is-broken)。
    安装文档：[安装](/install)、[安装程序标志](/install/installer)、[更新](/install/updating)。

  </Accordion>

  <Accordion title="心跳一直跳过。跳过原因是什么意思？">
    常见的心跳跳过原因：

    - `quiet-hours`：在配置的活动小时窗口之外
    - `empty-heartbeat-file`：`HEARTBEAT.md` 存在但只包含空白/仅标题脚手架
    - `no-tasks-due`：`HEARTBEAT.md` 任务模式激活但没有任务间隔到期
    - `alerts-disabled`：所有心跳可见性都已禁用（`showOk`、`showAlerts` 和 `useIndicator` 都关闭）

    在任务模式下，到期时间戳只有在真正的心跳运行完成后才会推进。跳过的运行不会将任务标记为完成。

    文档：[心跳](/gateway/heartbeat)、[自动化和任务](/automation)。

  </Accordion>

  <Accordion title="安装和设置 OpenClaw 的推荐方法">
    仓库推荐从源代码运行并使用入职：

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    openclaw onboard --install-daemon
    ```

    向导还可以自动构建 UI 资产。入职后，您通常在端口 **18789** 上运行网关。

    从源代码（贡献者/开发人员）：

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    pnpm ui:build
    openclaw onboard
    ```

    如果您还没有全局安装，请通过 `pnpm openclaw onboard` 运行。

  </Accordion>

  <Accordion title="入职后如何打开仪表板？">
    向导在入职后立即在浏览器中打开一个干净（非令牌化）的仪表板 URL，并在摘要中打印链接。保持该选项卡打开；如果未启动，请在同一台机器上复制/粘贴打印的 URL。
  </Accordion>

  <Accordion title="如何在 localhost 与远程上认证仪表板？">
    **本地主机（同一台机器）：**

    - 打开 `http://127.0.0.1:18789/`。
    - 如果要求共享密钥认证，将配置的令牌或密码粘贴到控制 UI 设置中。
    - 令牌来源：`gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
    - 密码来源：`gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。
    - 如果尚未配置共享密钥，使用 `openclaw doctor --generate-gateway-token` 生成令牌。

    **非本地主机：**

    - **Tailscale Serve**（推荐）：保持绑定环回，运行 `openclaw gateway --tailscale serve`，打开 `https://<magicdns>/`。如果 `gateway.auth.allowTailscale` 为 `true`，身份头满足控制 UI/WebSocket 认证（无需粘贴共享密钥，假设受信任的网关主机）；HTTP API 仍需要共享密钥认证，除非您故意使用私有入口 `none` 或受信任代理 HTTP 认证。
      来自同一客户端的并发 Serve 认证尝试在失败认证限制器记录它们之前被序列化，因此第二次错误重试可能已经显示 `retry later`。
    - **Tailnet 绑定**：运行 `openclaw gateway --bind tailnet --token "<token>"`（或配置密码认证），打开 `http://<tailscale-ip>:18789/`，然后在仪表板设置中粘贴匹配的共享密钥。
    - **身份感知反向代理**：将网关保持在非环回受信任代理后面，配置 `gateway.auth.mode: "trusted-proxy"`，然后打开代理 URL。
    - **SSH 隧道**：`ssh -N -L 18789:127.0.0.1:18789 user@host` 然后打开 `http://127.0.0.1:18789/`。共享密钥认证仍然适用于隧道；如果提示，请粘贴配置的令牌或密码。

    请参阅 [仪表板](/web/dashboard) 和 [Web 界面](/web) 了解绑定模式和认证详情。

  </Accordion>

  <Accordion title="为什么聊天审批有两个 exec 审批配置？">
    它们控制不同的层：

    - `approvals.exec`：将审批提示转发到聊天目的地
    - `channels.<channel>.execApprovals`：使该频道作为 exec 审批的原生审批客户端

    主机 exec 策略仍然是真正的审批门。聊天配置仅控制审批提示出现的位置以及人们如何回答它们。

    在大多数设置中，您**不需要**两者：

    - 如果聊天已经支持命令和回复，同一聊天中的 `/approve` 通过共享路径工作。
    - 如果支持的原生频道可以安全地推断审批者，当 `channels.<channel>.execApprovals.enabled` 未设置或为 `"auto"` 时，OpenClaw 现在会自动启用 DM 优先的原生审批。
    - 当原生审批卡片/按钮可用时，该原生 UI 是主要路径；代理应仅在工具结果表明聊天审批不可用或手动审批是唯一路径时包含手动 `/approve` 命令。
    - 仅当提示必须也转发到其他聊天或显式操作室时才使用 `approvals.exec`。
    - 仅当您明确希望审批提示发布回原始房间/主题时，才使用 `channels.<channel>.execApprovals.target: "channel"` 或 `"both"`。
    - 插件审批再次分开：它们默认使用同一聊天的 `/approve`，可选的 `approvals.plugin` 转发，并且只有一些原生频道在顶部保留插件审批原生处理。

    简短版本：转发用于路由，原生客户端配置用于更丰富的频道特定 UX。
    请参阅 [Exec 审批](/tools/exec-approvals)。

  </Accordion>

  <Accordion title="我需要什么运行时？">
    需要 Node **>= 22**。推荐使用 `pnpm`。**不推荐**在网关上使用 Bun。
  </Accordion>

  <Accordion title="它能在树莓派上运行吗？">
    是的。网关轻量级 - 文档列出 **512MB-1GB RAM**、**1 核心**和大约 **500MB** 磁盘作为个人使用足够，并注意 **Raspberry Pi 4 可以运行它**。

    如果您想要额外的空间（日志、媒体、其他服务），**推荐 2GB**，但这不是硬性最低要求。

    提示：小型 Pi/VPS 可以托管网关，您可以在笔记本电脑/手机上配对 **节点**以进行本地屏幕/相机/画布或命令执行。请参阅 [节点](/nodes)。

  </Accordion>

  <Accordion title="树莓派安装有什么提示？">
    简短版本：它可以工作，但预计会有一些粗糙的边缘。

    - 使用 **64 位**操作系统并保持 Node >= 22。
    - 首选 **可破解（git）安装**，以便您可以查看日志并快速更新。
    - 先不使用频道/技能启动，然后逐一添加。
    - 如果遇到奇怪的二进制问题，通常是 **ARM 兼容性**问题。

    文档：[Linux](/platforms/linux)、[安装](/install)。

  </Accordion>

  <Accordion title="它卡在唤醒我的朋友 / 入职不会孵化。现在怎么办？">
    该屏幕取决于网关是否可达和已认证。TUI 也会在首次孵化时自动发送"醒醒，我的朋友！"。如果您看到该行**没有回复**并且令牌保持为 0，则代理从未运行。

    1. 重启网关：

    ```bash
    openclaw gateway restart
    ```

    2. 检查状态 + 认证：

    ```bash
    openclaw status
    openclaw models status
    openclaw logs --follow
    ```

    3. 如果仍然挂起，运行：

    ```bash
    openclaw doctor
    ```

    如果网关是远程的，确保隧道/Tailscale 连接已启动并且 UI 指向正确的网关。请参阅 [远程访问](/gateway/remote)。

  </Accordion>

  <Accordion title="我可以将设置迁移到新机器（Mac mini）而不重新入职吗？">
    是的。复制**状态目录**和**工作区**，然后运行一次 Doctor。这会保持您的机器人"完全相同"（内存、会话历史、认证和频道状态），只要您复制**两个**位置：

    1. 在新机器上安装 OpenClaw。
    2. 从旧机器复制 `$OPENCLAW_STATE_DIR`（默认：`~/.openclaw`）。
    3. 复制您的工作区（默认：`~/.openclaw/workspace`）。
    4. 运行 `openclaw doctor` 并重启网关服务。

    这会保留配置、认证配置文件、WhatsApp 凭证、会话和内存。如果您处于远程模式，请记住网关主机拥有会话存储和工作区。

    **重要：**如果您只提交/推送工作区到 GitHub，您是在备份**内存 + 引导文件**，但**不是**会话历史或认证。这些位于 `~/.openclaw/` 下（例如 `~/.openclaw/agents/<agentId>/sessions/`）。

    相关：[迁移](/install/migrating)、[磁盘上的内容位置](#where-things-live-on-disk)、[代理工作区](/concepts/agent-workspace)、[Doctor](/gateway/doctor)、[远程模式](/gateway/remote)。

  </Accordion>

  <Accordion title="在哪里可以看到最新版本的新内容？">
    查看 GitHub 变更日志：
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

    最新条目在顶部。如果顶部部分标记为 **Unreleased**，下一个日期部分是最新发布的版本。条目按 **Highlights**、**Changes** 和 **Fixes** 分组（必要时加上文档/其他部分）。

  </Accordion>

  <Accordion title="无法访问 docs.openclaw.ai（SSL 错误）">
    一些 Comcast/Xfinity 连接通过 Xfinity Advanced Security 错误地阻止 `docs.openclaw.ai`。禁用它或允许 `docs.openclaw.ai`，然后重试。
    请通过在此处报告帮助我们解除阻止：[https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)。

    如果您仍然无法访问该站点，文档在 GitHub 上有镜像：
    [https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

  </Accordion>

  <Accordion title="稳定版和测试版之间的区别">
    **稳定版**和**测试版**是**npm 分发标签**，不是单独的代码行：

    - `latest` = 稳定版
    - `beta` = 用于测试的早期构建

    通常，稳定版本首先登陆 **beta**，然后显式升级步骤将同一版本移动到 `latest`。维护者在需要时也可以直接发布到 `latest`。这就是为什么 beta 和稳定版在升级后可以指向**相同版本**。

    查看更改：
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

    有关安装单行命令以及 beta 和 dev 之间的区别，请参阅下面的手风琴。

  </Accordion>

  <Accordion title="如何安装测试版以及测试版和开发版之间的区别是什么？">
    **测试版**是 npm 分发标签 `beta`（升级后可能与 `latest` 匹配）。
    **开发版**是 `main`（git）的移动头部；发布时，它使用 npm 分发标签 `dev`。

    单行命令（macOS/Linux）：

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    Windows 安装程序（PowerShell）：
    [https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

    更多详情：[开发频道](/install/development-channels) 和 [安装程序标志](/install/installer)。

  </Accordion>

  <Accordion title="如何尝试最新版本？">
    两个选项：

    1. **开发频道（git 检出）：**

    ```bash
    openclaw update --channel dev
    ```

    这会切换到 `main` 分支并从源代码更新。

    2. **可破解安装（从安装程序站点）：**

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    这会给你一个可以编辑的本地仓库，然后通过 git 更新。

    如果您更喜欢手动干净克隆，请使用：

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    ```

    文档：[更新](/cli/update)、[开发频道](/install/development-channels)、[安装](/install)。

  </Accordion>

  <Accordion title="安装和入职通常需要多长时间？">
    大致指南：

    - **安装：** 2-5 分钟
    - **入职：** 5-15 分钟，取决于您配置的频道/模型数量

    如果挂起，请使用 [安装程序卡住](#quick-start-and-first-run-setup) 和 [我卡住了](#quick-start-and-first-run-setup) 中的快速调试循环。

  </Accordion>

  <Accordion title="安装程序卡住？如何获得更多反馈？">
    使用**详细输出**重新运行安装程序：

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
    ```

    带详细信息的测试版安装：

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
    ```

    对于可破解（git）安装：

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
    ```

    Windows（PowerShell）等效：

    ```powershell
    # install.ps1 还没有专用的 -Verbose 标志。
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

    更多选项：[安装程序标志](/install/installer)。

  </Accordion>

  <Accordion title="Windows 安装显示 git 未找到或 openclaw 未被识别">
    两个常见的 Windows 问题：

    **1) npm 错误 spawn git / git not found**

    - 安装 **Git for Windows** 并确保 `git` 在您的 PATH 上。
    - 关闭并重新打开 PowerShell，然后重新运行安装程序。

    **2) 安装后 openclaw 未被识别**

    - 您的 npm 全局 bin 文件夹不在 PATH 上。
    - 检查路径：

      ```powershell
      npm config get prefix
      ```

    - 将该目录添加到您的用户 PATH（Windows 上不需要 `\bin` 后缀；在大多数系统上是 `%AppData%\npm`）。
    - 更新 PATH 后关闭并重新打开 PowerShell。

    如果您想要最流畅的 Windows 设置，请使用 **WSL2** 而不是原生 Windows。
    文档：[Windows](/platforms/windows)。

  </Accordion>

  <Accordion title="Windows exec 输出显示乱码中文文本 - 我应该怎么办？">
    这通常是原生 Windows 外壳上的控制台代码页不匹配。

    症状：

    - `system.run`/`exec` 输出将中文渲染为乱码
    - 同一命令在另一个终端配置文件中看起来正常

    PowerShell 中的快速解决方法：

    ```powershell
    chcp 65001
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    ```

    然后重启网关并重试您的命令：

    ```powershell
    openclaw gateway restart
    ```

    如果您在最新的 OpenClaw 上仍然重现此问题，请在此处跟踪/报告：

    - [Issue #30640](https://github.com/openclaw/openclaw/issues/30640)

  </Accordion>

  <Accordion title="文档没有回答我的问题 - 如何获得更好的答案？">
    使用**可破解（git）安装**，这样您就有完整的源代码和本地文档，然后向您的机器人（或 Claude/Codex）从该文件夹**提问**，以便它可以读取仓库并精确回答。

    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```

    更多详情：[安装](/install) 和 [安装程序标志](/install/installer)。

  </Accordion>

  <Accordion title="如何在 Linux 上安装 OpenClaw？">
    简短回答：按照 Linux 指南操作，然后运行入职。

    - Linux 快速路径 + 服务安装：[Linux](/platforms/linux)。
    - 完整演练：[入门指南](/start/getting-started)。
    - 安装程序 + 更新：[安装和更新](/install/updating)。

  </Accordion>

  <Accordion title="如何在 VPS 上安装 OpenClaw？">
    任何 Linux VPS 都可以。在服务器上安装，然后使用 SSH/Tailscale 访问网关。

    指南：[exe.dev](/install/exe-dev)、[Hetzner](/install/hetzner)、[Fly.io](/install/fly)。
    远程访问：[网关远程](/gateway/remote)。

  </Accordion>

  <Accordion title="云/VPS 安装指南在哪里？">
    我们有一个**托管中心**，包含常见的提供者。选择一个并按照指南操作：

    - [VPS 托管](/vps)（所有提供者在一个地方）
    - [Fly.io](/install/fly)
    - [Hetzner](/install/hetzner)
    - [exe.dev](/install/exe-dev)

    它在云中的工作方式：**网关在服务器上运行**，您可以通过控制 UI（或 Tailscale/SSH）从笔记本电脑/手机访问它。您的状态 + 工作区位于服务器上，因此将主机视为真实来源并备份它。

    您可以将**节点**（Mac/iOS/Android/无头）配对到该云网关，以访问本地屏幕/相机/画布或在笔记本电脑上运行命令，同时将网关保持在云中。

    中心：[平台](/platforms)。远程访问：[网关远程](/gateway/remote)。
    节点：[节点](/nodes)、[节点 CLI](/cli/nodes)。

  </Accordion>

  <Accordion title="我可以让 OpenClaw 自己更新吗？">
    简短回答：**可能，不推荐**。更新流程可能会重启网关（这会中断活动会话），可能需要干净的 git 检出，并且可能会提示确认。更安全：作为操作员从 shell 运行更新。

    使用 CLI：

    ```bash
    openclaw update
    openclaw update status
    openclaw update --channel stable|beta|dev
    openclaw update --tag <dist-tag|version>
    openclaw update --no-restart
    ```

    如果必须从代理自动化：

    ```bash
    openclaw update --yes --no-restart
    openclaw gateway restart
    ```

    文档：[更新](/cli/update)、[更新](/install/updating)。

  </Accordion>

  <Accordion title="入职实际上做了什么？">
    `openclaw onboard` 是推荐的设置路径。在**本地模式**下，它引导您完成：

    - **模型/认证设置**（提供者 OAuth、API 密钥、Anthropic 设置令牌，以及本地模型选项如 LM Studio）
    - **工作区**位置 + 引导文件
    - **网关设置**（绑定/端口/认证/tailscale）
    - **频道**（WhatsApp、Telegram、Discord、Mattermost、Signal、iMessage，以及捆绑的频道插件如 QQ Bot）
    - **守护进程安装**（macOS 上的 LaunchAgent；Linux/WSL2 上的 systemd 用户单元）
    - **健康检查**和**技能**选择

    如果您配置的模型未知或缺少认证，它也会发出警告。

  </Accordion>

  <Accordion title="我需要 Claude 或 OpenAI 订阅来运行这个吗？">
    不需要。您可以使用**API 密钥**（Anthropic/OpenAI/其他）或**仅本地模型**运行 OpenClaw，这样您的数据就留在您的设备上。订阅（Claude Pro/Max 或 OpenAI Codex）是验证这些提供者的可选方式。

    对于 OpenClaw 中的 Anthropic，实际分割是：

    - **Anthropic API 密钥**：正常的 Anthropic API 计费
    - **Claude CLI / OpenClaw 中的 Claude 订阅认证**：Anthropic 工作人员告诉我们这种使用再次被允许，OpenClaw 正在将 `claude -p` 使用视为对此集成的认可，除非 Anthropic 发布新政策

    对于长期运行的网关主机，Anthropic API 密钥仍然是更可预测的设置。OpenAI Codex OAuth 明确支持 OpenClaw 等外部工具。

    OpenClaw 还支持其他托管订阅式选项，包括**Qwen Cloud Coding Plan**、**MiniMax Coding Plan**和**Z.AI / GLM Coding Plan**。

    文档：[Anthropic](/providers/anthropic)、[OpenAI](/providers/openai)、[Qwen Cloud](/providers/qwen)、[MiniMax](/providers/minimax)、[GLM 模型](/providers/glm)、[本地模型](/gateway/local-models)、[模型](/concepts/models)。

  </Accordion>

  <Accordion title="我可以在没有 API 密钥的情况下使用 Claude Max 订阅吗？">
    是的。

    Anthropic 工作人员告诉我们 OpenClaw 风格的 Claude CLI 使用再次被允许，因此 OpenClaw 将 Claude 订阅认证和 `claude -p` 使用视为对此集成的认可，除非 Anthropic 发布新政策。如果您想要最可预测的服务器端设置，请改用 Anthropic API 密钥。

  </Accordion>

  <Accordion title="你们支持 Claude 订阅认证（Claude Pro 或 Max）吗？">
    是的。

    Anthropic 工作人员告诉我们这种使用再次被允许，因此 OpenClaw 将 Claude CLI 重用和 `claude -p` 使用视为对此集成的认可，除非 Anthropic 发布新政策。

    Anthropic 设置令牌仍然可用作支持的 OpenClaw 令牌路径，但 OpenClaw 现在在可用时首选 Claude CLI 重用和 `claude -p`。
    对于生产或多用户工作负载，Anthropic API 密钥认证仍然是更安全、更可预测的选择。如果您想要 OpenClaw 中的其他订阅式托管选项，请参阅 [OpenAI](/providers/openai)、[Qwen / Model Cloud](/providers/qwen)、[MiniMax](/providers/minimax) 和 [GLM 模型](/providers/glm)。

  </Accordion>

<a id="why-am-i-seeing-http-429-ratelimiterror-from-anthropic"></a>
<Accordion title="为什么我看到来自 Anthropic 的 HTTP 429 rate_limit_error？">
这意味着您的**Anthropic 配额/速率限制**在当前窗口中已用尽。如果您使用**Claude CLI**，请等待窗口重置或升级您的计划。如果您使用**Anthropic API 密钥**，请检查 Anthropic 控制台的使用/计费并根据需要提高限制。

    如果消息具体是：
    `Extra usage is required for long context requests`，请求尝试使用 Anthropic 的 1M 上下文测试版（`context1m: true`）。这仅在您的凭证有资格进行长上下文计费（API 密钥计费或启用了 Extra Usage 的 OpenClaw Claude 登录路径）时有效。

    提示：设置**回退模型**，以便当提供者被速率限制时 OpenClaw 可以继续回复。
    请参阅 [模型](/cli/models)、[OAuth](/concepts/oauth) 和 [/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context](/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context)。

  </Accordion>

  <Accordion title="是否支持 AWS Bedrock？">
    是的。OpenClaw 有一个捆绑的**Amazon Bedrock（Converse）**提供者。当存在 AWS 环境标记时，OpenClaw 可以自动发现流式/文本 Bedrock 目录并将其合并为隐式 `amazon-bedrock` 提供者；否则，您可以显式启用 `plugins.entries.amazon-bedrock.config.discovery.enabled` 或添加手动提供者条目。请参阅 [Amazon Bedrock](/providers/bedrock) 和 [模型提供者](/providers/models)。如果您喜欢托管密钥流程，在 Bedrock 前面使用兼容 OpenAI 的代理仍然是有效选项。
  </Accordion>

  <Accordion title="Codex 认证如何工作？">
    OpenClaw 通过 OAuth（ChatGPT 登录）支持**OpenAI Code（Codex）**。入职可以运行 OAuth 流程，并在适当时将默认模型设置为 `openai-codex/gpt-5.4`。请参阅 [模型提供者](/concepts/model-providers) 和 [入职（CLI）](/start/wizard)。
  </Accordion>

  <Accordion title="为什么 ChatGPT GPT-5.4 不会在 OpenClaw 中解锁 openai/gpt-5.4？">
    OpenClaw 将两条路线分开处理：

    - `openai-codex/gpt-5.4` = ChatGPT/Codex OAuth
    - `openai/gpt-5.4` = 直接 OpenAI Platform API

    在 OpenClaw 中，ChatGPT/Codex 登录连接到 `openai-codex/*` 路线，而不是直接的 `openai/*` 路线。如果您在 OpenClaw 中想要直接 API 路径，请设置 `OPENAI_API_KEY`（或等效的 OpenAI 提供者配置）。如果您在 OpenClaw 中想要 ChatGPT/Codex 登录，请使用 `openai-codex/*`。

  </Accordion>

  <Accordion title="为什么 Codex OAuth 限制与 ChatGPT 网页不同？">
    `openai-codex/*` 使用 Codex OAuth 路线，其可用配额窗口由 OpenAI 管理且取决于计划。实际上，这些限制可能与 ChatGPT 网站/应用体验不同，即使两者都绑定到同一个账户。

    OpenClaw 可以在 `openclaw models status` 中显示当前可见的提供者使用/配额窗口，但它不会将 ChatGPT-web 权限发明或标准化为直接 API 访问。如果您想要直接 OpenAI Platform 计费/限制路径，请使用带有 API 密钥的 `openai/*`。

  </Accordion>

  <Accordion title="你们支持 OpenAI 订阅认证（Codex OAuth）吗？">
    是的。OpenClaw 完全支持**OpenAI Code（Codex）订阅 OAuth**。
    OpenAI 明确允许在 OpenClaw 等外部工具/工作流程中使用订阅 OAuth。入职可以为您运行 OAuth 流程。

    请参阅 [OAuth](/concepts/oauth)、[模型提供者](/concepts/model-providers) 和 [入职（CLI）](/start/wizard)。

  </Accordion>

  <Accordion title="如何设置 Gemini CLI OAuth？">
    Gemini CLI 使用**插件认证流程**，而不是 `openclaw.json` 中的客户端 ID 或密钥。

    步骤：

    1. 在本地安装 Gemini CLI，使 `gemini` 在 `PATH` 上
       - Homebrew：`brew install gemini-cli`
       - npm：`npm install -g @google/gemini-cli`
    2. 启用插件：`openclaw plugins enable google`
    3. 登录：`openclaw models auth login --provider google-gemini-cli --set-default`
    4. 登录后的默认模型：`google-gemini-cli/gemini-3-flash-preview`
    5. 如果请求失败，在网关主机上设置 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID`

    这将 OAuth 令牌存储在网关主机上的认证配置文件中。详情：[模型提供者](/concepts/model-providers)。

  </Accordion>

  <Accordion title="本地模型是否适合休闲聊天？">
    通常不适合。OpenClaw 需要大上下文 + 强安全性；小卡片会截断和泄露。如果必须，请在本地运行**最大**的模型构建（LM Studio），并查看 [/gateway/local-models](/gateway/local-models)。较小/量化模型增加提示注入风险 - 请参阅 [安全](/gateway/security)。
  </Accordion>

  <Accordion title="如何将托管模型流量保持在特定区域？">
    选择区域固定端点。OpenRouter 为 MiniMax、Kimi 和 GLM 提供美国托管选项；选择美国托管变体以保持数据在区域内。您仍然可以通过使用 `models.mode: "merge"` 列出 Anthropic/OpenAI，以便在尊重您选择的区域提供者的同时保持回退可用。
  </Accordion>

  <Accordion title="我必须购买 Mac Mini 来安装这个吗？">
    不需要。OpenClaw 运行在 macOS 或 Linux（Windows 通过 WSL2）上。Mac mini 是可选的 - 有些人购买一个作为始终开启的主机，但小型 VPS、家庭服务器或树莓派级盒子也可以。

    您只需要 Mac **用于 macOS 专用工具**。对于 iMessage，请使用 [BlueBubbles](/channels/bluebubbles)（推荐）- BlueBubbles 服务器运行在任何 Mac 上，网关可以运行在 Linux 或其他地方。如果您想要其他 macOS 专用工具，请在 Mac 上运行网关或配对 macOS 节点。

    文档：[BlueBubbles](/channels/bluebubbles)、[节点](/nodes)、[Mac 远程模式](/platforms/mac/remote)。

  </Accordion>

  <Accordion title="我需要 Mac mini 来支持 iMessage 吗？">
    您需要**某种 macOS 设备**登录到 Messages。它**不一定**是 Mac mini - 任何 Mac 都可以。**使用 [BlueBubbles](/channels/bluebubbles)**（推荐）用于 iMessage - BlueBubbles 服务器运行在 macOS 上，而网关可以运行在 Linux 或其他地方。

    常见设置：

    - 在 Linux/VPS 上运行网关，在任何登录到 Messages 的 Mac 上运行 BlueBubbles 服务器。
    - 如果您想要最简单的单机设置，在 Mac 上运行所有内容。

    文档：[BlueBubbles](/channels/bluebubbles)、[节点](/nodes)、[Mac 远程模式](/platforms/mac/remote)。

  </Accordion>

  <Accordion title="如果我购买 Mac mini 来运行 OpenClaw，我可以将其连接到我的 MacBook Pro 吗？">
    是的。**Mac mini 可以运行网关**，您的 MacBook Pro 可以作为**节点**（配套设备）连接。节点不运行网关 - 它们提供额外的功能，如该设备上的屏幕/相机/画布和 `system.run`。

    常见模式：

    - Mac mini 上的网关（始终开启）。
    - MacBook Pro 运行 macOS 应用或节点主机并配对到网关。
    - 使用 `openclaw nodes status` / `openclaw nodes list` 查看它。

    文档：[节点](/nodes)、[节点 CLI](/cli/nodes)。

  </Accordion>

  <Accordion title="我可以使用 Bun 吗？">
    **不推荐**使用 Bun。我们看到运行时错误，尤其是 WhatsApp 和 Telegram。
    使用**Node**用于稳定的网关。

    如果您仍然想使用 Bun 进行实验，请在没有 WhatsApp/Telegram 的非生产网关上进行。

  </Accordion>

  <Accordion title="Telegram：allowFrom 中应该放什么？">
    `channels.telegram.allowFrom` 是**人类发送者的 Telegram 用户 ID**（数字）。它不是机器人用户名。

    设置只要求数字用户 ID。如果您的配置中已经有旧的 `@username` 条目，`openclaw doctor --fix` 可以尝试解析它们。

    更安全（无第三方机器人）：

    - 向您的机器人发送 DM，然后运行 `openclaw logs --follow` 并读取 `from.id`。

    官方 Bot API：

    - 向您的机器人发送 DM，然后调用 `https://api.telegram.org/bot<bot_token>/getUpdates` 并读取 `message.from.id`。

    第三方（隐私性较差）：

    - 向 `@userinfobot` 或 `@getidsbot` 发送 DM。

    请参阅 [/channels/telegram](/channels/telegram#access-control-and-activation)。

  </Accordion>

  <Accordion title="多个人可以使用同一个 WhatsApp 号码与不同的 OpenClaw 实例吗？">
    是的，通过**多代理路由**。将每个发送者的 WhatsApp **DM**（对等 `kind: "direct"`，发送者 E.164 如 `+15551234567`）绑定到不同的 `agentId`，这样每个人都有自己的工作区和会话存储。回复仍然来自**同一个 WhatsApp 账户**，并且 DM 访问控制（`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`）在每个 WhatsApp 账户中是全局的。请参阅 [多代理路由](/concepts/multi-agent) 和 [WhatsApp](/channels/whatsapp)。
  </Accordion>

  <Accordion title='我可以运行 "快速聊天" 代理和 "Opus 编码" 代理吗？'>
    是的。使用多代理路由：为每个代理设置自己的默认模型，然后将入站路由（提供者账户或特定对等方）绑定到每个代理。示例配置位于 [多代理路由](/concepts/multi-agent)。另请参阅 [模型](/concepts/models) 和 [配置](/gateway/configuration)。
  </Accordion>

  <Accordion title="Homebrew 在 Linux 上有效吗？">
    是的。Homebrew 支持 Linux（Linuxbrew）。快速设置：

    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    brew install <formula>
    ```

    如果您通过 systemd 运行 OpenClaw，请确保服务 PATH 包含 `/home/linuxbrew/.linuxbrew/bin`（或您的 brew 前缀），以便 `brew` 安装的工具在非登录 shell 中解析。
    最近的构建还在 Linux systemd 服务上预置常见用户 bin 目录（例如 `~/.local/bin`、`~/.npm-global/bin`、`~/.local/share/pnpm`、`~/.bun/bin`），并在设置时尊重 `PNPM_HOME`、`NPM_CONFIG_PREFIX`、`BUN_INSTALL`、`VOLTA_HOME`、`ASDF_DATA_DIR`、`NVM_DIR` 和 `FNM_DIR`。

  </Accordion>

  <Accordion title="可破解 git 安装和 npm 安装之间的区别">
    - **可破解（git）安装：** 完整的源代码检出，可编辑，最适合贡献者。
      您在本地运行构建并可以修补代码/文档。
    - **npm 安装：** 全局 CLI 安装，无仓库，最适合"只需运行它"。
      更新来自 npm 分发标签。

    文档：[入门](/start/getting-started)、[更新](/install/updating)。

  </Accordion>

  <Accordion title="我以后可以在 npm 和 git 安装之间切换吗？">
    是的。安装另一种风格，然后运行 Doctor，使网关服务指向新的入口点。
    这**不会删除您的数据** - 它只会更改 OpenClaw 代码安装。您的状态（`~/.openclaw`）和工作区（`~/.openclaw/workspace`）保持不变。

    从 npm 到 git：

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm build
    openclaw doctor
    openclaw gateway restart
    ```

    从 git 到 npm：

    ```bash
    npm install -g openclaw@latest
    openclaw doctor
    openclaw gateway restart
    ```

    Doctor 检测到网关服务入口点不匹配，并提供重写服务配置以匹配当前安装（在自动化中使用 `--repair`）。

    备份提示：请参阅 [备份策略](#where-things-live-on-disk)。

  </Accordion>

  <Accordion title="我应该在笔记本电脑还是 VPS 上运行网关？">
    简短回答：**如果您想要 24/7 可靠性，使用 VPS**。如果您想要最低摩擦并且对睡眠/重启没问题，在本地运行。

    **笔记本电脑（本地网关）**

    - **优点：** 无服务器成本，直接访问本地文件，实时浏览器窗口。
    - **缺点：** 睡眠/网络断开 = 断开连接，操作系统更新/重启中断，必须保持唤醒。

    **VPS / 云**

    - **优点：** 始终开启，稳定网络，无笔记本电脑睡眠问题，更容易保持运行。
    - **缺点：** 通常无头（使用屏幕截图），仅远程文件访问，必须 SSH 进行更新。

    **OpenClaw 特定说明：** WhatsApp/Telegram/Slack/Mattermost/Discord 在 VPS 上都能正常工作。唯一真正的权衡是**无头浏览器**与可见窗口。请参阅 [浏览器](/tools/browser)。

    **推荐默认值：** 如果您之前有网关断开连接，请使用 VPS。当您积极使用 Mac 并希望本地文件访问或使用可见浏览器进行 UI 自动化时，本地是很好的选择。

  </Accordion>

  <Accordion title="在专用机器上运行 OpenClaw 有多重要？">
    不是必需的，但**推荐用于可靠性和隔离**。

    - **专用主机（VPS/Mac mini/Pi）：** 始终开启，睡眠/重启中断更少，权限更干净，更容易保持运行。
    - **共享笔记本电脑/桌面：** 完全适合测试和积极使用，但在机器睡眠或更新时会暂停。

    如果您想要两全其美，请将网关保持在专用主机上，并将笔记本电脑配对为**节点**以使用本地屏幕/相机/exec 工具。请参阅 [节点](/nodes)。
    有关安全指导，请阅读 [安全](/gateway/security)。

  </Accordion>

  <Accordion title="VPS 的最低要求和推荐操作系统是什么？">
    OpenClaw 轻量级。对于基本网关 + 一个聊天频道：

    - **绝对最低：** 1 vCPU，1GB RAM，~500MB 磁盘。
    - **推荐：** 1-2 vCPU，2GB RAM 或更多，以获得空间（日志、媒体、多个频道）。节点工具和浏览器自动化可能消耗资源。

    操作系统：使用 **Ubuntu LTS**（或任何现代 Debian/Ubuntu）。Linux 安装路径在那里测试最好。

    文档：[Linux](/platforms/linux)、[VPS 托管](/vps)。

  </Accordion>

  <Accordion title="我可以在 VM 中运行 OpenClaw 吗？有什么要求？">
    是的。将 VM 视为与 VPS 相同：它需要始终开启，可访问，并且有足够的 RAM 用于网关和您启用的任何频道。

    基线指导：

    - **绝对最低：** 1 vCPU，1GB RAM。
    - **推荐：** 2GB RAM 或更多，如果您运行多个频道、浏览器自动化或媒体工具。
    - **操作系统：** Ubuntu LTS 或另一个现代 Debian/Ubuntu。

    如果您在 Windows 上，**WSL2 是最简单的 VM 风格设置**，具有最佳工具兼容性。请参阅 [Windows](/platforms/windows)、[VPS 托管](/vps)。
    如果您在 VM 中运行 macOS，请参阅 [macOS VM](/install/macos-vm)。

  </Accordion>
</AccordionGroup>

## 什么是 OpenClaw？

<AccordionGroup>
  <Accordion title="用一段话描述 OpenClaw 是什么？">
    OpenClaw 是您在自己设备上运行的个人 AI 助手。它在您已经使用的消息表面（WhatsApp、Telegram、Slack、Mattermost、Discord、Google Chat、Signal、iMessage、WebChat 和捆绑的频道插件如 QQ Bot）上回复，并且在支持的平台上还可以进行语音 + 实时画布。**网关**是始终开启的控制平面；助手是产品。
  </Accordion>

  <Accordion title="价值主张">
    OpenClaw 不仅仅是"Claude 包装器"。它是一个**本地优先控制平面**，让您在**自己的硬件**上运行一个有能力的助手，从您已经使用的聊天应用中访问，具有有状态会话、内存和工具 - 而不需要将工作流的控制权交给托管的 SaaS。

    亮点：

    - **您的设备，您的数据：** 在任何您想要的地方（Mac、Linux、VPS）运行网关，并保持工作区 + 会话历史本地。
    - **真实频道，不是网页沙箱：** WhatsApp/Telegram/Slack/Discord/Signal/iMessage 等，
      以及支持平台上的移动语音和画布。
    - **模型无关：** 使用 Anthropic、OpenAI、MiniMax、OpenRouter 等，具有每代理路由和故障转移。
    - **仅本地选项：** 运行本地模型，这样**所有数据可以留在您的设备上**（如果您愿意）。
    - **多代理路由：** 每个频道、账户或任务的单独代理，每个都有自己的工作区和默认设置。
    - **开源且可破解：** 无需供应商锁定即可检查、扩展和自托管。

    文档：[网关](/gateway)、[频道](/channels)、[多代理](/concepts/multi-agent)、[内存](/concepts/memory)。

  </Accordion>

  <Accordion title="我刚设置好它 - 我应该先做什么？">
    好的第一个项目：

    - 构建网站（WordPress、Shopify 或简单的静态站点）。
    - 原型移动应用（大纲、屏幕、API 计划）。
    - 组织文件和文件夹（清理、命名、标记）。
    - 连接 Gmail 并自动执行摘要或后续操作。

    它可以处理大任务，但当您将它们分成阶段并使用子代理进行并行工作时，效果最好。

  </Accordion>

  <Accordion title="OpenClaw 的前五个日常用例是什么？">
    日常胜利通常看起来像：

    - **个人简报：** 您关心的收件箱、日历和新闻的摘要。
    - **研究和起草：** 快速研究、摘要和电子邮件或文档的初稿。
    - **提醒和后续行动：** 由 cron 或心跳驱动的提醒和清单。
    - **浏览器自动化：** 填写表单、收集数据和重复网页任务。
    - **跨设备协调：** 从手机发送任务，让网关在服务器上运行它，并在聊天中获取结果。

  </Accordion>

  <Accordion title="OpenClaw 可以帮助 SaaS 的销售线索生成、外展、广告和博客吗？">
    是的，用于**研究、资格认证和起草**。它可以扫描站点、构建候选名单、总结潜在客户并编写外展或广告文案草稿。

    对于**外展或广告运行**，请保持人工参与。避免垃圾邮件，遵循当地法律和平台政策，并在发送前审查任何内容。最安全的模式是让 OpenClaw 起草，您批准。

    文档：[安全](/gateway/security)。

  </Accordion>

  <Accordion title="与 Claude Code 相比，OpenClaw 在 Web 开发方面有什么优势？">
    OpenClaw 是一个**个人助手**和协调层，而不是 IDE 替代品。使用 Claude Code 或 Codex 在仓库内进行最快的直接编码循环。当您想要持久内存、跨设备访问和工具编排时，使用 OpenClaw。

    优势：

    - **跨会话的持久内存 + 工作区**
    - **多平台访问**（WhatsApp、Telegram、TUI、WebChat）
    - **工具编排**（浏览器、文件、调度、钩子）
    - **始终开启的网关**（在 VPS 上运行，从任何地方交互）
    - **节点**用于本地浏览器/屏幕/相机/exec

    展示：[https://openclaw.ai/showcase](https://openclaw.ai/showcase)

  </Accordion>
</AccordionGroup>

## 技能和自动化

<AccordionGroup>
  <Accordion title="如何自定义技能而不使仓库变脏？">
    使用托管覆盖而不是编辑仓库副本。将您的更改放在 `~/.openclaw/skills/<name>/SKILL.md` 中（或通过 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 添加文件夹）。优先级是 `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → 捆绑 → `skills.load.extraDirs`，因此托管覆盖仍然在不触及 git 的情况下优先于捆绑技能。如果您需要全局安装但只对某些代理可见的技能，请将共享副本保存在 `~/.openclaw/skills` 中，并使用 `agents.defaults.skills` 和 `agents.list[].skills` 控制可见性。只有值得上游的编辑应该留在仓库中并作为 PR 发布。
  </Accordion>

  <Accordion title="我可以从自定义文件夹加载技能吗？">
    是的。通过 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 添加额外目录（最低优先级）。默认优先级是 `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → 捆绑 → `skills.load.extraDirs`。`clawhub` 默认安装到 `./skills`，OpenClaw 在下次会话中将其视为 `<workspace>/skills`。如果技能应仅对某些代理可见，请将其与 `agents.defaults.skills` 或 `agents.list[].skills` 配对。
  </Accordion>

  <Accordion title="如何为不同任务使用不同模型？">
    今天支持的模式是：

    - **Cron 任务**：隔离任务可以为每个任务设置 `model` 覆盖。
    - **子代理**：将任务路由到具有不同默认模型的单独代理。
    - **按需切换**：使用 `/model` 在任何时候切换当前会话模型。

    请参阅 [Cron 任务](/automation/cron-jobs)、[多代理路由](/concepts/multi-agent) 和 [斜杠命令](/tools/slash-commands)。

  </Accordion>

  <Accordion title="机器人在做繁重工作时冻结。如何卸载？">
    对长或并行任务使用**子代理**。子代理在自己的会话中运行，返回摘要，并保持您的主聊天响应。

    请您的机器人"为此任务生成子代理"或使用 `/subagents`。
    在聊天中使用 `/status` 查看网关现在正在做什么（以及它是否忙）。

    令牌提示：长任务和子代理都消耗令牌。如果成本是问题，通过 `agents.defaults.subagents.model` 为子代理设置更便宜的模型。

    文档：[子代理](/tools/subagents)、[后台任务](/automation/tasks)。

  </Accordion>

  <Accordion title="Discord 上的线程绑定子代理会话如何工作？">
    使用线程绑定。您可以将 Discord 线程绑定到子代理或会话目标，以便该线程中的后续消息保持在该绑定会话上。

    基本流程：

    - 使用 `thread: true` 生成 `sessions_spawn`（可选 `mode: "session"` 用于持久后续）。
    - 或使用 `/focus <target>` 手动绑定。
    - 使用 `/agents` 检查绑定状态。
    - 使用 `/session idle <duration|off>` 和 `/session max-age <duration|off>` 控制自动取消焦点。
    - 使用 `/unfocus` 分离线程。

    所需配置：

    - 全局默认值：`session.threadBindings.enabled`、`session.threadBindings.idleHours`、`session.threadBindings.maxAgeHours`。
    - Discord 覆盖：`channels.discord.threadBindings.enabled`、`channels.discord.threadBindings.idleHours`、`channels.discord.threadBindings.maxAgeHours`。
    - 生成时自动绑定：设置 `channels.discord.threadBindings.spawnSubagentSessions: true`。

    文档：[子代理](/tools/subagents)、[Discord](/channels/discord)、[配置参考](/gateway/configuration-reference)、[斜杠命令](/tools/slash-commands)。

  </Accordion>

  <Accordion title="子代理完成了，但完成更新去了错误的地方或从未发布。我应该检查什么？">
    首先检查解析的请求者路由：

    - 完成模式子代理交付在存在绑定线程或对话路由时优先使用。
    - 如果完成源只携带频道，OpenClaw 回退到请求者会话的存储路由（`lastChannel` / `lastTo` / `lastAccountId`），以便直接交付仍然可以成功。
    - 如果既没有绑定路由也没有可用的存储路由，直接交付可能失败，结果回退到排队的会话交付而不是立即发布到聊天。
    - 无效或过时的目标仍然可以强制队列回退或最终交付失败。
    - 如果子级的最后一个可见助手回复正是静默令牌 `NO_REPLY` / `no_reply`，或正是 `ANNOUNCE_SKIP`，OpenClaw 有意抑制公告，而不是发布过时的早期进度。
    - 如果子级在仅工具调用后超时，公告可以将其折叠为简短的部分进度摘要，而不是重放原始工具输出。

    调试：

    ```bash
    openclaw tasks show <runId-or-sessionKey>
    ```

    文档：[子代理](/tools/subagents)、[后台任务](/automation/tasks)、[会话工具](/concepts/session-tool)。

  </Accordion>

  <Accordion title="Cron 或提醒不触发。我应该检查什么？">
    Cron 在网关进程内运行。如果网关不是连续运行，计划的作业将不会运行。

    检查清单：

    - 确认 cron 已启用（`cron.enabled`）且未设置 `OPENCLAW_SKIP_CRON`。
    - 检查网关是否 24/7 运行（无睡眠/重启）。
    - 验证作业的时区设置（`--tz` 与主机时区）。

    调试：

    ```bash
    openclaw cron run <jobId>
    openclaw cron runs --id <jobId> --limit 50
    ```

    文档：[Cron 任务](/automation/cron-jobs)、[自动化和任务](/automation)。

  </Accordion>

  <Accordion title="Cron 触发了，但没有发送到频道。为什么？">
    首先检查交付模式：

    - `--no-deliver` / `delivery.mode: "none"` 意味着不期望外部消息。
    - 缺少或无效的公告目标（`channel` / `to`）意味着运行器跳过出站交付。
    - 频道认证失败（`unauthorized`、`Forbidden`）意味着运行器尝试交付但凭证阻止了它。
    - 静默隔离结果（仅 `NO_REPLY` / `no_reply`）被视为有意不可交付，因此运行器也抑制排队的回退交付。

    对于隔离的 cron 作业，运行器拥有最终交付权。代理应返回纯文本摘要供运行器发送。`--no-deliver` 保持该结果内部；它不允许代理改为使用消息工具直接发送。

    调试：

    ```bash
    openclaw cron runs --id <jobId> --limit 50
    openclaw tasks show <runId-or-sessionKey>
    ```

    文档：[Cron 任务](/automation/cron-jobs)、[后台任务](/automation/tasks)。

  </Accordion>

  <Accordion title="为什么隔离的 cron 运行切换模型或重试一次？">
    这通常是实时模型切换路径，不是重复调度。

    隔离的 cron 可以在活动运行抛出 `LiveSessionModelSwitchError` 时保持运行时模型切换并重试。重试保持切换的提供者/模型，如果切换携带新的认证配置文件覆盖，cron 在重试前也会保持它。

    相关选择规则：

    - Gmail 钩子模型覆盖在适用时首先获胜。
    - 然后是每个作业的 `model`。
    - 然后是任何存储的 cron 会话模型覆盖。
    - 然后是正常的代理/默认模型选择。

    重试循环是有界的。在初始尝试加上 2 次切换重试后，
