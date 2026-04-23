---
name: intranet-penetration-deployment
description: VPS 侧内网穿透服务端部署指南。涵盖服务端安装、端口配置及在宿主机上的部署。
user-invocable: true
---

# 内网穿透服务端部署指南

在 **OpenClaw VPS 宿主机**上部署并运行内网穿透服务端（代号：nwct-server），以便为连接的 龙虾WiFi 路由器实现内网穿透。

## 推荐工作流 (端到端)

按照以下步骤设置完整的内网穿透方案：

### 阶段 0：环境重置 (可选)

如果用户要求重置、清理或卸载之前的配置，请调用 `openclaw_reset_frps`。该工具将停止服务、清理配置及二进制文件。

### 阶段 1：服务端部署 (VPS 侧)

1.  **自动化部署**：
    - 调用 `openclaw_deploy_frps` 在宿主机上安装（如需）并配置服务端。
    - 该工具会自动获取最新版服务端核心、安装至 `/usr/bin/nwct-server` 并配置 `nwct-server` systemd 服务。
2.  **状态验证**：
    - 调用 `openclaw_get_frps_status` 确认服务运行状态、监听端口及 Token。
3.  **信息告知**：
    - 将服务端的 `监听端口`、`Token` 及 `VPS 公网 IP` 告知用户。

### 阶段 2：客户端配置 (路由器侧)

1.  **连接设置**：
    - 调用 `clawwrt_set_xfrpc_common` 配置路由器的连接参数。
    - **强规则**：配置 `server_addr` 时，必须要求用户明确提供 VPS 的公网 IP 地址或域名，绝对不能自行猜测或获取本地 IP 填充。
    - **强规则**：配置 `token` 时，需提示用户提供；如果用户未提供，请自行生成一个随机字符串作为 token。
2.  **服务添加**：
    - 使用 `clawwrt_add_xfrpc_tcp_service` 创建所需的映射（例如 SSH 22 -> 远程 6000）。
3.  **运行检查**：
    - **必须检查** 客户端（xfrpc）是否正常启动并成功连接。可以通过 `clawwrt_get_xfrpc_config` 或查看系统日志确认。

### 阶段 3：最终功能验证

1.  **端口监听验证**：
    - **核心验证步骤**：在 VPS 宿主机上检查对应的 `远程端口`（如 TCP 6000）是否已进入 `LISTEN` 状态。
    - 如果端口未监听，说明客户端连接失败或配置有误。
2.  **连通性测试**：
    - 尝试通过 `VPS_IP:远程端口` 进行连接测试（如 `ssh -p 6000 user@VPS_IP`）。

> **⚠️ 防火墙提醒**: 务必引导用户开启 VPS 的相应 UDP/TCP 端口防火墙。
