# AWS VPC Setup for OpenClaw

## Create VPC

1. Go to **VPC > Create VPC** in the AWS Console.
2. Select **"VPC and more"** (creates subnets, route tables, and internet gateway automatically).

## VPC Settings

| Setting | Value |
|---|---|
| **Name tag** | `openclaw` (or your preference) |
| **IPv4 CIDR** | `10.0.0.0/16` |
| **IPv6 CIDR block** | No IPv6 block |
| **Tenancy** | Default |
| **VPC encryption control** | None |

## Subnet and Network Settings

| Setting | Value | Notes |
|---|---|---|
| **Availability Zones** | 2 | Required for 2 public subnets |
| **Public subnets** | 2 | One is used, the other sits idle (no cost) |
| **Private subnets** | 0 | Not needed for a single-instance deployment |
| **NAT gateways** | None | Only needed for private subnets; ~$32/mo each |
| **VPC endpoints** | None | Not needed when EC2 is in a public subnet |

## DNS Options

| Setting | Value |
|---|---|
| **DNS hostnames** | Enabled |
| **DNS resolution** | Enabled |

Both are needed so the EC2 instance gets a public DNS name and internal DNS works correctly. No extra cost.

## Launch EC2 Instance

1. Go to **EC2 > Launch an instance**.
2. Configure the following:

| Setting | Value |
|---|---|
| **AMI** | Ubuntu 24.04 LTS (noble) |
| **Instance type** | t3.small (2 GiB RAM minimum) |
| **Key pair** | Create new — ED25519, .pem format |
| **VPC** | Select the VPC created above |
| **Subnet** | One of the public subnets |
| **Auto-assign public IP** | Enable |
| **Storage** | 20 GiB gp3 |

### Security Group

Create a new security group with these inbound rules:

| Type | Port | Source | Description |
|---|---|---|---|
| SSH | 22 | My IP | SSH access |
| Custom TCP | 18789 | My IP | OpenClaw gateway |

## Install OpenClaw

SSH into the instance (move the .pem file to `~/.ssh/` or your preferred location):

```bash
chmod 600 ~/path/to/your-key.pem
ssh -i ~/path/to/your-key.pem ubuntu@<public-ip>
```

Install Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Install OpenClaw, ffmpeg (audio format conversion), and build tools (for whisper-cpp):

```bash
sudo apt-get install -y ffmpeg build-essential cmake git
sudo npm i -g clawdbot@latest
```

Verify the installation:

```bash
clawdbot --version
```

## Configure OpenClaw

Set gateway mode and auth token:

```bash
clawdbot config set gateway.mode local
openssl rand -hex 32
# copy the output, then:
clawdbot config set gateway.auth.token <token>
```

Create the credentials directory:

```bash
mkdir -p ~/.clawdbot/credentials
```

### Set Up Auth Profiles

The gateway reads API keys from an auth-profiles file, not environment variables. Create the file for the main agent:

```bash
mkdir -p ~/.clawdbot/agents/main/agent
cat > ~/.clawdbot/agents/main/agent/auth-profiles.json << 'EOF'
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "<your-anthropic-api-key>"
    }
  }
}
EOF
```

### Set Up Local Audio Transcription (whisper-cpp)

Install whisper-cpp for free, local voice message transcription (no API key needed):

```bash
cd /tmp
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j2
sudo cp build/bin/whisper-cli /usr/local/bin/
```

Download the base English model (~141 MB):

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Set the model path (add to `~/.bashrc` so it persists):

```bash
echo 'export WHISPER_CPP_MODEL=$HOME/.local/share/whisper-cpp/ggml-base.en.bin' >> ~/.bashrc
```

Run `clawdbot doctor` to verify everything is clean.

## Install the Gateway Service

Install the gateway as a systemd user service so it auto-restarts on crash and starts on boot:

```bash
clawdbot daemon install --port 18789 --token <gateway-token> --force
```

Add your Anthropic API key and whisper model path to the service unit (the installer does not include these automatically):

```bash
sed -i '/CLAWDBOT_SERVICE_VERSION/a Environment=ANTHROPIC_API_KEY=<your-anthropic-api-key>' \
  ~/.config/systemd/user/clawdbot-gateway.service
sed -i '/ANTHROPIC_API_KEY/a Environment=WHISPER_CPP_MODEL=/home/ubuntu/.local/share/whisper-cpp/ggml-base.en.bin' \
  ~/.config/systemd/user/clawdbot-gateway.service
```

Enable linger so the service runs even when not logged in, then start it:

```bash
loginctl enable-linger $(whoami)
systemctl --user daemon-reload
systemctl --user enable clawdbot-gateway
systemctl --user start clawdbot-gateway
```

Verify it started:

```bash
systemctl --user status clawdbot-gateway
```

### Service Management

```bash
systemctl --user restart clawdbot-gateway   # restart
systemctl --user stop clawdbot-gateway      # stop
journalctl --user -u clawdbot-gateway -f    # follow logs
```

## Connect via SSH Tunnel

The gateway binds to loopback (`127.0.0.1`) by default, so it is not exposed to the internet. Use an SSH tunnel to access it from your local machine:

```bash
ssh -i ~/path/to/your-key.pem -L 18789:127.0.0.1:18789 -N -f ubuntu@<public-ip>
```

The gateway is now available locally at `ws://localhost:18789`.

To close the tunnel:

```bash
pkill -f "ssh.*-L 18789"
```
