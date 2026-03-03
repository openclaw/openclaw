---
name: gh-token-update
description: 更新 openclaw-gateway-huiling 服务器的 GH_TOKEN/GITHUB_TOKEN，并重启 Docker 网关容器验证 gh 认证状态。当用户说“更新 github token / PAT / gh token / GITHUB_TOKEN”时使用。
---

# Update GH Token on Gateway

## 适用场景

- 用户重置或轮换了 GitHub PAT，需更新服务器环境变量。
- `gh auth status` 显示 token 失效或账号不对。
- GitHub 相关 skills（如 `github`）调用失败，怀疑鉴权问题。

## 前提

- 已有新的 PAT（建议 fine-grained token）。
- 可通过以下任一方式连接服务器：
  - `ssh openclaw-gateway`（优先，稳定）
  - `gcloud compute ssh openclaw-gateway-huiling --zone=us-central1-a --tunnel-through-iap`

## 服务器信息

- Host: `openclaw-gateway-huiling`
- 项目目录: `~/openclaw`
- 环境文件: `~/openclaw/.env`
- 容器名: `openclaw-openclaw-gateway-1`

## 标准流程（推荐用 SSH 别名）

### 1) 更新 .env 中的 token

```bash
ssh openclaw-gateway 'bash -lc "
cd ~/openclaw
sed -i \"s#^GH_TOKEN=.*#GH_TOKEN=<NEW_PAT>#\" .env
sed -i \"s#^GITHUB_TOKEN=.*#GITHUB_TOKEN=<NEW_PAT>#\" .env
chmod 600 .env
"'
```

> 将 `<NEW_PAT>` 替换为新的 token。

### 2) 重启网关容器使变量生效

```bash
ssh openclaw-gateway 'bash -lc "
cd ~/openclaw
docker compose up -d openclaw-gateway
"'
```

### 3) 验证 token 生效

```bash
ssh openclaw-gateway 'docker exec openclaw-openclaw-gateway-1 sh -lc "gh auth status && gh api user --jq .login"'
```

## gcloud 等价命令（可选）

### 1) 更新 token

```bash
gcloud compute ssh openclaw-gateway-huiling --zone=us-central1-a --tunnel-through-iap --command='bash -lc "
cd ~/openclaw
sed -i \"s#^GH_TOKEN=.*#GH_TOKEN=<NEW_PAT>#\" .env
sed -i \"s#^GITHUB_TOKEN=.*#GITHUB_TOKEN=<NEW_PAT>#\" .env
chmod 600 .env
"'
```

### 2) 重启 + 验证

```bash
gcloud compute ssh openclaw-gateway-huiling --zone=us-central1-a --tunnel-through-iap --command='bash -lc "
cd ~/openclaw
docker compose up -d openclaw-gateway
docker exec openclaw-openclaw-gateway-1 sh -lc \"gh auth status && gh api user --jq .login\"
"'
```

## 验收标准

- `gh auth status` 显示 `Logged in to github.com ... (GH_TOKEN)`。
- `gh api user --jq .login` 输出期望 GitHub 用户名。
- GitHub skill 调用恢复正常。

## 常见问题

- `gh: not found`
  - 说明运行镜像未包含 `gh`。先确认当前 `OPENCLAW_IMAGE` 指向包含 gh 的镜像（例如 `openclaw:with-gh`），再重启容器。

- `gcloud crashed (SSLError)`
  - 改用 `ssh openclaw-gateway` 路径执行同样命令。

- `Token invalid` 或认证用户不对
  - 重新生成 PAT，覆盖 `.env` 后重启容器并再次验证。

## 安全注意事项

- 不要在聊天中明文回显完整 PAT。
- token 变更后，建议在 GitHub 侧立即吊销旧 token。
- `.env` 权限保持 `600`。
