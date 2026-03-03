---
name: deploy-gateway
description: 将代码部署到 openclaw-gateway-huiling GCP VM 并重建 Docker。当用户说"部署"、"deploy"、"更新 VM"、"推到服务器"时使用。
---

# Deploy to openclaw-gateway-huiling

## 基本信息

- **VM**: `openclaw-gateway-huiling`（GCP infist 项目，us-central1-a）
- **SSH**: `ssh openclaw-gateway`（通过 IAP 隧道，已在 `~/.ssh/config` 配置好）
- **代码路径**: `~/openclaw`
- **代码来源**: `fork/main`（即 `https://github.com/waweili/openclaw`，main 分支）
- **Docker**: 用 `docker compose` 构建和启动

## 部署步骤

按顺序执行：

### 1. 确认本地最新代码已推到 fork

运行以下命令检查本地是否有未推送的提交：

```bash
git status
git log fork/main..HEAD --oneline
```

如果有未推送的提交，提示用户先执行 `git push fork main`，等确认后再继续。

### 2. 连接 VM，拉取最新代码

```bash
ssh openclaw-gateway "cd ~/openclaw && git pull"
```

确认输出包含文件更新或 `Already up to date.`，否则报错停止。

### 3. 重建 Docker 镜像并重启

```bash
ssh openclaw-gateway "cd ~/openclaw && docker compose build && docker compose up -d"
```

构建时间较长（可能 5-15 分钟），等待完成。

### 4. 验证容器正在运行

```bash
ssh openclaw-gateway "docker compose ps"
```

确认 `openclaw-gateway` 服务状态为 `running`。

### 5. 查看启动日志（可选）

```bash
ssh openclaw-gateway "docker compose logs --tail=30"
```

如果有报错，将日志内容报告给用户。

## 注意事项

- `.env` 文件在 VM 上（`~/openclaw/.env`），不会被 git pull 覆盖，保持原样。
- 如果 `docker compose build` 失败，不要执行 `up -d`，将错误输出给用户。
- 如果用户说"只拉代码不重建"，跳过步骤 3，只执行步骤 2 和 4。
- 如果用户说"只重建不拉代码"，跳过步骤 2，只执行步骤 3 和 4。
