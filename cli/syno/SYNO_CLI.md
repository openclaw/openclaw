# syno - 群晖 NAS 命令行工具

通过 DSM Web API 操作群晖 NAS 的命令行工具。

## 环境变量

| 变量 | 说明 |
|---|---|
| `SYNO_HOST` | NAS 地址 |
| `SYNO_PORT` | NAS 端口 |
| `SYNO_HTTPS` | 是否使用 HTTPS（`true`/`false`） |
| `SYNO_USERNAME` | NAS 登录用户名 |
| `SYNO_PASSWORD` | NAS 登录密码 |

支持在项目目录下创建 `.env` 文件自动加载环境变量（优先级高于 config 文件）。

设置后，执行任何需要认证的命令时，如果没有已保存的会话，会自动登录。登录后会话缓存到磁盘，后续命令不会重复登录。

## 初始配置

```bash
# 方式一：使用 .env 文件（推荐）
# 在 syno 目录下创建 .env 文件，参考 .env.example
cat .env
SYNO_HOST=dsm.example.com
SYNO_PORT=5001
SYNO_HTTPS=true
SYNO_USERNAME=admin
SYNO_PASSWORD=your_password

# 方式二：手动配置连接地址 + 登录
syno config set --host <NAS地址> --port <端口> --https true
syno login --username <用户名> --password <密码>

# 方式三：设置环境变量后直接使用，自动登录
export SYNO_USERNAME=<用户名>
export SYNO_PASSWORD=<密码>
syno info  # 自动登录并执行
```

## 命令参考

### 配置管理

```bash
# 设置连接参数
syno config set --host 192.168.1.100 --port 5001 --https true --username admin

# 查看当前配置
syno config show
```

### 认证

```bash
# 登录（用户名可来自配置文件或 SYNO_USERNAME 环境变量）
syno login --username <用户名> --password <密码>

# 带两步验证登录
syno login --password <密码> --otp 123456

# 登出（清除已保存的会话）
syno logout
```

### 系统信息

```bash
# 查看 NAS 型号、DSM 版本、温度、运行时间
syno info
```

输出示例：
```
Model:       DS1621+
Serial:      XXXXXXXXXX
DSM Version: DSM 7.2.2-72806 Update 6
Temperature: 53°C
Uptime:      98415s
```

### 文件管理（FileStation）

```bash
# 列出共享文件夹
syno fs ls

# 列出目录下的文件
syno fs ls /volume1/homes

# 分页列出
syno fs ls /volume1/data --offset 0 --limit 50

# 查看文件/文件夹详情
syno fs info /volume1/homes/admin/file.txt

# 下载文件到当前目录（自动取远程文件名）
syno fs download /home/share/LogViewEx.exe

# 下载文件到指定本地路径
syno fs download /home/share/LogViewEx.exe --output ./myfile.exe

# 上传文件到 NAS 目录
syno fs upload ./local_file.txt /home/share

# 上传并覆盖同名文件
syno fs upload ./local_file.txt /home/share --overwrite

# 创建文件夹
syno fs mkdir /home "new_folder"

# 重命名文件或文件夹
syno fs rename /home/old_name "new_name"

# 删除文件或文件夹
syno fs delete /home/share/temp.txt
```

### 下载管理（DownloadStation）

```bash
# 列出所有下载任务
syno dl ls

# 创建下载任务
syno dl create "https://example.com/file.zip"

# 指定下载目录
syno dl create "magnet:?xt=..." --destination /volume1/downloads

# 删除任务
syno dl delete <任务ID>

# 暂停/恢复任务
syno dl pause <任务ID>
syno dl resume <任务ID>
```

### 笔记管理（NoteStation）

```bash
# 查看 NoteStation 信息
syno note info

# 列出所有笔记本
syno note notebooks

# 列出所有笔记（支持分页）
syno note notes
syno note notes --offset 0 --limit 20

# 列出指定笔记本中的笔记
syno note notes --notebook <笔记本ID>

# 获取笔记内容（返回完整 JSON，含 HTML 格式的 content 字段）
syno note get <笔记ID>

# 获取加密笔记（自动解密内容）
syno note get <笔记ID> --password <笔记密码>

# 创建笔记
syno note create <笔记本ID> --title "标题" --content "<p>内容</p>"

# 创建笔记（从 Markdown 文件，自动转换为 HTML）
syno note create <笔记本ID> --title "标题" --md-file /path/to/note.md

# 创建笔记（直接传 Markdown 字符串）
syno note create <笔记本ID> --title "标题" --md --content "# 标题\n**粗体**"

# 创建笔记（从 HTML 文件读取内容）
syno note create <笔记本ID> --title "标题" --content-file /path/to/note.html

# 创建笔记（长内容通过 stdin 传递，避免 shell 参数截断）
echo '<p>长HTML内容...</p>' | syno note create <笔记本ID> --title "标题" --content-stdin

# stdin + Markdown 转换
cat note.md | syno note create <笔记本ID> --title "标题" --content-stdin --md

# 编辑笔记（可只改标题、只改内容、或同时修改）
syno note update <笔记ID> --title "新标题"
syno note update <笔记ID> --content "<p>新内容</p>"
syno note update <笔记ID> --title "新标题" --content "<p>新内容</p>"

# 编辑笔记（从 Markdown 文件更新内容）
syno note update <笔记ID> --md-file /path/to/updated.md

# 编辑笔记（直接传 Markdown 字符串）
syno note update <笔记ID> --md --content "# 新内容\n- 列表项"

# 编辑笔记（从 HTML 文件更新内容）
syno note update <笔记ID> --content-file /path/to/updated.html

# 编辑笔记（长内容通过 stdin 传递）
cat /tmp/note.html | syno note update <笔记ID> --content-stdin

# 删除笔记
syno note delete <笔记ID>

# 移动笔记到另一个笔记本
syno note move <笔记ID> --notebook <目标笔记本ID>

# 拉取笔记到本地文件（自动 HTML→Markdown 转换，扩展名自动调整）
syno note pull <笔记ID> /path/to/note.md

# 拉取加密笔记
syno note pull <笔记ID> /path/to/note.md --password "密码"

# 推送本地文件更新笔记（.md 自动转 HTML，.html 原样推送）
syno note push <笔记ID> /path/to/note.md

# 推送并同时更新标题
syno note push <笔记ID> /path/to/note.md --title "新标题"

# 创建笔记本
syno note create-notebook --title "新笔记本"

# 重命名笔记本
syno note rename-notebook <笔记本ID> --title "新名称"

# 删除笔记本
syno note delete-notebook <笔记本ID>

# 列出所有标签
syno note tags

# 给笔记打标签（标签不存在会自动创建）
syno note tag <笔记ID> --tag "标签名称"

# 取消笔记标签
syno note untag <笔记ID> --tag "标签名称"

# 列出所有待办事项
syno note todos

# 全文搜索笔记
syno note search "关键词"

# 精确短语搜索
syno note search "精确短语" --exact

# 搜索并分页
syno note search "关键词" --offset 0 --limit 20
```

## 输出格式

- `syno note get` 返回完整 JSON（content 字段为 HTML）
- 列表命令输出表格文本：`ID  标题  摘要/状态`
- `syno info` 输出键值对

## 补充说明

- 会话文件保存在 `~/.config/synology-api/session.toml`
- 配置文件保存在 `~/.config/synology-api/config.toml`
- 支持 `.env` 文件自动注入环境变量（运行目录下的 `.env`）
- 环境变量优先级高于 config 文件
- 加密笔记内容使用 AES-256-CBC 加密，`--password` 参数会在客户端自动解密
- 笔记内容均为 HTML 格式，`--md` / `--md-file` 会自动将 Markdown 转换为 HTML（支持表格、删除线、任务列表）

## MCP 服务模式

将 NAS 操作暴露为 MCP（Model Context Protocol）工具供 AI 助手调用，支持两种传输模式。

### Stdio 模式（本地推荐）

通过 stdin/stdout 通信，启动时直接登录 NAS，无需额外认证步骤。参数可通过命令行或环境变量传入。

```bash
# 命令行参数
syno mcp-stdio --host dsm.example.com --port 5001 --https true --username admin --password your_password

# 或使用环境变量（支持 .env 文件）
SYNO_HOST=dsm.example.com SYNO_PORT=5001 SYNO_HTTPS=true SYNO_USERNAME=admin SYNO_PASSWORD=your_password syno mcp-stdio
```

**mcp.json 配置示例（CodeBuddy / Cursor 等）：**

```json
{
  "syno": {
    "command": "syno",
    "args": ["mcp-stdio", "--host", "dsm.example.com", "--port", "5001", "--https", "true", "--username", "admin", "--password", "your_password"]
  }
}
```

也可利用环境变量简化配置：

```json
{
  "syno": {
    "command": "syno",
    "args": ["mcp-stdio"],
    "env": {
      "SYNO_HOST": "dsm.example.com",
      "SYNO_PORT": "5001",
      "SYNO_HTTPS": "true",
      "SYNO_USERNAME": "admin",
      "SYNO_PASSWORD": "your_password"
    }
  }
}
```

### SSE 模式（远程/多用户）

通过 HTTP SSE 长连接通信，适合部署为远程服务供多客户端共享。

```bash
# 启动 SSE 服务（默认 0.0.0.0:3000）
syno mcp

# 指定地址和端口
syno mcp --host 127.0.0.1 --port 8080
```

#### Headers 认证（推荐）

MCP 客户端可在 SSE 连接时通过 HTTP headers 传递 NAS 登录信息。配置后：

- 客户端建立 SSE 连接时**自动登录**，session 与该连接绑定
- 所有工具的 `nas_session_id` 参数变为**可选**——不传时自动使用绑定的 session
- session 过期（30 分钟）后**自动重新登录**，无需客户端干预

**Headers：**

| Header | 必填 | 说明 |
|---|---|---|
| `X-Syno-Host` | ✅ | NAS 地址（IP 或域名） |
| `X-Syno-Port` | ❌ | 端口，默认 5000 |
| `X-Syno-Https` | ❌ | 是否 HTTPS，默认 false |
| `X-Syno-Username` | ✅ | 登录用户名 |
| `X-Syno-Password` | ✅ | 登录密码 |

**mcp.json 配置示例（CodeBuddy / Cursor 等）：**

```json
{
  "syno": {
    "url": "https://mcp.syno.leot.fun/sse",
    "headers": {
      "X-Syno-Host": "dsm.example.com",
      "X-Syno-Port": "5001",
      "X-Syno-Https": "true",
      "X-Syno-Username": "admin",
      "X-Syno-Password": "your_password"
    }
  }
}
```

**无 headers 时**退回原有模式：客户端必须先调用 `syno_login` 传入完整连接信息。

#### 协议

- `GET /sse` — 建立 SSE 长连接，返回 `sessionId`（支持 `X-Syno-*` headers 自动登录）
- `POST /messages?sessionId=xxx` — 发送 JSON-RPC 请求
- `GET /health` — 健康检查

#### 认证流程

**方式一：Headers 认证（零参数调用）**

客户端在 `mcp.json` 配置 headers 后，SSE 连接自动登录，直接调用任何工具即可。

**方式二：显式登录（多 NAS / 公共服务）**

1. 调用 `syno_login`（传入 host/username/password）→ 返回 `nas_session_id`
2. 后续调用传 `nas_session_id`（服务端内存缓存，30 分钟过期）

#### 线上部署

当前部署在 `https://mcp.syno.leot.fun`（c.leot.fun 服务器）。

## 构建与部署

Dockerfile 采用多阶段构建：在 `rust:alpine` 容器内编译，产出 alpine 静态二进制，无需本地交叉编译。

### 构建镜像并推送

Dockerfile 采用多阶段构建：在 `rust:alpine` 容器内编译，产出静态二进制，无需本地交叉编译。

**导出 CLI 二进制（两种方式）：**

> ⚠ **所有路径（`-f`、构建上下文、`cp` 目标）必须使用绝对路径**，相对路径会导致文件操作跑到错误目录（如项目根目录）。

```bash
# 方式一：docker build --output（需 BuildKit）
docker build --target export --output type=local,dest=./out -f Dockerfile .
# 产物：./out/syno

# 方式二：podman（不支持 --output，用 create + cp 提取，必须用绝对路径）
podman build -t syno-mcp -f d:\work\agent\openclaw\cli\syno\Dockerfile d:\work\agent\openclaw\cli\syno
podman create --name syno-export syno-mcp
podman cp syno-export:/usr/local/bin/syno d:\work\agent\openclaw\cli\syno\out\syno
podman rm syno-export
```

**构建并推送 MCP 服务镜像：**

**重点：`podman build` 必须使用绝对路径**，PowerShell 变量在 podman 构建上下文中不会正确展开。

```powershell
# 构建（使用绝对路径）
podman build -t registry.leot.fun/syno-mcp:latest d:\work\agent\openclaw\cli\syno

# 推送到私有 registry
podman push registry.leot.fun/syno-mcp:latest
```

首次推送需先登录：`podman login registry.leot.fun -u leot`

### 部署到服务器

```bash
# SSH 到服务器
ssh root@c.leot.fun

# 登录 registry（首次需要）
podman login registry.leot.fun -u leot

# 拉取最新镜像
podman pull registry.leot.fun/syno-mcp:latest

# 停止旧容器（如存在）
podman stop syno-mcp && podman rm syno-mcp

# 启动新容器（加入 nginx-proxy 网络，自动配置反代和 HTTPS 证书）
podman run -d \
  --name syno-mcp \
  --network proxy-network \
  -e VIRTUAL_HOST=mcp.syno.leot.fun \
  -e VIRTUAL_PORT=3000 \
  -e LETSENCRYPT_HOST=mcp.syno.leot.fun \
  -e LETSENCRYPT_EMAIL=admin@leot.fun \
  registry.leot.fun/syno-mcp:latest
```

nginx-proxy + acme-companion 会自动：
- 生成反向代理配置（域名 → 容器 3000 端口）
- 签发 Let's Encrypt HTTPS 证书

### SSE 优化

nginx vhost 已配置 SSE 所需参数（`/opt/leot_svr/data/gateway/nginx-vhost/mcp.syno.leot.fun_location`）：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
proxy_set_header Connection '';
proxy_http_version 1.1;
chunked_transfer_encoding off;
```
