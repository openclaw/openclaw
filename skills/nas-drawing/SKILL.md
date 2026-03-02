---
name: nas-drawing
description: "查询公司 NAS 上的产品图纸文件并下载/发送。当用户提到查图纸、找图纸、图档、图纸编号（如 A 开头的编号）、产品图、工程图时激活。触发词：图纸，图档，查图，找图，图纸编号，产品图，工程图，drawing, NAS 图纸。"
---

# NAS 图纸查询 Skill

从公司 Synology NAS (192.168.3.106:5000) 查找并下载产品图纸。账号 `openclaw`，无密码。

## 🏆 推荐模型

**Claude Opus 4.6** (`mynewapi/claude-opus-4-6`)

- 速度测试最佳：85 秒完成全流程
- 工具调用稳定，不易超时
- 其他模型（qwen3.5-plus、glm-5、MiniMax-M2.5）易在 2 分钟内超时

## ⚡ 默认操作流程（推荐 - 智能查询）

**⚠️ 重要：始终使用智能脚本，自动选择最优查询方式！**

**使用智能脚本（推荐）：**

```bash
~/openclaw/skills/nas-drawing/scripts/find-drawing-smart.sh <图纸编号> <用户 ID>
```

**示例：**

```bash
find-drawing-smart.sh B0111 WangChong
find-drawing-smart.sh H2006 WangPengCheng
```

**工作原理：**

1. 先尝试快速查询（5-8 秒）
2. 如果快速查询失败，自动回退到完整查询（15-20 秒）
3. 保证成功率的同时尽可能快

**脚本流程：**

- **快速模式**：登录 NAS → 搜索 `/公司产品图档` → 等待 2-6 秒 → 下载 → 发送
- **完整模式**（回退）：登录 NAS → 搜索 → 等待 10 秒 → 下载 → 发送

**⚠️ 重要限制：**

- **只搜索 `/公司产品图档`**，不搜索研发部、前叉图档、模具图档等其他目录
- 如果公司产品图档里没有，直接回复用户"未找到"，不继续搜索其他目录

**速度优化要点：**

- ✅ **直接使用智能脚本**（自动选择最优方式）
- ❌ 不要手动 Python/curl 登录（会浪费时间）
- 📁 只搜主目录（不依次搜索 6 个目录）
- 🖼️ 优先 `.jpg` 预览图（比 `.dwg` 小）
- ⚡ 总耗时：**5-20 秒**（根据 NAS 状态自动调整）

**❌ 不要做的事：**

- 不要先尝试 Python socket 手动登录（会浪费 15 秒）
- 不要先尝试 curl 手动查询（会浪费时间）
- 直接用智能脚本就行！

---

## 手动操作步骤（仅供参考，不推荐使用）

### Step 1: 登录

```bash
curl -s "http://192.168.3.106:5000/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=openclaw&passwd=&session=FileStation&format=cookie"
```

从返回 JSON 中提取 `data.sid` 作为后续请求的 `_sid` 参数。

### Step 2: 搜索文件

优先在 `/公司产品图档` 中搜索（递归 + 通配符）：

```bash
# 启动搜索（folder_path 需 URL encode）
curl -s "http://192.168.3.106:5000/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=start&folder_path=<URL 编码路径>&pattern=*关键词*&recursive=true&_sid=<SID>"
```

提取返回的 `data.taskid`，然后等待 5 秒后获取结果：

```bash
curl -s "http://192.168.3.106:5000/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=list&taskid=<TASKID>&offset=0&limit=100&additional=%5B%22size%22%2C%22time%22%2C%22real_path%22%5D&_sid=<SID>"
```

如果 `data.files` 为空且 `finished=true`，依次搜索备选目录：

1. `/公司产品图档`（主目录）
2. `/前叉图档资料`
3. `/模具图档`
4. `/前期设计资料`
5. `/比图仪用 1:1 图纸`
6. `/研发部`

### Step 3: 下载文件

```bash
curl -s -o /Users/haruki/.openclaw/workspace/<文件名> "http://192.168.3.106:5000/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=<URL 编码的文件 path>&mode=download&_sid=<SID>"
```

### Step 4: 发送文件

发送给请求查询的人（谁问的发给谁）：

- 判断当前消息来源的 session/channel，通过对应的 session 回复文件
- **企业微信用户**：通过 `sessions_send` 发送到对应用户的 wecom session（如 `agent:wecom-dm-{userid}:dm:{userid}`）
- **webchat 用户**：直接在当前对话中回复
- **飞书用户**：通过飞书 channel 发送
- **群聊**：发送到对应的群聊 session

## 常用 URL 编码

| 目录          | URL 编码                                                  |
| ------------- | --------------------------------------------------------- |
| /公司产品图档 | %2F%E5%85%AC%E5%8F%B8%E4%BA%A7%E5%93%81%E5%9B%BE%E6%A1%A3 |
| /前叉图档资料 | %2F%E5%89%8D%E5%8F%89%E5%9B%BE%E6%A1%A3%E8%B5%84%E6%96%99 |
| /模具图档     | %2F%E6%A8%A1%E5%85%B7%E5%9B%BE%E6%A1%A3                   |
| /前期设计资料 | %2F%E5%89%8D%E6%9C%9F%E8%AE%BE%E8%AE%A1%E8%B5%84%E6%96%99 |
| /研发部       | %2F%E7%A0%94%E5%8F%91%E9%83%A8                            |

## 注意事项

- **快速查找优先**：默认使用 `find-drawing-fast.sh` 脚本（5-8 秒）
- 搜索启动后需等待 **2 秒**再获取结果（快速模式）或 **5 秒**（完整模式）
- 如果结果 `finished=false`，再等几秒重试
- 图纸文件通常为 JPG/PDF/DWG 格式
- 编号格式通常为字母 + 数字（如 A0307003、B0111、H2006）
- 搜索时始终使用通配符 `*关键词*`
- **发送给谁**：谁问的发给谁，注明"来自 NAS 公司产品图档"
