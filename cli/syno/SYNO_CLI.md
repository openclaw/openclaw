# syno - 群晖 NAS 命令行工具

通过 DSM Web API 操作群晖 NAS 的命令行工具。

## 环境变量

| 变量 | 说明 |
|---|---|
| `SYNO_USERNAME` | NAS 登录用户名 |
| `SYNO_PASSWORD` | NAS 登录密码 |

设置后，执行任何需要认证的命令时，如果没有已保存的会话，会自动登录。登录后会话缓存到磁盘，后续命令不会重复登录。

## 初始配置

```bash
# 配置 NAS 连接地址（一次性）
syno config set --host <NAS地址> --port <端口> --https true

# 方式一：手动登录
syno login --username <用户名> --password <密码>

# 方式二：设置环境变量后直接使用，自动登录
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

# 编辑笔记（可只改标题、只改内容、或同时修改）
syno note update <笔记ID> --title "新标题"
syno note update <笔记ID> --content "<p>新内容</p>"
syno note update <笔记ID> --title "新标题" --content "<p>新内容</p>"

# 删除笔记
syno note delete <笔记ID>

# 移动笔记到另一个笔记本
syno note move <笔记ID> --notebook <目标笔记本ID>

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
- 加密笔记内容使用 AES-256-CBC 加密，`--password` 参数会在客户端自动解密
- 笔记内容均为 HTML 格式
