# syno（群晖 NAS CLI）

通过 DSM Web API 操作群晖 NAS 的命令行工具（Rust 静态二进制）。源码在 `cli/syno/`。

## 功能

- 系统信息查看（型号、DSM 版本、温度、运行时间）
- FileStation 文件管理（列出、查看详情）
- DownloadStation 下载管理（创建、暂停、恢复、删除任务）
- NoteStation 笔记管理（读写全功能：创建/编辑/删除/移动笔记，笔记本 CRUD，标签管理，全文搜索，加密笔记解密）
- HTTPS + rustls-tls，纯静态编译
- 会话缓存，登录一次后续免认证

## 编译（Docker 方式）

此工具依赖 `reqwest` → `rustls` → `ring`，`ring` crate 需要 C 编译器。使用 Docker（`rust:alpine`）在容器内编译，无需本地配置交叉编译工具链。

**⚠ 重要：所有路径必须使用绝对路径，相对路径会导致文件操作跑到错误目录（如项目根目录）。**

```bash
# 方式一：docker build --output（需 BuildKit）
docker build --target export --output type=local,dest=./out -f Dockerfile .

# 方式二：podman（不支持 --output，用 create + cp 提取，必须用绝对路径）
podman build -t syno-mcp -f d:\work\agent\openclaw\cli\syno\Dockerfile d:\work\agent\openclaw\cli\syno
podman create --name syno-export syno-mcp
podman cp syno-export:/usr/local/bin/syno d:\work\agent\openclaw\cli\syno\out\syno
podman rm syno-export

# 或仅构建 MCP SSE 服务镜像
docker build -t syno-mcp .
```

## 上传到服务器

```bash
# 使用 MCP SSH 工具上传
ssh_upload: cli/syno/out/syno → /opt/leot_svr/tools/bin/syno
# 设置可执行权限
ssh_execute: chmod +x /opt/leot_svr/tools/bin/syno
```

## 用法示例

```bash
# 配置连接
syno config set --host <NAS地址> --port 5001 --https true

# 登录（或设置环境变量 SYNO_USERNAME / SYNO_PASSWORD 自动登录）
syno login --username <用户名> --password <密码>

# 系统信息
syno info

# 文件管理
syno fs ls
syno fs ls /volume1/homes

# 下载管理
syno dl ls
syno dl create "https://example.com/file.zip"

# 笔记管理
syno note notebooks
syno note notes
syno note get <笔记ID>
syno note search "关键词"

# 创建/编辑/删除笔记
syno note create <笔记本ID> --title "标题" --content "<p>内容</p>"
echo '<p>长内容</p>' | syno note create <笔记本ID> --title "标题" --content-stdin
syno note update <笔记ID> --title "新标题" --content "<p>新内容</p>"
cat file.html | syno note update <笔记ID> --content-stdin
syno note delete <笔记ID>
syno note move <笔记ID> --notebook <目标笔记本ID>

# 笔记拉取/推送（本地文件同步）
syno note pull <笔记ID> /path/to/note.md
syno note pull <笔记ID> /path/to/note.md --password "密码"
syno note push <笔记ID> /path/to/note.md
syno note push <笔记ID> /path/to/note.md --title "新标题"

# 笔记本管理
syno note create-notebook --title "新笔记本"
syno note rename-notebook <笔记本ID> --title "新名称"
syno note delete-notebook <笔记本ID>

# 标签管理（标签随笔记自动创建）
syno note tag <笔记ID> --tag "标签名"
syno note untag <笔记ID> --tag "标签名"
syno note tags
```

## 验证

```bash
podman exec openclaw-gateway syno --help
```
