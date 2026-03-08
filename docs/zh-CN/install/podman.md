---
summary: "在 rootless Podman 容器中运行 OpenClaw"
read_when:
  - 你想用 Podman 而非 Docker 来容器化运行网关
title: "Podman"
---

# Podman

在 **rootless** Podman 容器中运行 OpenClaw 网关。使用与 Docker 相同的镜像（从仓库 [Dockerfile](https://github.com/openclaw/openclaw/blob/main/Dockerfile) 构建）。

## 前置要求

- Podman（rootless 模式）
- 一次性设置需要 Sudo（创建用户、构建镜像）

## 快速开始

**1. 一次性设置**（在仓库根目录下；创建用户、构建镜像、安装启动脚本）：

```bash
./setup-podman.sh
```

这也会创建一个最小化的 `~openclaw/.openclaw/openclaw.json`（设置 `gateway.mode="local"`），让网关可以在不运行向导的情况下启动。

默认情况下容器**不会**安装为 systemd 服务，需要手动启动（见下文）。如果需要生产环境的自动启动和重启功能，可以安装为 systemd Quadlet 用户服务：

```bash
./setup-podman.sh --quadlet
```

（或设置 `OPENCLAW_PODMAN_QUADLET=1`；使用 `--container` 仅安装容器和启动脚本。）

**2. 启动网关**（手动，用于快速测试）：

```bash
./scripts/run-openclaw-podman.sh launch
```

**3. 配置向导**（例如添加频道或供应商）：

```bash
./scripts/run-openclaw-podman.sh launch setup
```

然后打开 `http://127.0.0.1:18789/`，使用 `~openclaw/.openclaw/.env` 中的 token（或 setup 输出的值）。

## Systemd（Quadlet，可选）

如果你运行了 `./setup-podman.sh --quadlet`（或 `OPENCLAW_PODMAN_QUADLET=1`），会安装一个 [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) 单元，让网关作为 openclaw 用户的 systemd 用户服务运行。设置结束时服务会被启用并启动。

- **启动：** `sudo systemctl --machine openclaw@ --user start openclaw.service`
- **停止：** `sudo systemctl --machine openclaw@ --user stop openclaw.service`
- **状态：** `sudo systemctl --machine openclaw@ --user status openclaw.service`
- **日志：** `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`

Quadlet 文件位于 `~openclaw/.config/containers/systemd/openclaw.container`。要修改端口或环境变量，编辑该文件（或它引用的 `.env`），然后 `sudo systemctl --machine openclaw@ --user daemon-reload` 并重启服务。系统启动时，如果 openclaw 启用了 lingering（setup 在 loginctl 可用时会自动设置），服务会自动启动。

要在初始设置时未使用 Quadlet 的情况下添加，重新运行：`./setup-podman.sh --quadlet`。

## openclaw 用户（非登录）

`setup-podman.sh` 创建一个专用系统用户 `openclaw`：

- **Shell：** `nologin` — 不允许交互式登录；减少攻击面。
- **主目录：** 例如 `/home/openclaw` — 存放 `~/.openclaw`（配置、工作区）和启动脚本 `run-openclaw-podman.sh`。
- **Rootless Podman：** 用户必须有 **subuid** 和 **subgid** 范围。许多发行版在创建用户时会自动分配。如果 setup 输出警告，在 `/etc/subuid` 和 `/etc/subgid` 中添加：

  ```text
  openclaw:100000:65536
  ```

  然后以该用户身份启动网关（例如通过 cron 或 systemd）：

  ```bash
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
  ```

- **配置：** 只有 `openclaw` 和 root 可以访问 `/home/openclaw/.openclaw`。要编辑配置：使用网关运行后的 Control UI，或 `sudo -u openclaw $EDITOR /home/openclaw/.openclaw/openclaw.json`。

## 环境变量和配置

- **Token：** 存储在 `~openclaw/.openclaw/.env` 中，变量名为 `OPENCLAW_GATEWAY_TOKEN`。`setup-podman.sh` 和 `run-openclaw-podman.sh` 会在缺失时自动生成（使用 `openssl`、`python3` 或 `od`）。
- **可选：** 在该 `.env` 文件中可以设置供应商密钥（如 `GROQ_API_KEY`、`OLLAMA_API_KEY`）和其他 OpenClaw 环境变量。
- **主机端口：** 默认映射 `18789`（网关）和 `18790`（bridge）。启动时可通过 `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` 和 `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` 覆盖**主机**端口映射。
- **网关绑定：** 默认情况下，`run-openclaw-podman.sh` 以 `--bind loopback` 启动网关，确保安全的本地访问。要在局域网暴露，设置 `OPENCLAW_GATEWAY_BIND=lan` 并在 `openclaw.json` 中配置 `gateway.controlUi.allowedOrigins`（或显式启用 host-header 回退）。
- **路径：** 主机配置和工作区默认为 `~openclaw/.openclaw` 和 `~openclaw/.openclaw/workspace`。可通过 `OPENCLAW_CONFIG_DIR` 和 `OPENCLAW_WORKSPACE_DIR` 覆盖启动脚本使用的主机路径。

## 常用命令

- **日志：** 使用 Quadlet：`sudo journalctl --machine openclaw@ --user -u openclaw.service -f`。使用脚本：`sudo -u openclaw podman logs -f openclaw`
- **停止：** 使用 Quadlet：`sudo systemctl --machine openclaw@ --user stop openclaw.service`。使用脚本：`sudo -u openclaw podman stop openclaw`
- **重新启动：** 使用 Quadlet：`sudo systemctl --machine openclaw@ --user start openclaw.service`。使用脚本：重新运行启动脚本或 `podman start openclaw`
- **删除容器：** `sudo -u openclaw podman rm -f openclaw` — 主机上的配置和工作区会保留

## 故障排除

- **配置或 auth-profiles 权限被拒绝 (EACCES)：** 容器默认使用 `--userns=keep-id`，以与运行脚本的主机用户相同的 uid/gid 运行。确保你的主机 `OPENCLAW_CONFIG_DIR` 和 `OPENCLAW_WORKSPACE_DIR` 归该用户所有。
- **网关启动被阻止（缺少 `gateway.mode=local`）：** 确保 `~openclaw/.openclaw/openclaw.json` 存在并设置了 `gateway.mode="local"`。`setup-podman.sh` 会在缺失时创建此文件。
- **openclaw 用户的 Rootless Podman 失败：** 检查 `/etc/subuid` 和 `/etc/subgid` 中是否包含 `openclaw` 的条目（如 `openclaw:100000:65536`）。如果缺失则添加并重启。
- **容器名称已被使用：** 启动脚本使用 `podman run --replace`，因此重新启动时会替换现有容器。手动清理：`podman rm -f openclaw`。
- **以 openclaw 身份运行时找不到脚本：** 确保已运行 `setup-podman.sh`，使 `run-openclaw-podman.sh` 被复制到 openclaw 的主目录（如 `/home/openclaw/run-openclaw-podman.sh`）。
- **Quadlet 服务未找到或启动失败：** 编辑 `.container` 文件后运行 `sudo systemctl --machine openclaw@ --user daemon-reload`。Quadlet 需要 cgroups v2：`podman info --format '{{.Host.CgroupsVersion}}'` 应显示 `2`。

## 可选：以你自己的用户运行

要以普通用户（无专用 openclaw 用户）运行网关：构建镜像，创建 `~/.openclaw/.env` 并设置 `OPENCLAW_GATEWAY_TOKEN`，然后使用 `--userns=keep-id` 和挂载到你的 `~/.openclaw` 运行容器。启动脚本为 openclaw 用户流程设计；对于单用户设置，你可以直接手动运行脚本中的 `podman run` 命令，将配置和工作区指向你的主目录。推荐大多数用户使用 `setup-podman.sh` 并以 openclaw 用户运行，以实现配置和进程隔离。
