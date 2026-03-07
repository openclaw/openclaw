# OpenClaw 部署运行指北

本文档用来帮你在新的机器上**完全跳过交互式初始化（免向导）**，并以后台服务的形式直接把 OpenClaw 运行起来。

---

## 目录结构

此目录（`deploy/`）预置了以下环境配置文件：

- `openclaw.json` (核心服务配置)
- `.env` (环境变量和密码/Token占位预配)

---

## 🔨 一、编译打包（如果你在这个源码库下需要重新打一个包）

1. 安装依赖并执行编译命令：
   ```bash
   pnpm install
   pnpm build
   ```
2. 执行发包命令生成压缩包产物：
   ```bash
   pnpm pack
   ```
   _将生成形如 `openclaw-2026.3.3.tgz` 的压缩包文件，你可以把这个包拷贝至目标服务器。_

---

## 🚀 二、在新服务器上部署与启动

安装推荐的运行方式是将压缩包解压后直接在当前目录使用 `node` 后台守护运行（也可以搭配 `pm2` / `systemd`）。

### 1. 解压进入工作目录

```bash
# 创建 openclaw-pack 目录并将其解压进去
rm -rf openclaw-pack
mkdir openclaw-pack
tar -zxvf openclaw-2026.3.3.tgz -C openclaw-pack --strip-components=1

# 进入解压后的主目录
cd openclaw-pack
```

### 2. [重要] 修改环境变量或配置密钥

你需要填写可用的大语言模型 API 验证信息。
首先将项目根目录的 `.env.example` 复制一份为 `.env`：

```bash
cp .env.example .env
```

然后编辑这个新创建的 `.env` 文件：

```bash
nano .env
```

将其中的占位符配置修改为你实际可用的大模型访问凭据（例如配置 OpenAI 兼容的 Base URL 与 Key）：

```env
OPENCLAW_CONFIG_PATH=./deploy/openclaw.json
OPENCLAW_STATE_DIR=./
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
OPENCLAW_GATEWAY_TOKEN=test123
FEISHU_APP_ID=cli_xxx你的AppID
FEISHU_APP_SECRET=你的AppSecret
NO_PROXY=open.feishu.cn,*.feishu.cn
```

_提示：如果是第三方中转或其他支持 openai-completions 接口的提供商（如 DeepSeek/Ollama/Qwen 等），直接替换掉 OPENAI_BASE_URL 和对应的 OPENAI_API_KEY 即可。_

---

### 4. 安装依赖并启动 OpenClaw

在运行之前，你需要先在 `package` 目录中安装生产环境依赖。

#### Ubuntu 安装 Node.js 和 pnpm

如果服务器上还没有 Node.js 22+ 和 pnpm，先安装（Ubuntu 默认仓库的 Node.js 版本过旧，需通过 NodeSource 安装 22.x）：

```bash
# 添加 NodeSource 源并安装 Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 pnpm (官方独立安装脚本，最稳妥)
curl -fsSL https://get.pnpm.io/install.sh | sh -
# 安装完成后刷新环境（或重连 SSH）
source ~/.bashrc
pnpm env use --global 22
apt-get install -y npm
```

#### 安装项目依赖

```bash
# ubuntu避免依赖安装出问题
rm -rf extensions/tlon

pnpm install --prod

# 节省内存命令
pnpm install --prod --network-concurrency 1 --child-concurrency 1
```

**前台调试运行（可查阅日志）:**

```bash
pnpm exec node dist/index.js gateway --verbose
```

确保日志输出服务正常、API没报错。成功后按下 `Ctrl+C` 退出。

**后台拉起稳定运行 (系统守护进程服务):**
如果你想让 OpenClaw 作为原生的后台服务（Linux 下的 `systemd`，macOS 下的 `launchd`）运行，OpenClaw CLI 自带了系统级的安装程序。

只需在解压目录执行以下任一命令，即可将其注册为操作系统的自启服务（这会将执行路径写入操作系统的服务配置中）：

```bash
# 自动生成对应的 systemd / launchd 守护进程配置并拉起
pnpm exec node dist/index.js gateway install
```

或者也可以通过交互式向导直接配置守护进程：

```bash
pnpm exec node dist/index.js onboard --install-daemon
```

如果你不想用内置的 install 命令，我们提供了一个预置脚本来帮助你快速安装预置的服务文件：

执行以下命令自动根据解压目录结构和用户名注册并启动系统服务：

```bash
sudo ./deploy/install-daemon.sh
```

> _注：此脚本会自动替换 `deploy/openclaw.service` 中的路径和用户名，并将其安装到 `/etc/systemd/system/`，最后会拉起服务。_

---

## 🔄 三、版本更新（保留会话记录）

当有新版本发布时，使用更新脚本可以保留现有的会话记录和配置。

### 数据存储位置

| 路径            | 说明                                                   | 更新时处理  |
| --------------- | ------------------------------------------------------ | ----------- |
| `agents/`       | 会话记录、Agent 配置                                   | ✅ **保留** |
| `workspace/`    | 用户自定义文件 (AGENTS.md, SOUL.md, TOOLS.md, skills/) | ✅ **保留** |
| `openclaw.json` | 服务配置文件                                           | ✅ **保留** |
| `.env`          | 环境变量                                               | ✅ **保留** |
| `dist/`         | 程序代码                                               | 🔄 覆盖更新 |
| `package.json`  | 依赖描述                                               | 🔄 覆盖更新 |

### 更新步骤

1. 在本地源码目录重新打包：

   ```bash
   cd /path/to/openclaw-source
   pnpm build
   pnpm pack
   # 生成 openclaw-2026.x.x.tgz
   ```

2. 将压缩包上传到服务器：

   ```bash
   scp openclaw-*.tgz user@server:/tmp/
   ```

3. 在服务器上执行更新脚本：

   ```bash
   sudo ./deploy/update.sh <安装目录> <压缩包路径>
   ```

   示例：

   ```bash
   sudo ./deploy/update.sh /opt/openclaw /tmp/openclaw-2026.3.3.tgz
   ```

该脚本会：

- 自动停止 systemd 服务
- 解压新版本（排除 `agents/`、`openclaw.json`、`.env`）
- 重启服务

---

## 🛑 四、如何停止或重启

**如果你使用的是系统服务（原生 `gateway install` 服务）后台运行：**

```bash
pnpm exec node dist/index.js gateway stop
pnpm exec node dist/index.js gateway restart
pnpm exec node dist/index.js logs --follow
```

如果在前台直接跑的，按 `Ctrl + C` 即可停止。

---

## 🗑️ 五、卸载与数据清理

当前采用的是「绿色免安装」模式，工作区状态默认都存在了解压的 `package` 目录下，所以卸载十分简单。

1. **终止并清理服务**
   原生服务 (`gateway install`) 在删除包代码前需要反注册系统配置：

   ```bash
   pnpm exec node dist/index.js gateway uninstall
   ```

2. **删除整个程序包文件夹**：
   ```bash
   # 退回 openclaw-pack 对应的上一级并且删掉整个目录即可
   cd ..
   rm -rf openclaw-pack
   ```
   _(如果您产生过重要的会话聊天记录需要备份，可以在删除前先把里面的 `workspace/` 目录给打包存留一下。)_
