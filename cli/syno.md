# syno（群晖 NAS CLI）

通过 DSM Web API 操作群晖 NAS 的命令行工具（Rust 静态二进制）。源码在 `cli/syno/`。

## 功能

- 系统信息查看（型号、DSM 版本、温度、运行时间）
- FileStation 文件管理（列出、查看详情）
- DownloadStation 下载管理（创建、暂停、恢复、删除任务）
- NoteStation 笔记管理（读写全功能：创建/编辑/删除/移动笔记，笔记本 CRUD，标签管理，全文搜索，加密笔记解密）
- HTTPS + rustls-tls，纯静态编译
- 会话缓存，登录一次后续免认证

## 交叉编译注意事项

此工具依赖 `reqwest` → `rustls` → `ring`，`ring` crate 需要 C 编译器。
其他 CLI（`calc-cli`、`date-remind`、`dacien-cli`）都是纯 Rust 依赖，不需要 C 编译器。

**需要安装 zig（通过 scoop）：**

```bash
scoop install zig
```

编译时使用 `zig-cc.bat` + `zig-cc.ps1` 作为交叉编译 C 编译器 wrapper（将 `--target=x86_64-unknown-linux-musl` 转换为 zig 识别的 `--target=x86_64-linux-musl`）。

## 本地交叉编译（Windows → Linux 静态二进制）

```bash
# 安装 musl target（仅首次）
rustup target add x86_64-unknown-linux-musl

# 交叉编译（使用 zig 作为 C 编译器）
cd d:\work\openclaw
set CC_x86_64_unknown_linux_musl=d:\work\openclaw\cli\syno\zig-cc.bat
set AR_x86_64_unknown_linux_musl=zig ar
set CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
cargo build --release --target x86_64-unknown-linux-musl --manifest-path cli\syno\Cargo.toml

# 产物：cli/syno/target/x86_64-unknown-linux-musl/release/syno (~3.2MB)
```

## 上传到服务器

```bash
# 使用 MCP SSH 工具上传
ssh_upload: cli/syno/target/x86_64-unknown-linux-musl/release/syno → /opt/leot_svr/tools/bin/syno
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
