---

summary: "DingTalk App Robot Support Status, Features, and Configuration"
read_when:

- You want to connect a DingTalk app robot
  - You are configuring the DingTalk channel
title: DingTalk

---

# DingTalk App Robot

Status: Production-ready, supports robot private chats. Uses WebSocket long connection mode to receive messages.

## Required Plugin

Install the DingTalk plugin:

```bash
openclaw plugins install @openclaw/ddingtalk
```

Local checkout (run inside the git repository):

```bash
openclaw plugins install ./extensions/ddingtalk
```

___

## Quick Start

There are two ways to add the DingTalk channel:

### Method 1: Add via Installation Wizard (Recommended)

If you have just installed OpenClaw, you can run the wizard directly and follow the prompts to add DingTalk:

```bash
openclaw onboard
```

The wizard will guide you through:

1. Creating a DingTalk app robot and obtaining credentials
2. Configuring app credentials
3. Starting the gateway

**After completing the configuration**, you can use the following commands to check the gateway status:

- `openclaw gateway status` - View gateway running status
- `openclaw logs --follow` - View real-time logs

### Method 2: Add via Command Line

If you have already completed the initial installation, you can use the following command to add the DingTalk channel:

```bash
openclaw channels add
```

Then, follow the interactive prompts to select DingTalk, and enter the AppKey (Client ID) and AppSecret (Client Secret).

**After completing the configuration**, you can use the following commands to manage the gateway:

- `openclaw gateway status` - View gateway running status
- `openclaw gateway restart` - Restart the gateway to apply new configurations
- `openclaw logs --follow` - View real-time logs

---

## Step 1: Create a DingTalk App

### 1. Open the DingTalk Developer Platform

Visit the [DingTalk Developer Platform](https://open-dev.dingtalk.com/fe/app), log in with your DingTalk account, and select an organization to enter.

### 2. Create an App

1. Click **Create App** in the upper right corner
2. Fill in the app name and description, upload an image (optional)

![Create App](../images/ddingtalk/ddingtalk-create-app.png)

### 3. Obtain App Credentials

On the app's **Credentials & Basic Information** page, copy:

- **Client ID** (format like `dingxxxx`)
- **Client Secret**

❗ **Important**: Please keep the Client Secret safe and do not share it with others.

![Obtain App Credentials](../images/ddingtalk/ddingtalk-credentials.png)

### 4. Add an App Robot

On the app's **Add App Capabilities** page, select **Robot**, and click Add

![Add Robot](../images/ddingtalk/ddingtalk-create-robot.png)

Enter the relevant robot information, select **Stream Mode** for **Message Receiving Mode**, and then save

![Configure Robot](../images/ddingtalk/ddingtalk-robot-config.png)

![Configure Robot Message Receiving Mode](../images/ddingtalk/ddingtalk-robot-config-stream.png)

### 5. Publish the Robot

Create a robot version, fill in the version number, description, application availability scope, click save, then click confirm to publish.

![Create Robot Version](../images/ddingtalk/ddingtalk-create-version.png)

![Edit Version](../images/ddingtalk/ddingtalk-edit-version.png)

---

## Step 2: Configure OpenClaw

### Configure via Wizard (Recommended)

Run the following command, select DingTalk according to the prompts, and paste the AppKey (Client ID) and AppSecret (Client Secret):

```bash
openclaw channels add
```

### Configure via Configuration File

Edit `~/.openclaw/openclaw.json`:

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

## Step 3: Start and Test

### 1. Start the Gateway

```bash
openclaw gateway --verbose
```

### 2. Send a Test Message

Find the robot you created in DingTalk, and you can start a normal conversation.

![DingTalk Conversation](../images/ddingtalk/ddingtalk-chat.jpg)

---

## Introduction

### Supported Features

- **Stream Mode**: No public IP or domain required, works out of the box.
- **Private Chat**: Only supports private chat.
- **Supported Received Message Types**: The robot can receive text, image, graphic, voice, video, and file messages sent by users.
- **Supported Reply Message Types**: The robot can reply with text, images, files, and Markdown format messages.
- **Active Message Push**: Supports active message pushing, configurable for reminders or scheduled tasks.
- **OpenClaw Command Support**: Supports official OpenClaw commands such as `/new`, `/compact`, `/models`.
