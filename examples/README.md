# OpenClaw Examples

Example configurations and use cases for OpenClaw.

## Configuration Examples

### Raspberry Pi Configurations

#### [raspberry-pi-bedrock.json](./configs/raspberry-pi-bedrock.json)

**Raspberry Pi 5 (8GB) + AWS Bedrock**

- Claude Opus 4.5 for best quality
- Optimized concurrent agent limits
- Tested on Pi 5
- Full-featured setup

Usage:

```bash
cp examples/configs/raspberry-pi-bedrock.json ~/.openclaw/openclaw.json
# Edit: Add your bot tokens and credentials
openclaw gateway restart
```

#### [minimal-pi.json](./configs/minimal-pi.json)

**Raspberry Pi 4 (2GB) + AWS Bedrock**

- Claude Haiku for speed and efficiency
- Single concurrent agent
- Aggressive memory management
- Perfect for budget setups

Usage:

```bash
cp examples/configs/minimal-pi.json ~/.openclaw/openclaw.json
# Edit: Add your bot tokens and credentials
openclaw gateway restart
```

## Model Selection Guide

| Model                 | Speed   | Cost | Quality   | Best For              | RAM  |
| --------------------- | ------- | ---- | --------- | --------------------- | ---- |
| **Claude Opus 4.5**   | Slow    | $$$  | Excellent | Complex tasks, coding | 8GB+ |
| **Claude Sonnet 4.6** | Fast    | $$   | Great     | General use, balanced | 4GB+ |
| **Claude Haiku 4.5**  | Fastest | $    | Good      | Simple tasks, speed   | 2GB+ |

## Platform-Specific Notes

### Raspberry Pi

**Memory Optimization:**

- Pi 4 (2GB): Use `minimal-pi.json`, Claude Haiku, 1 concurrent agent
- Pi 4 (4GB): Use `raspberry-pi-bedrock.json`, Claude Sonnet, 2 concurrent agents
- Pi 5 (8GB): Use `raspberry-pi-bedrock.json`, Claude Opus, 2-3 concurrent agents

**Performance Tips:**

- Use USB SSD instead of SD card
- Enable swap for <4GB RAM
- Set `gpu_mem=16` in `/boot/config.txt` for headless
- Monitor with `scripts/raspberry-pi-monitor.sh`

### AWS Bedrock

**Cross-Region Models:**
When using `us-east-1`, add region prefix to model IDs:

```json
{
  "model": {
    "primary": "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
  }
}
```

Note the `us.` prefix for cross-region inference.

**Credentials:**
Set via environment or AWS CLI:

```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
```

Or:

```bash
aws configure
```

## Scripts

### Setup

- `scripts/setup/raspberry-pi-quickstart.sh` - Automated Pi setup

### Troubleshooting

- `scripts/troubleshooting/fix-telegram-polling.sh` - Fix Telegram bot not responding
- `scripts/troubleshooting/test-bedrock-models.sh` - Test AWS Bedrock access

### Monitoring

- `scripts/raspberry-pi-monitor.sh` - Monitor Pi performance

## Documentation

- **Raspberry Pi Guide:** [docs/platforms/raspberry-pi.md](../docs/platforms/raspberry-pi.md)
- **AWS Bedrock Guide:** [docs/providers/bedrock.md](../docs/providers/bedrock.md)

## Contributing

Found a useful configuration or example? Submit a PR!

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
