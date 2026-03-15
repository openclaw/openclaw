# Performance Optimization Tips for Raspberry Pi

Tips and tricks to get the best performance from OpenClaw on Raspberry Pi.

## Memory Optimization

### 1. Limit Concurrent Agents

```bash
# For 2GB Pi
openclaw config set agents.defaults.maxConcurrent 1

# For 4GB Pi
openclaw config set agents.defaults.maxConcurrent 2

# For 8GB Pi
openclaw config set agents.defaults.maxConcurrent 3
```

### 2. Enable Aggressive Compaction

For low-memory systems:

```bash
openclaw config set agents.defaults.compaction.mode aggressive
```

For systems with more RAM:

```bash
openclaw config set agents.defaults.compaction.mode safeguard
```

### 3. Use Faster Models

Claude Haiku uses less memory than Opus:

```bash
openclaw config set agents.defaults.model.primary \
  "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
```

### 4. Add Swap

For 2GB or less:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Optimize swappiness:

```bash
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## Storage Optimization

### 1. Use USB SSD

SD cards are slow and wear out. USB SSD provides:

- 5-10x faster read/write
- Better reliability
- Longer lifespan

**Enable USB boot:**

1. Flash OS to USB SSD
2. Update bootloader: `sudo rpi-eeprom-update -a`
3. Reboot

### 2. Reduce GPU Memory (Headless)

```bash
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt
sudo reboot
```

### 3. Clean Up Logs

```bash
# Remove old OpenClaw logs
find ~/.openclaw/logs -name "*.log" -mtime +7 -delete

# Limit systemd journal size
sudo journalctl --vacuum-size=100M
```

## CPU Optimization

### 1. Disable Unused Services

```bash
# Disable Bluetooth
sudo systemctl disable bluetooth

# Disable CUPS (printing)
sudo systemctl disable cups

# Disable Avahi (mDNS)
sudo systemctl disable avahi-daemon
```

### 2. Enable Performance Governor

```bash
echo "performance" | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

### 3. Monitor Temperature

Add cooling if temp > 75°C:

```bash
vcgencmd measure_temp
```

Install heatsink or fan for better performance.

## Network Optimization

### 1. Use Wired Ethernet

WiFi adds latency. Use Ethernet for best performance.

### 2. Disable WiFi Power Management

If using WiFi:

```bash
sudo iwconfig wlan0 power off
```

### 3. Enable IPv6 (if supported)

Some providers route IPv6 faster:

```bash
# Check if available
curl -6 https://api.telegram.org
```

## Model Selection

### By Use Case

| Use Case          | Recommended Model | Why            |
| ----------------- | ----------------- | -------------- |
| Simple Q&A        | Haiku 4.5         | Fast, cheap    |
| Code generation   | Sonnet 4.6        | Balanced       |
| Complex reasoning | Opus 4.5          | Best quality   |
| High volume       | Haiku 4.5         | Cost efficient |

### By Memory

| Pi RAM | Model       | Concurrent Agents |
| ------ | ----------- | ----------------- |
| 2GB    | Haiku       | 1                 |
| 4GB    | Sonnet      | 2                 |
| 8GB    | Opus/Sonnet | 2-3               |

## Bedrock Optimization

### 1. Enable Caching

For repeated prompts:

```bash
openclaw config set agents.defaults.cache.enabled true
```

### 2. Reduce Discovery Frequency

```bash
openclaw config set models.bedrockDiscovery.refreshInterval 7200
```

### 3. Filter Providers

Only discover models you use:

```bash
openclaw config set models.bedrockDiscovery.providerFilter '["anthropic"]'
```

## Monitoring

### 1. Use Health Check

```bash
./scripts/health-check.sh
```

### 2. Monitor Pi Performance

```bash
./scripts/raspberry-pi-monitor.sh
```

### 3. Check Logs

```bash
# Real-time logs
journalctl --user -u openclaw-gateway -f

# Recent errors
journalctl --user -u openclaw-gateway -p err -n 50
```

## Benchmarks

Tested on Raspberry Pi 5 (8GB):

| Configuration    | First Response | Memory (Idle) | Memory (Active) |
| ---------------- | -------------- | ------------- | --------------- |
| Opus, 2 agents   | 5-8s           | 600MB         | 1200MB          |
| Sonnet, 2 agents | 3-5s           | 500MB         | 900MB           |
| Haiku, 1 agent   | 2-3s           | 400MB         | 600MB           |

## Troubleshooting

### Out of Memory

```bash
# Check memory
free -h

# Add more swap
sudo fallocate -l 4G /swapfile2
sudo mkswap /swapfile2
sudo swapon /swapfile2

# Or reduce agents
openclaw config set agents.defaults.maxConcurrent 1
```

### Slow Responses

1. Check temperature (throttling?)
2. Use faster model (Haiku)
3. Check network latency
4. Use USB SSD instead of SD

### High CPU Usage

1. Reduce concurrent agents
2. Check for runaway processes
3. Disable model discovery
4. Use lighter models

## Best Practices

1. **Start conservative** - Begin with 1 agent, scale up
2. **Monitor regularly** - Use health check weekly
3. **Backup configs** - Use backup script before changes
4. **Update carefully** - Test updates on spare Pi first
5. **Use SSD** - Best single upgrade for performance
6. **Cool it** - Add heatsink/fan for sustained loads
7. **Ethernet** - Use wired connection when possible

## See Also

- [Raspberry Pi Setup Guide](./platforms/raspberry-pi.md)
- [AWS Bedrock Guide](./providers/bedrock.md)
