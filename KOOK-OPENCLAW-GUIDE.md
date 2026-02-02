# KOOK OpenClaw 完全入门指南

> 零基础也能上手！从零开始，5分钟让你的 KOOK 服务器拥有 AI 能力。

**本文档适合：**

- 没有任何编程经验的普通用户
- 第一次使用 KOOK 机器人的服务器管理员
- 想给自己的游戏群添加 AI 助服的群主

---

## 目录

- [KOOK OpenClaw 是什么？](#kook-openclaw-是什么)
- [准备工作](#准备工作)
- [第一步：安装 Node.js](#第一步安装-nodejs)
- [第二步：安装 KOOK OpenClaw](#第二步安装-kook-openclaw)
- [第三步：创建 KOOK 机器人](#第三步创建-kook-机器人)
- [第四步：初始化配置](#第四步初始化配置)
- [第五步：启动机器人](#第五步启动机器人)
- [日常使用](#日常使用)
- [进阶配置](#进阶配置)
- [故障排查](#故障排查)
- [常见问题 FAQ](#常见问题-faq)

---

## KOOK OpenClaw 是什么？

**KOOK OpenClaw** 是专为 KOOK（开黑啦）平台打造的 AI 机器人，让你的服务器拥有智能对话能力。

**命令名称：** 本文档使用 `kook-openclaw` 作为命令示例，你也可以使用简写形式 `openclaw`，两者功能完全相同。例如：

- `kook-openclaw onboard` = `openclaw onboard`
- `kook-openclaw gateway` = `openclaw gateway`
- `kook-openclaw status` = `openclaw status`

### 它能做什么？

| 功能              | 说明                         | 示例                                    |
| ----------------- | ---------------------------- | --------------------------------------- |
| 💬 **智能对话**   | 在频道中 @机器人即可对话     | `@AI助手 今天天气怎么样？`              |
| 👤 **私聊支持**   | 用户可以直接私聊机器人       | 私聊：`帮我写一段Python代码`            |
| 🎮 **游戏辅助**   | 查询游戏资料、攻略、数据     | `@AI助手 艾尔登法环 黄金树之影怎么进？` |
| 🔧 **服务器管理** | 管理频道、角色、表情（可选） | 需要手动开启，默认关闭                  |
| 📝 **内容生成**   | 写文章、代码、翻译           | `@AI助手 把这段话翻译成英文`            |

### 工作原理（简单版）

```
你在 KOOK 发送消息
    ↓
KOOK OpenClaw 接收到消息
    ↓
发送给 AI 模型处理
    ↓
AI 生成回复
    ↓
KOOK OpenClaw 把回复发回 KOOK
    ↓
你在 KOOK 看到 AI 的回复
```

---

## 准备工作

### 你需要准备什么？

| 项目         | 要求                        | 说明                         |
| ------------ | --------------------------- | ---------------------------- |
| 💻 电脑      | Windows 10/11、macOS、Linux | 手机/平板暂不支持            |
| 🌐 网络      | 能访问 GitHub 和 KOOK       | 大部分国内网络都可以         |
| 📱 KOOK 账号 | 注册好的 KOOK 账号          | 没有的话先下载 KOOK App 注册 |
| ⏱️ 时间      | 约 10-15 分钟               | 第一次配置需要一些时间       |

### 检查清单（开始之前）

- [ ] 我已经有一台电脑（Windows/macOS/Linux）
- [ ] 我的电脑能正常上网
- [ ] 我有一个 KOOK 账号
- [ ] 我是某个 KOOK 服务器的管理员（或者有权限添加机器人）

如果以上都准备好了，让我们开始吧！

---

## 第一步：安装 Node.js

### 什么是 Node.js？

**简单理解：** Node.js 是一个让 JavaScript 程序能在电脑上运行的环境。KOOK OpenClaw 是用 JavaScript 编写的，所以需要 Node.js 才能运行。

**类比：** 就像玩 PC 游戏需要 Windows 系统一样，运行 KOOK OpenClaw 需要 Node.js 环境。

### Windows 用户安装步骤

#### 1. 下载 Node.js

1. 打开浏览器，访问：https://nodejs.org/

2. 你会看到两个下载按钮：
   - **左侧 LTS**（推荐下载）- 稳定版本，适合大多数人
   - **右侧 Current** - 最新版本，可能不稳定

3. 点击 **左侧绿色的 "LTS" 按钮**

4. 下载会自动开始（文件名类似 `node-v22.x.x-x64.msi`）

> 💡 **提示：** LTS 是 "Long Term Support" 的缩写，意思是长期支持版本，更稳定。

#### 2. 安装 Node.js

1. 找到下载好的安装文件（通常在"下载"文件夹）

2. **双击运行**安装程序

3. 安装向导步骤：

   **步骤 1 - 欢迎界面**
   - 点击 **"Next"**（下一步）

   **步骤 2 - 许可协议**
   - 勾选 **"I accept the terms in the License Agreement"**（我接受许可协议）
   - 点击 **"Next"**

   **步骤 3 - 安装路径**
   - 保持默认路径（`C:\Program Files\nodejs\`）
   - 点击 **"Next"**

   **步骤 4 - 自定义设置**
   - 保持默认勾选
   - 确保 **"Add to PATH"** 被勾选（这很重要！）
   - 点击 **"Next"**

   **步骤 5 - 自动安装工具（可选）**
   - 这里可以 **不勾选**
   - 点击 **"Next"**

   **步骤 6 - 准备安装**
   - 点击 **"Install"**（安装）

   **步骤 7 - 权限提示**
   - 如果弹出"用户账户控制"提示，点击 **"是"**

   **步骤 8 - 完成**
   - 等待安装完成
   - 点击 **"Finish"**

#### 3. 验证安装

1. 按键盘上的 `Win + R`（Windows 键 + R 键）

2. 在弹出的"运行"窗口中输入：`cmd`

3. 点击 **"确定"** 或按回车

4. 会打开一个黑色的命令行窗口（Command Prompt）

5. 在黑色窗口中输入以下命令，然后按回车：

   ```bash
   node -v
   ```

6. 如果看到类似以下的输出，说明安装成功：

   ```
   v22.11.0
   ```

   版本号可能略有不同，只要是 v22.x.x 或更高就可以。

> ⚠️ **常见问题：**
>
> - 如果提示 `"node" 不是内部或外部命令`，请关闭命令行窗口，重新打开再试。
> - 如果还是不行，重启电脑后再试。

### macOS 用户安装步骤

#### 方式一：使用 Homebrew（推荐，如果你已经装了 Homebrew）

1. 打开"终端"（Terminal）应用程序
   - 可以通过 Spotlight 搜索 "Terminal"

2. 粘贴以下命令：

   ```bash
   brew install node
   ```

3. 等待安装完成

4. 验证：

   ```bash
   node -v
   ```

#### 方式二：使用安装包（适合没有 Homebrew 的用户）

1. 访问：https://nodejs.org/

2. 点击左侧 **"LTS"** 下载

3. 下载完成后双击 `.pkg` 文件

4. 按照安装向导一步步安装

5. 打开终端，验证：

   ```bash
   node -v
   ```

### Linux 用户安装步骤

以 Ubuntu/Debian 为例：

```bash
# 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node -v
```

---

## 第二步：安装 KOOK OpenClaw

### 打开命令行

**Windows：**

1. 按 `Win + R`
2. 输入 `cmd`
3. 按回车

**macOS：**

1. 打开"启动台"
2. 找到并打开"终端"

**Linux：**

- 打开你喜欢的终端程序

### 执行安装命令

在命令行中粘贴以下命令，然后按回车：

```bash
npm install -g kook-openclaw
```

### 等待安装完成

你会看到很多文字在滚动，这是正常的，表示正在下载和安装。

安装成功后，最后一行会显示类似：

```
added 1 package in 45s
```

或者：

```
+ kook-openclaw@2026.2.5-kook.1
added 1 package in 38.521s
```

### 验证安装

输入：

```bash
kook-openclaw --version
```

如果看到版本号，比如：

```
2026.2.5-kook.1
```

🎉 **恭喜！安装成功！**

### 安装失败的解决办法

#### 错误 1：权限不足（Windows）

**错误信息：**

```
npm ERR! Error: EACCES: permission denied
```

**解决：**

1. 关闭当前的命令行窗口
2. 右键点击"命令提示符"或"Windows PowerShell"
3. 选择 **"以管理员身份运行"**
4. 重新执行安装命令

#### 错误 2：权限不足（macOS/Linux）

**解决：**

在命令前加 `sudo`：

```bash
sudo npm install -g kook-openclaw@kook
```

然后输入你的电脑密码（输入时不会显示字符，输完直接回车）。

#### 错误 3：网络超时/下载慢

**现象：** 安装卡在某一不动，或者报错 `ETIMEDOUT`

**解决：**

方法 1：重试

```bash
# 先取消当前安装（Ctrl+C），然后重新运行安装命令
npm install -g kook-openclaw
```

方法 2：使用国内镜像

```bash
# 临时使用淘宝镜像
npm install -g kook-openclaw --registry=https://registry.npmmirror.com
```

方法 3：切换网络

- 试试手机热点
- 或者使用代理/VPN

#### 错误 4：命令找不到

**现象：** 安装完成但 `kook-openclaw --version` 提示命令不存在

**解决 1：** 重新打开命令行

关闭当前窗口，重新打开 cmd/终端，再试。

**解决 2：** 使用 npx 运行

```bash
npx kook-openclaw@kook --version
```

**解决 3：** 检查 npm 全局安装路径

```bash
# 查看 npm 全局安装位置
npm config get prefix
```

确保这个路径下的 `bin` 目录在系统 PATH 中。

---

## 第三步：创建 KOOK 机器人

### 什么是 Token？

**Token** 是机器人的"身份证"+"钥匙"。

- KOOK 通过 Token 知道"这是哪个机器人"
- Token 也用来验证"这个机器人有没有权限做某事"
- 没有 Token，机器人连不上 KOOK

**重要：** Token 就像密码，**绝对不要发给任何人**！

### 获取 Token 的步骤

#### 1. 登录 KOOK 开发者后台

1. 打开浏览器，访问：https://developer.kookapp.cn/

2. 你会看到登录页面：

   **方式一：手机 KOOK App 扫码**
   - 打开手机上的 KOOK App
   - 点击右上角 "+" 或扫描图标
   - 扫描网页上的二维码

   **方式二：手机号验证码**
   - 输入你的手机号
   - 点击"获取验证码"
   - 输入收到的短信验证码
   - 点击登录

3. 登录成功后，进入开发者控制台

#### 2. 创建新应用

1. 在开发者控制台页面，找到并点击右上角的 **"创建应用"** 按钮

2. 填写应用信息：

   **应用名称**（必填）：
   - 给你的机器人起个名字
   - 建议：使用你能记住的名字，比如"AI小助手"、"游戏助手"
   - 这个名字可以随时修改

   **应用描述**（可选）：
   - 简单描述这个机器人是做什么的
   - 例如："智能问答机器人"
   - 也可以随便填

3. 点击 **"创建"** 按钮

4. 创建成功后，会自动跳转到应用详情页

#### 3. 获取机器人 Token

1. 在应用详情页，看左侧菜单栏

2. 点击 **"机器人"** 菜单项

3. 在右侧页面中，找到 **Token** 字段

4. Token 默认是隐藏的，点击 **"点击显示"** 按钮

5. 点击 **"复制"** 按钮，复制 Token

   > 如果没有"复制"按钮，手动选中 Token 文字，右键复制

6. Token 看起来像这样：

   ```
   1/MTA4NjQ0MDE5MjY5MjU4NTg5Mg==.Oz1t9K.52q4b6fZJJkX1234567890abcdef
   ```

7. **临时保存好这个 Token**（可以粘贴到记事本里）

> ⚠️ **再次提醒：Token 相当于密码，不要截图发给别人，不要发到群里！**

### 机器人的其他设置（可选）

在同一个页面，你还可以设置：

- **机器人名称**：显示在 KOOK 中的名字
- **头像**：机器人的头像图片
- **介绍**：机器人的功能介绍

这些都可以在创建后再修改。

---

## 第四步：初始化配置

现在我们要告诉 KOOK OpenClaw：

1. 你的 Token 是什么
2. 谁能使用这个机器人
3. 机器人能做什么

### 启动配置向导

在命令行中输入：

```bash
kook-openclaw onboard
```

然后按回车。

你会看到：

```
? How would you like to configure OpenClaw? (Use arrow keys)
❯ Interactive wizard (recommended)
  Skip onboarding (manual config)
```

按 **回车** 选择"Interactive wizard"（交互式向导）。

### 配置步骤详解

#### 步骤 1：选择要配置的渠道

```
? Select channels to configure: (Press <space> to select, <a> to toggle all, <i> to invert selection)
 ◯ Discord
❯◉ KOOK
 ◯ Telegram
 ◯ WhatsApp
 ...
```

**操作：**

- 确保 **KOOK** 前面有 `◉` 符号（表示已选中）
- 如果没有，用 **方向键上下** 移动到 KOOK，按 **空格** 选中
- 按 **回车** 继续

#### 步骤 2：配置 KOOK Token

```
? Enter your KOOK bot token: [input is hidden]
```

**操作：**

1. 粘贴你刚才复制的 Token
2. 按回车

> 💡 **提示：** 粘贴时屏幕上不会显示任何字符，这是正常的安全机制，直接回车即可。

#### 步骤 3：私聊权限设置

```
? Allow DMs from specific users? (y/N)
```

**这是什么意思？**

- **y (Yes)**：配置私聊权限策略（推荐，更安全）
- **N (No)**：跳过详细配置，使用默认设置

**建议：** 选择 **y**（输入 y 然后回车）

**然后输入允许私聊的用户 ID：**

```
? KOOK allowFrom (user id):
```

**如何获取用户 ID？**

1. 打开 KOOK App
2. 找到你想允许私聊的用户（可以是你自己）
3. **右键点击用户头像**（手机端：长按头像）
4. 选择 **"复制 ID"**
5. 粘贴到命令行
6. 回车

**用户 ID 是一串纯数字**，比如：`1234567890`

> 💡 **提示：** 可以先添加你自己的 ID，后续再在配置文件中添加其他人。

**DM 策略说明：**

配置完成后，DM 设置会保存在配置文件中：

```json
"dm": {
  "enabled": true,
  "policy": "allowlist",
  "allowFrom": ["1234567890"]
}
```

支持的策略：

- `allowlist`：只允许白名单中的用户（最安全的选项）
- `pairing`：配对模式
- `open`：允许任何人（不推荐）

#### 步骤 4：基础参数配置

接下来会问三个问题，**直接回车使用默认值**即可：

```
? History limit (number of messages to fetch) (10)
```

按回车（保持 10）

```
? Media max size in MB (10)
```

按回车（保持 10）

```
? Text chunk limit (2000)
```

按回车（保持 2000）

**这些参数是什么意思？**

| 参数             | 默认值 | 说明                                                                      |
| ---------------- | ------ | ------------------------------------------------------------------------- |
| History limit    | 10     | AI 能看到的上下文消息数。比如设为 10，AI 会参考最近 10 条消息来理解语境。 |
| Media max size   | 10MB   | 发送给机器人的文件大小限制。超过这个大小的文件会被拒绝。                  |
| Text chunk limit | 2000   | 单条消息的最大长度。如果 AI 回复很长，会被分割成多条发送。                |

**新手建议：** 保持默认，以后熟悉后再调整。

#### 步骤 5：服务器访问策略配置

```
? Configure group/server access policy? (y/N)
```

输入 **y** 然后回车，配置服务器访问策略。

```
? Group/Server access policy
  Open - allow all servers
  Allowlist - only configured servers
❯ Disabled - no server access
```

**选项说明：**

- **Open**：允许机器人加入所有服务器（推荐初学者使用）
- **Allowlist**：只允许配置的服务器
- **Disabled**：禁止服务器访问（仅私聊模式）

**建议：** 初学者选择 **Open**，让机器人在所有服务器都能工作。后续如需限制，可修改配置文件。

配置示例（选择 Allowlist 时）：

```
? Guild ID (numeric) or leave empty to finish: 123456789
? Guild slug/alias (optional): my-server
? Require @mention in this guild? (y/N) N
? Channel ID to allow (numeric) or leave empty to finish: 987654321
```

#### 步骤 6：功能开关（Actions）

配置向导会显示权限配置说明，然后询问：

```
? Configure KOOK Bot permissions in detail? (Recommended for advanced users) (y/N)
```

**建议：** 直接回车（选择 N），使用默认的安全权限配置。

**默认权限配置如下：**

**✅ 已启用功能（只读）：**

- 发送消息、发送私聊消息
- 获取用户信息、机器人自身信息
- 获取服务器信息、频道信息
- 获取角色列表、表情列表
- 获取禁言列表

**✅ 已启用功能（写入）：**

- 角色管理（创建、更新、删除、授予、撤销）

**❌ 默认禁用功能（危险操作）：**

- 频道管理（创建、修改、删除频道）
- 成员管理（修改昵称、踢出用户、离开服务器）
- 表情管理（创建、修改、删除表情）
- 禁言管理（创建、删除禁言）

**如需自定义权限，选择 y 后会逐个询问：**

```
? Enable getMe (bot self info)? (Y/n)
? Enable getUser (user lookup)? (Y/n)
? Enable getGuildList? (Y/n)
...等等
```

**新手建议：** 保持默认设置，只使用对话功能。等熟悉后再根据需要开启管理功能。

配置文件中的 actions 示例：

```json
"actions": {
  "getMe": true,
  "getUser": true,
  "getGuildList": true,
  "getGuild": true,
  "roleInfo": true,
  "roles": true,
  "channels": false,
  "moderation": false,
  "emojiUploads": false
}
```

#### 步骤 7：完成配置

如果一切顺利，你会看到：

```
Configuration saved to:
  Windows: C:\Users\你的用户名\.openclaw\openclaw.json
  macOS/Linux: ~/.openclaw/openclaw.json

Onboarding complete! 🎉
```

🎉 **配置完成！**

---

## 第五步：启动机器人

### 方式一：前台运行（适合测试）

在命令行输入：

```bash
kook-openclaw gateway
```

你会看到很多日志输出：

```
[kook] Resolving account configuration...
[kook] Connecting to KOOK gateway...
[kook] WebSocket connected, starting heartbeat
Gateway started
```

**看到 "Gateway started" 表示启动成功！**

**测试机器人：**

1. 打开 KOOK App
2. 进入一个你有权限的文字频道
3. @你的机器人，发送消息：
   ```
   @AI小助手 你好
   ```
4. 等待几秒钟，机器人应该会回复你

**如何停止？**

在命令行窗口中按 `Ctrl + C`（按住 Ctrl 键，再按 C 键），然后按回车确认。

### 方式二：后台运行（适合长期使用）

前台运行的缺点是：关闭命令行窗口，机器人就停止了。

如果你想让机器人一直在后台运行，使用以下方法：

#### Windows 后台运行

**方法：使用系统服务**

```bash
# 1. 安装为 Windows 服务
kook-openclaw service install

# 2. 启动服务
kook-openclaw service start

# 3. 查看状态
kook-openclaw status
```

如果显示 `running`，表示机器人正在后台运行。

**常用服务命令：**

```bash
# 查看状态
kook-openclaw status

# 停止服务
kook-openclaw service stop

# 重启服务
kook-openclaw service restart

# 卸载服务
kook-openclaw service uninstall
```

#### macOS/Linux 后台运行

**方法：使用 pm2**

1. 安装 pm2：

   ```bash
   npm install -g pm2
   ```

2. 启动机器人：

   ```bash
   pm2 start kook-openclaw -- gateway
   ```

3. 保存配置（开机自动启动）：

   ```bash
   pm2 save
   pm2 startup
   ```

4. 常用命令：

   ```bash
   # 查看状态
   pm2 status

   # 查看日志
   pm2 logs kook-openclaw

   # 重启
   pm2 restart kook-openclaw

   # 停止
   pm2 stop kook-openclaw
   ```

---

## 日常使用

### 查看机器人状态

```bash
kook-openclaw status
```

输出示例：

```
Gateway: running
PID: 12345
Uptime: 2 hours 15 minutes
```

### 查看运行日志

如果机器人工作不正常，查看日志找原因：

```bash
kook-openclaw logs
```

查看最近的 100 行日志：

```bash
kook-openclaw logs --tail 100
```

### 诊断问题

```bash
kook-openclaw doctor
```

这个命令会检查：

- 配置文件是否正确
- Token 是否有效
- 网络连接是否正常
- 其他可能的问题

**自动修复问题：**

```bash
kook-openclaw doctor --fix
```

### 重新配置

如果想修改配置，重新运行：

```bash
kook-openclaw onboard
```

这会覆盖之前的配置。

---

## 进阶配置

### 配置文件位置

- **Windows**: `C:\Users\你的用户名\.openclaw\openclaw.json`
- **macOS/Linux**: `~/.openclaw/openclaw.json`

可以用记事本（Windows）或文本编辑器打开。

### 1. 添加更多允许私聊的用户

**场景：** 刚开始只加了自己的 ID，现在想让别人也能私聊机器人。

**操作：**

1. 打开配置文件

2. 找到 DM 配置部分：

   ```json
   "dm": {
     "enabled": true,
     "policy": "allowlist",
     "allowFrom": ["1234567890"]
   }
   ```

3. 在方括号中添加更多用户 ID，用逗号分隔：
   ```json
   "dm": {
     "enabled": true,
     "policy": "allowlist",
     "allowFrom": ["1234567890", "9876543210", "1111111111"]
   }
   ```

**支持的 policy 值：**

- `"allowlist"`：只允许白名单中的用户
- `"pairing"`：配对模式
- `"open"`：允许任何人（不推荐用于生产环境）

4. 保存文件

5. 重启机器人（如果是后台运行）

### 2. 让机器人在所有频道自动回复（不需要@）

**场景：** 现在必须 @机器人 它才回复，想让它在任何消息都自动回复。

**操作：**

1. 打开配置文件

2. 找到 `guilds` 部分（特定服务器配置）或设置 `groupPolicy`：

   ```json
   "groupPolicy": "open"
   ```

3. 对于特定频道，在 `guilds` 中配置：

   ```json
   "guilds": {
     "123456789": {
       "slug": "my-server",
       "requireMention": false,
       "channels": {
         "987654321": {
           "allow": true,
           "requireMention": false
         }
       }
     }
   }
   ```

4. 保存并重启机器人

> ⚠️ **注意：** 这样设置后，机器人在任何频道都会回复每条消息，可能会被刷屏。建议在特定频道开启即可。

### 3. 多账户配置（高级）

**场景：** 需要同时运行多个 KOOK 机器人。

**操作：**

1. 打开配置文件

2. 在 `channels.kook` 下添加 `accounts`：
   ```json
   "channels": {
     "kook": {
       "enabled": true,
       "accounts": {
         "bot1": {
           "name": "主机器人",
           "enabled": true,
           "token": "your-token-1"
         },
         "bot2": {
           "name": "辅助机器人",
           "enabled": true,
           "token": "your-token-2"
         }
       }
     }
   }
   ```

### 4. 配置自己的 AI 模型（可选）

默认情况下，KOOK OpenClaw 使用内置的 AI 模型。如果你想使用自己的 Claude 或 OpenAI API：

**步骤：**

1. 获取 API Key：
   - Claude: https://console.anthropic.com/
   - OpenAI: https://platform.openai.com/

2. 在配置文件中添加：
   ```json
   {
     "models": {
       "providers": {
         "anthropic": {
           "apiKey": "sk-ant-api03-你的-Claude-Key"
         }
       }
     },
     "agents": {
       "defaults": {
         "model": {
           "primary": "claude:claude-3-5-sonnet-20241022"
         }
       }
     }
   }
   ```

> 💡 **注意：** 使用自己的 API Key 会产生费用，请确保账户有余额。

---

## 故障排查

### 排查流程图

```
机器人不工作？
    |
    ├─ 检查是否在运行
    │   └─ 运行: kook-openclaw status
    │       ├─ running → 检查日志
    │       └─ stopped → 启动机器人
    |
    ├─ 检查日志
    │   └─ 运行: kook-openclaw logs
    │       ├─ 看到 "Token invalid" → Token 错误，重新配置
    │       ├─ 看到 "Connection timeout" → 网络问题
    │       └─ 其他错误 → 搜索错误信息或求助
    |
    └─ 运行诊断
        └─ 运行: kook-openclaw doctor
            └─ 根据提示修复
```

### 常见错误及解决

#### 错误 1：Token Invalid（Token 无效）

**日志中的错误：**

```
[kook] HELLO failed: Invalid token
[kook] HELLO failed: Token verification failed
[kook] HELLO failed: Token expired
```

**原因：**

- Token 复制不完整
- Token 已过期（在 KOOK 后台重新生成了）
- Token 输入错误

**解决：**

1. 重新到 KOOK 开发者后台获取 Token
2. 运行 `kook-openclaw onboard` 重新配置
3. 粘贴 Token 时确保完整

#### 错误 2：Connection Timeout（连接超时）

**日志中的错误：**

```
[kook] RECONNECT received: code=..., err=...
Connection timeout
WebSocket error
```

**原因：**

- 网络不稳定
- 防火墙拦截
- KOOK 服务器问题

**解决：**

1. 检查网络连接
2. 尝试重启机器人
3. 等待几分钟后重试

#### 错误 3：机器人显示在线但不回复

**排查步骤：**

1. **检查是否被禁言**
   - 在 KOOK 中查看机器人角色是否有发言权限
   - 确认机器人没有被频道禁言

2. **检查 requireMention 设置**
   - 如果配置为 `true`，必须 @机器人才会回复
   - 尝试 `@机器人名字 你好`

3. **检查日志**
   - 运行 `kook-openclaw logs`
   - 看是否有收到消息的记录

4. **检查 AI 响应**
   - 可能是 AI 模型响应慢或失败
   - 等待 30 秒再试

#### 错误 4：配置文件格式错误

**日志中的错误：**

```
SyntaxError: Unexpected token in JSON
```

**原因：**

- 手动编辑配置文件时语法错误
- 多加了逗号或引号

**解决：**

1. 运行 `kook-openclaw doctor --fix` 尝试自动修复
2. 如果不行，删除配置文件重新运行 `kook-openclaw onboard`

---

## 常见问题 FAQ

### Q1: 安装时卡在 "idealTree:lib: sill idealTree buildDeps" 很久

**A:** 这是正常的，表示正在下载依赖。根据网络情况，可能需要 1-5 分钟。

如果超过 10 分钟：

1. 按 `Ctrl + C` 取消
2. 切换网络（试试手机热点）
3. 重新运行安装命令

### Q2: 提示 "kook-openclaw 不是内部或外部命令"

**A:**

步骤 1：关闭命令行窗口，重新打开，再试。

步骤 2：如果还不行，尝试：

```bash
npx kook-openclaw --version
```

步骤 3：重启电脑后再试。

### Q3: 如何更新到最新版本？

**A:**

```bash
npm update -g kook-openclaw
```

或者先卸载再安装：

```bash
npm uninstall -g kook-openclaw
npm install -g kook-openclaw
```

### Q4: 机器人回复很慢怎么办？

**A:**

可能原因：

1. **AI 模型响应慢** → 正常现象，特别是复杂问题需要 5-10 秒
2. **网络延迟** → 检查你的网络连接
3. **消息太长** → 缩短你的问题

如果超过 30 秒没有回复：

1. 检查日志 `kook-openclaw logs`
2. 重启机器人

### Q5: 如何彻底删除机器人？

**A:**

步骤 1：停止运行

- 前台运行：按 `Ctrl + C`
- 后台服务：`kook-openclaw service stop`

步骤 2：卸载程序

```bash
npm uninstall -g kook-openclaw
```

步骤 3：删除配置

- Windows: 删除文件夹 `C:\Users\你的用户名\.openclaw`
- macOS/Linux: 删除文件夹 `~/.openclaw`

步骤 4（可选）：在 KOOK 开发者后台删除应用

### Q6: 可以在多个服务器使用同一个机器人吗？

**A:** 可以！一个机器人可以加入多个 KOOK 服务器。只需要把机器人邀请到服务器即可。

### Q7: 使用这个机器人要花多少钱？

**A:**

- **KOOK OpenClaw 本身**：免费
- **AI 模型调用**：默认使用内置模型，可能有使用限制
- **如果使用自己的 API Key**：按使用量付费（Claude/OpenAI 的收费标准）

### Q8: 机器人支持哪些 AI 模型？

**A:** 支持的模型包括：

- Claude（Claude 3.5 Sonnet、Claude 3 Opus 等）
- OpenAI（GPT-4o、GPT-4、GPT-3.5 等）
- 以及其他兼容 OpenAI API 的模型

### Q9: 机器人可以语音对话吗？

**A:** 目前只支持文字对话。语音功能可能在后续版本添加。

### Q10: 如何备份配置文件？

**A:** 直接复制配置文件到安全的地方：

Windows:

```bash
copy C:\Users\你的用户名\.openclaw\openclaw.json D:\备份\openclaw-backup.json
```

macOS/Linux:

```bash
cp ~/.openclaw/openclaw.json ~/Documents/openclaw-backup.json
```

---

## 快速检查清单

配置完成后，逐一检查：

### 安装阶段

- [ ] Node.js 已安装（`node -v` 显示 v22.x.x 或更高）
- [ ] `kook-openclaw` 安装成功（`kook-openclaw --version` 有版本号）

### KOOK 配置阶段

- [ ] 已访问 https://developer.kookapp.cn/
- [ ] 已创建应用
- [ ] 已获取 Token（已复制保存）
- [ ] Token 已安全保存，没有泄露

### 初始化配置阶段

- [ ] 已完成 `kook-openclaw onboard`
- [ ] 已输入 Token
- [ ] 已添加至少一个允许私聊的用户 ID（建议是自己）
- [ ] 已配置服务器访问策略（推荐选择 Open）

### 启动阶段

- [ ] 机器人已启动（`kook-openclaw gateway` 或后台服务）
- [ ] `kook-openclaw status` 显示 `running`
- [ ] `kook-openclaw doctor` 没有报错

### 测试阶段

- [ ] 在 KOOK 中 @机器人能得到回复
- [ ] 私聊机器人能得到回复（如果配置了）

**全部打勾？恭喜你，KOOK AI 机器人配置完成！🎉**

---

## 获取帮助

如果本文档无法解决你的问题：

1. **查看官方文档**: https://docs.openclaw.ai/
2. **运行诊断命令**: `kook-openclaw doctor`
3. **查看日志**: `kook-openclaw logs`
4. **在 GitHub 搜索**: https://github.com/openclaw/openclaw

**反馈问题时请提供：**

- 操作系统（Windows/macOS/Linux）
- Node.js 版本（`node -v` 的输出）
- 错误信息（复制日志中的错误）
- 已经尝试过的解决方法

---

**祝使用愉快！让你的 KOOK 服务器更智能！🎮**
