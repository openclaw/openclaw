# OpenClaw 部署与调试记录 (2026-03-15)

本文档整理了本次部署和配置 OpenClaw 过程中遇到的核心问题、产生的原因以及相应的解决方案。

## 1. Cloudflare Tunnel 访问 Control UI 报 `502 Bad Gateway`

**问题表现：**
在 Cloudflare Tunnel 配置了 `localhost:18888` 后，通过域名访问 Control UI 显示 502 错误。尝试改成 `192.168.50.50` 和 `172.17.0.1` 依然无法访问。

**根本原因：**

1. **Docker 网络隔离**：运行 `cloudflared` 隧道的载体是一个 Docker 容器，并处于自定义网络 `gateway-net` 中。在容器内填写 `localhost` 指向的是容器自己，而非宿主机。
2. **宿主机防火墙拦截**：宿主机开启了 UFW 防火墙，默认仅放行了 80/443 以及部分本地开发端口。当 Docker 容器尝试通过局域网 IP (`192.168.50.50`) 访问宿主机的 `18888` 端口时，被 UFW 直接拦截。

**解决方案：**

1. 在宿主机放行 18888 端口的内网访问：`sudo ufw allow 18888/tcp`
2. 在 Cloudflare 隧道配置中，将目标 URL 修改为宿主机的局域网 IP：`http://192.168.50.50:18888` (或 Docker 网关 IP `http://172.20.0.1:18888`)。

---

## 2. 网页端 Control UI 提示 "pairing required"

**问题表现：**
通过域名成功打开 Web 界面后，输入令牌却无法连接，始终提示 `pairing required`。

**根本原因：**
OpenClaw 具有严格的安全设备验证机制。任何新的浏览器会话（或新设备）首次连接网关时，都会产生一个“配对请求 (Pairing Request)”。仅拥有认证令牌(Token)是不够的，还需要设备所有者在服务端进行授权放行。

**解决方案：**
在服务器终端中列出所有待处理的请求，并进行授权：

```bash
# 列出待配对的请求获取 Request ID
npx openclaw devices list

# 批准特定请求
npx openclaw devices approve <Request-ID>
```

审批通过后，会生成正式的设备 ID 并分配 `operator` 权限，刷新网页即可连接。

---

## 3. 误禁用 Discord 频道如何恢复

**问题表现：**
在 UI 中不小心将 Discord 禁用，需要重新启用。

**根本原因：**
UI 中的启停操作本质上是修改了底层的配置文件，将 `channels.discord.enabled` 设为了 `false`。

**解决方案：**
使用 CLI 更改配置，并重启网关服务：

```bash
# 1. 重新启用 Discord 配置
npx openclaw config set channels.discord.enabled true

# 2. 重启后端的 systemd 用户服务以加载新配置
systemctl --user restart openclaw-gateway.service
```

---

## 4. `openclaw status` 本地探测报错 (底层代码 BUG)

**问题表现：**
在服务器上执行 `npx openclaw status` 或查询详细状态时，命令失败并抛出异常：`unreachable (missing scope: operator.read)`。

**根本原因：**
这是 OpenClaw 源码 (`src/gateway/probe.ts`) 中的一个逻辑 Bug。之前的开发者为了“加固 Windows 上的生命周期检测”，通过 `isLoopbackHost(...)` 强行抹除了所有来自本地回环地址 (127.0.0.1) 探测请求的 `deviceIdentity`。
由于 WebSocket 连接缺乏设备身份标识，后端安全模块判定其无权限，直接清清空了 `operator.read` 作用域，导致 CLI 的状态查询接口（健康检查、配置获取等）被拒绝访问。

**解决方案：**
修改 `src/gateway/probe.ts` 的验证拦截逻辑，修复了“一刀切”的问题。仅当 `opts.includeDetails === false` (简单存活检测) 时忽略身份；而针对 CLI 发起的包含详细数据的“深度探测”，则保留身份，使其通过权限校验。

_已修改的源码逻辑：_

```typescript
const disableDeviceIdentity = (() => {
  try {
    return opts.includeDetails === false && isLoopbackHost(new URL(opts.url).hostname);
  } catch {
    return false;
  }
})();
```

**后续跟进：**
已基于上述改动拉取了新分支 `fix-cli-probe-identity` 并提交至 GitHub 仓库。包含详尽问题定位的 PR 文案也已同步整理完毕。

---

## 5. 公网暴露后的安全加固 (Security Hardening)

随着网关通过 Cloudflare Tunnel 暴露到了公网（绑定的 `0.0.0.0`），如果被脚本扫到或配置不当，可能面临未授权访问或接口被爆破的风险，因此执行了以下三个维度的安全配置：

### 5.1 配置网关防爆破限流 (Rate Limiting)

**原因：** 如果没有限流，攻击者可以通过高频暴力破解（Brute-force）网关 Auth Token。
**操作：**

```bash
# 限制 1 分钟内最多尝试 10 次，如果触发风控则锁定 IP 5 分钟
npx openclaw config set gateway.auth.rateLimit.maxAttempts 10
npx openclaw config set gateway.auth.rateLimit.windowMs 60000
npx openclaw config set gateway.auth.rateLimit.lockoutMs 300000
```

### 5.2 配置 Discord 白名单 (Allowlist)

**原因：** 启用了 Discord 的 `/` 斜杠命令。如果没有白名单，任意将机器人拉入频道的用户都能直接调用底层 AI 模型和工具。
**操作：**
将自己的 Discord ID（如 `1385538426161467493`）加入白名单：

```bash
npx openclaw config set channels.discord.guilds.'*'.users '["1385538426161467493"]' --json
```

### 5.3 环境变量层面固化鉴权

建议后续逐步将明文写入到 `openclaw.json` 中的关键 Token 或 Password 抽取至 `~/.profile`，或直接通过 `systemd` 的 `EnvironmentFile=/etc/openclaw/.env` 进行保护，从而满足最佳实践的 Secret 隔离要求。

### 5.4 修复 "Potential multi-user setup detected" 安全体检警告

**问题表现：**
在执行 `npx openclaw security audit` 进行体检时，系统提示 `WARN: Potential multi-user setup detected (personal-assistant model warning)` 警告。

**根本原因：**
这是一个**启发式线索提示（Heuristic warning）**。因为我们在上面为 Discord 通道配置了 `allowlist` 访问机制，OpenClaw 底层安全扫描器因此判定“你的网关可能会存在多用户访问的场景”。
由于 OpenClaw 的默认架构是“信任单一管理员（单点独占）”策略。当多用户共享或引入群组属性环境且未加隔离时，可能会互相干扰或导致 AI 误读系统级的敏感文件。

**解决方案：**
遵循“纵深防御（Defense-in-depth）”最佳实践，尽管我们在 Discord 等外层入口已经锁定您个人的 ID，但为了防范任何越权或隐私暴露可能，直接从底层网关开启强制沙盒隔离控制限制：

```bash
# 1. 强制启动沙盒引擎进行严格底线运行空间隔离
npx openclaw config set agents.defaults.sandbox.mode "all"

# 2. 限制文件系统读写，限定工具只能访问当前 Workspace，禁止越界读取宿主机外部文件
npx openclaw config set tools.fs.workspaceOnly true

# 3. 重启后端服务装载并生效最新的沙盒边界策略
systemctl --user restart openclaw-gateway.service
```

此时再次执行 `npx openclaw security audit`，此项高风险警告将自动降解并消除。
