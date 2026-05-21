---
summary: "Host OpenClaw on Upstash Box with persistent keep-alive and SSH tunnel access"
read_when:
  - Deploying OpenClaw to Upstash Box
  - You want a managed cloud environment for OpenClaw with no server admin overhead
title: "Upstash Box"
---

# Upstash Box

Run a persistent OpenClaw Gateway on [Upstash Box](https://upstash.com/docs/box/overall/quickstart), a managed Linux environment that stays alive around the clock.

## Prerequisites

- [Upstash account](https://console.upstash.com)
- SSH client on your local machine

<Steps>
  <Step title="Create a keep-alive Box">
    Log in to the [Upstash Console](https://console.upstash.com), open **Box**, and create a new Box with the **Keep-Alive** option enabled.

    Note your Box ID (for example, `right-flamingo-14486`) and your [Box API key](https://upstash.com/docs/box/overall/quickstart#1-get-your-api-key).

  </Step>

  <Step title="Connect via SSH">
    The `-L` flag tunnels the OpenClaw dashboard port to your local machine. Use your Box API key as the password when prompted.

    ```bash
    ssh -L 18789:127.0.0.1:18789 <box-id>@us-east-1.box.upstash.com
    ```

  </Step>

  <Step title="Install OpenClaw">
    ```bash
    sudo npm install -g openclaw
    ```
  </Step>

  <Step title="Run onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    Follow the prompts to complete setup. Copy the dashboard URL and token when onboarding finishes.

  </Step>

  <Step title="Start the Gateway">
    ```bash
    openclaw config set gateway.bind lan
    openclaw gateway run
    ```
  </Step>

  <Step title="Open the dashboard">
    With the SSH tunnel active, open the dashboard URL in your browser:

    ```
    http://127.0.0.1:18789/#token=<your-token>
    ```

  </Step>
</Steps>

## Next steps

- Set up messaging channels: [Channels](/channels)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- Keep OpenClaw up to date: [Updating](/install/updating)
