#!/bin/bash
# Monitor Raspberry Pi performance for OpenClaw
# Displays CPU, memory, temperature, and service status

echo "🍓 Raspberry Pi OpenClaw Monitor"
echo "================================="
echo ""

# System info
echo "📊 System Information:"
echo "   Hostname: $(hostname)"
echo "   OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo "   Kernel: $(uname -r)"
echo "   Architecture: $(uname -m)"
echo ""

# CPU info
echo "💻 CPU:"
CPU_MODEL=$(cat /proc/cpuinfo | grep "Model" | head -1 | cut -d':' -f2 | xargs)
CPU_CORES=$(nproc)
CPU_FREQ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null | awk '{printf "%.0f MHz", $1/1000}')
echo "   Model: $CPU_MODEL"
echo "   Cores: $CPU_CORES"
echo "   Frequency: ${CPU_FREQ:-N/A}"

# CPU load
LOAD=$(uptime | awk -F'load average:' '{print $2}')
echo "   Load Average:$LOAD"
echo ""

# Memory
echo "💾 Memory:"
free -h | grep -E "Mem|Swap" | awk '{printf "   %-6s Total: %6s  Used: %6s  Free: %6s  Avail: %6s\n", $1, $2, $3, $4, $7}'
echo ""

# Temperature
echo "🌡️  Temperature:"
if command -v vcgencmd &> /dev/null; then
    TEMP=$(vcgencmd measure_temp | cut -d'=' -f2)
    TEMP_NUM=$(echo $TEMP | cut -d"'" -f1)

    if (( $(echo "$TEMP_NUM > 80" | bc -l) )); then
        echo "   ⚠️  $TEMP (HIGH - consider cooling)"
    elif (( $(echo "$TEMP_NUM > 70" | bc -l) )); then
        echo "   ⚠️  $TEMP (Warm)"
    else
        echo "   ✅ $TEMP (Normal)"
    fi

    # Check throttling
    THROTTLE=$(vcgencmd get_throttled | cut -d'=' -f2)
    if [ "$THROTTLE" != "0x0" ]; then
        echo "   ⚠️  Throttling detected: $THROTTLE"
    fi
else
    echo "   N/A (vcgencmd not available)"
fi
echo ""

# Disk usage
echo "💿 Disk Usage:"
df -h / | tail -1 | awk '{printf "   Root: %s / %s (%s used)\n", $3, $2, $5}'
if [ -d ~/.openclaw ]; then
    OPENCLAW_SIZE=$(du -sh ~/.openclaw 2>/dev/null | cut -f1)
    echo "   OpenClaw data: $OPENCLAW_SIZE"
fi
echo ""

# OpenClaw service status
echo "🦞 OpenClaw Service:"
if systemctl --user is-active openclaw-gateway.service &> /dev/null; then
    echo "   ✅ Running"
    UPTIME=$(systemctl --user show openclaw-gateway.service --property=ActiveEnterTimestamp | cut -d'=' -f2)
    echo "   Started: $UPTIME"

    # Memory usage
    if command -v ps &> /dev/null; then
        OPENCLAW_PID=$(pgrep -f "openclaw" | head -1)
        if [ -n "$OPENCLAW_PID" ]; then
            OPENCLAW_MEM=$(ps -p $OPENCLAW_PID -o rss= | awk '{printf "%.1f MB", $1/1024}')
            OPENCLAW_CPU=$(ps -p $OPENCLAW_PID -o %cpu= | xargs)
            echo "   Memory: $OPENCLAW_MEM"
            echo "   CPU: ${OPENCLAW_CPU}%"
        fi
    fi
elif systemctl --user is-enabled openclaw-gateway.service &> /dev/null; then
    echo "   ⚠️  Enabled but not running"
    echo "   Start with: systemctl --user start openclaw-gateway.service"
else
    echo "   ℹ️  Service not installed"
    echo "   Install with: openclaw onboard --install-daemon"
fi
echo ""

# Network
echo "🌐 Network:"
IP=$(hostname -I | awk '{print $1}')
echo "   IP Address: $IP"
if command -v ping &> /dev/null; then
    if ping -c 1 -W 2 8.8.8.8 &> /dev/null; then
        echo "   Internet: ✅ Connected"
    else
        echo "   Internet: ❌ Disconnected"
    fi
fi
echo ""

# Suggestions
echo "💡 Optimization Tips:"
if (( $(echo "$TEMP_NUM > 75" | bc -l) )); then
    echo "   - Add heatsink or fan for better cooling"
fi

FREE_MEM=$(free | grep Mem | awk '{print $7}')
if [ $FREE_MEM -lt 512000 ]; then
    echo "   - Consider adding swap or reducing concurrent agents"
fi

if ! grep -q "gpu_mem=16" /boot/config.txt 2>/dev/null; then
    echo "   - Set gpu_mem=16 in /boot/config.txt for headless setup"
fi

echo ""
echo "📊 Live monitoring:"
echo "   CPU/Memory: htop"
echo "   Temperature: watch -n 1 vcgencmd measure_temp"
echo "   Logs: journalctl --user -u openclaw-gateway -f"
