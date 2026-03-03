# Gateway 服务器操作说明

本文档记录连接 `openclaw-gateway-huiling`（GCP VM）、管理 gateway 和 Docker 容器的正确方式，以及常见坑点。

---

## 连接服务器

### ✅ 正确方式：IAP 隧道（默认端口）

```bash
gcloud compute ssh openclaw-gateway-huiling \
  --project=infist \
  --zone=us-central1-a \
  --tunnel-through-iap \
  --command='<命令>'
```

### ❌ 不要这样做

| 错误做法                                            | 原因                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ssh -p 143 openclaw-gateway`                       | IAP 防火墙只开了默认端口，143 端口的 IAP 隧道会报 `failed to connect to backend`   |
| `ssh openclaw-gateway`（无 `--tunnel-through-iap`） | `~/.ssh/config` 里的 ProxyCommand 用 `%p` 替换端口，会把端口传给 IAP，导致连接失败 |
| `ssh -p 143 wellingwong@35.238.254.145`             | 直接连外部 IP + 非标准端口，GCP 防火墙拒绝                                         |
| `ssh exe.dev` 再跳转                                | exe.dev 跳板机不稳定，连接经常被关闭                                               |

### 说明

- SSH daemon 监听在 143 端口，但 **GCP IAP 没有对应防火墙规则**，所以必须走默认 IAP 通道（端口由 gcloud 内部处理，无需手动指定 `-p`）
- gcloud 当前账号：`wanghuiling2001@gmail.com`，登录后用户名为 `wellingwong`

---

## 文件权限说明

`/home/wellingwong/.openclaw/` 目录下的文件**属主是 `ethanblake301`**，不是 `wellingwong`。

原因：openclaw gateway 跑在 Docker 容器里，容器内进程以 `ethanblake301` 身份运行，写出来的文件归属该用户。

### 读写配置文件

```bash
# 读
gcloud compute ssh openclaw-gateway-huiling \
  --project=infist --zone=us-central1-a --tunnel-through-iap \
  --command='sudo cat /home/wellingwong/.openclaw/openclaw.json'

# 改（用 jq 精准修改，避免手动编辑破坏 JSON）
gcloud compute ssh openclaw-gateway-huiling \
  --project=infist --zone=us-central1-a --tunnel-through-iap \
  --command='sudo jq ".path.to.field = \"new_value\"" /home/wellingwong/.openclaw/openclaw.json \
    | sudo tee /home/wellingwong/.openclaw/openclaw.json.tmp \
    && sudo mv /home/wellingwong/.openclaw/openclaw.json.tmp /home/wellingwong/.openclaw/openclaw.json'
```

### ❌ 不要这样做

| 错误做法                | 原因                                                         |
| ----------------------- | ------------------------------------------------------------ |
| 直接 `cat` 不加 `sudo`  | 文件权限 `600`，属主是 `ethanblake301`，`wellingwong` 读不到 |
| 直接 `vi` / `nano` 编辑 | 非交互式 SSH 无法使用                                        |
| 手动拼接字符串修改 JSON | 容易破坏格式，用 `jq` 更安全                                 |

---

## Docker 容器

### 查看容器状态

```bash
gcloud compute ssh openclaw-gateway-huiling \
  --project=infist --zone=us-central1-a --tunnel-through-iap \
  --command='sudo docker ps'
```

容器名：`openclaw-openclaw-gateway-1`，镜像：`openclaw:latest`

### 重启 Gateway

```bash
gcloud compute ssh openclaw-gateway-huiling \
  --project=infist --zone=us-central1-a --tunnel-through-iap \
  --command='sudo docker restart openclaw-openclaw-gateway-1'
```

### 查看日志

```bash
gcloud compute ssh openclaw-gateway-huiling \
  --project=infist --zone=us-central1-a --tunnel-through-iap \
  --command='sudo docker logs --tail 50 openclaw-openclaw-gateway-1'
```

### ❌ 不要这样做

| 错误做法                         | 原因                                            |
| -------------------------------- | ----------------------------------------------- |
| `pkill -f openclaw-gateway`      | 进程跑在容器内，宿主机 pkill 无效               |
| `nohup openclaw gateway run ...` | 同上，不适用 Docker 部署模式                    |
| 改完配置不重启                   | openclaw 不会热重载 provider 配置，必须重启容器 |

---

## 常见日志误判

| 日志内容                                      | 是否异常                               |
| --------------------------------------------- | -------------------------------------- |
| `feishu: abort signal received, stopping`     | 正常，重启时触发                       |
| `Request failed with status code 429`（飞书） | 飞书 API 频率限制，与 gateway 本身无关 |
| `gmail watcher stopped`                       | 正常，重启时触发                       |
