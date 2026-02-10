---
summary: "钉钉应用机器人支持状态、功能和配置"
read_when:
  - 您想要连接钉钉应用机器人
  - 您正在配置钉钉渠道
title: 钉钉
---

# 钉钉应用机器人

状态：生产就绪，支持机器人私聊。使用 WebSocket 长连接模式接收消息。

## 需要插件

安装钉钉插件：

```bash
openclaw plugins install @openclaw/ddingtalk
```

本地 checkout（在 git 仓库内运行）：

```bash
openclaw plugins install ./extensions/ddingtalk
```

___

## 快速开始

添加钉钉渠道有两种方式：

### 方式一：通过安装向导添加（推荐）

如果您刚安装完 OpenClaw，可以直接运行向导，根据提示添加钉钉：

```bash
openclaw onboard
```

向导会引导您完成：

1. 创建钉钉应用机器人并获取凭证
2. 配置应用凭证
3. 启动网关

**完成配置后**，您可以使用以下命令检查网关状态：

- `openclaw gateway status` - 查看网关运行状态
- `openclaw logs --follow` - 查看实时日志

### 方式二：通过命令行添加

如果您已经完成了初始安装，可以用以下命令添加钉钉渠道：

```bash
openclaw channels add
```

然后根据交互式提示选择 DingTalk，输入 AppKey (Client ID) 和 AppSecret (Client Secret) 即可。

**完成配置后**，您可以使用以下命令管理网关：

- `openclaw gateway status` - 查看网关运行状态
- `openclaw gateway restart` - 重启网关以应用新配置
- `openclaw logs --follow` - 查看实时日志

---

## 第一步：创建钉钉应用

### 1. 打开钉钉开发者平台

访问 [钉钉开发者平台](https://open-dev.dingtalk.com/fe/app)，使用钉钉账号登录，选择组织进入。

### 2. 创建应用

1. 点击右上角 **创建应用**
2. 填写应用名称和描述，上传图片（可选）

![创建应用](../../images/ddingtalk/ddingtalk-create-app.png)

### 3. 获取应用凭证

在应用的 **凭证与基础信息** 页面，复制：

- **Client ID**（格式如 `dingxxxx`）
- **Client Secret**

❗ **重要**：请妥善保管 Client Secret，不要分享给他人。

![获取应用凭证](../../images/ddingtalk/ddingtalk-credentials.png)

### 4. 添加应用机器人

在应用的 **添加应用能力** 页面，选择 **机器人**，点击添加

![添加机器人](../../images/ddingtalk/ddingtalk-create-robot.png)

输入机器人相关信息，**消息接收模式** 选择 **Stream模式**，然后保存

![配置机器人](../../images/ddingtalk/ddingtalk-robot-config.png)

![配置机器人消息接收模式](../../images/ddingtalk/ddingtalk-robot-config-stream.png)

### 5. 发布机器人

创建机器人版本，填入版本号，描述，应用可用范围，点击保存，点击确认发布

![创建机器人版本](../../images/ddingtalk/ddingtalk-create-version.png)

![编辑版本](../../images/ddingtalk/ddingtalk-edit-version.png)

---

## 第二步：配置 OpenClaw

### 通过向导配置（推荐）

运行以下命令，根据提示选择 DingTalk，粘贴 AppKey (Client ID) 和 AppSecret (Client Secret)：

```bash
openclaw channels add
```

### 通过配置文件配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "ddingtalk": {
      "enabled": true,
      "clientId": "dingxxxx",
      "clientSecret": "yyyy"
    }
  }
}
```

---

## 第三步：启动并测试

### 1. 启动网关

```bash
openclaw gateway --verbose
```

### 2. 发送测试消息

在钉钉中找到您创建的机器人，即可正常对话。

![钉钉对话](../../images/ddingtalk/ddingtalk-chat.jpg)

---

## 介绍

### 支持的功能

- **Stream 模式**：无需公网 IP 和域名，开箱即用
- **私聊**：仅支持私聊
- **接收消息类型**：机器人可接收用户发送的文本、图片、图文、语音、视频、文件消息
- **回复消息类型**：机器人可回复文本、图片、文件类型、Markdown 格式消息
- **主动推送消息**：支持主动推送消息，可以配置提醒或定时任务
- **支持OpenClaw命令**：支持 /new、/compact、/models 等 OpenClaw 官方命令
