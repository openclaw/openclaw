---
name: sysmon
description: Monitor system resources — CPU, memory, disk, network, and processes (no extra tools required).
metadata: {"moltbot":{"emoji":"📊","requires":{"bins":["bash"]}}}
---

# sysmon

Report on host resource usage using standard Unix tools. Works on macOS and Linux with no extra installs.

## Trigger

Use this skill when the user asks about system health, resource usage, performance, or anything like "how's my server doing?", "am I running low on disk?", "what's eating my CPU?", or "show me system stats".

## Quick Overview (one-liner)

```bash
echo "$(uname -n) | up $(uptime | sed 's/.*up //' | sed 's/,  *[0-9]* user.*//')  | load $(uptime | awk -F'load averages?: ' '{print $2}')"
```

## CPU

### Load averages (1/5/15 min)
```bash
uptime
```

### Top CPU consumers
```bash
ps aux --sort=-%cpu 2>/dev/null | head -11 || ps aux -r | head -11
```

### CPU core count
```bash
nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null
```

## Memory

### macOS
```bash
vm_stat | awk '
  /Pages free/     {free=$3}
  /Pages active/   {active=$3}
  /Pages inactive/ {inactive=$3}
  /Pages speculative/ {spec=$3}
  /page size of/   {ps=$8}
  END {
    ps=ps+0; if(ps==0) ps=16384;
    gsub(/\./,"",free); gsub(/\./,"",active); gsub(/\./,"",inactive); gsub(/\./,"",spec);
    total=(free+active+inactive+spec)*ps/1073741824;
    used=(active)*ps/1073741824;
    printf "Used: %.1f GB | Free: %.1f GB | Total: ~%.1f GB\n", used, free*ps/1073741824, total
  }'
```

### Linux
```bash
free -h
```

### Top memory consumers
```bash
ps aux --sort=-%mem 2>/dev/null | head -11 || ps aux -m | head -11
```

## Disk

### Usage summary
```bash
df -h | grep -E '^/|^Filesystem'
```

### Largest directories (current mount)
```bash
du -sh /* 2>/dev/null | sort -rh | head -10
```

### Inode usage (Linux)
```bash
df -i | grep -E '^/|^Filesystem'
```

## Network

### Active connections summary
```bash
netstat -an 2>/dev/null | awk '/^tcp/ {s[$NF]++} END {for(k in s) print k, s[k]}' | sort -k2 -rn
```

### Listening ports
```bash
lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR==1 || !seen[$2]++ {print}' || ss -tlnp 2>/dev/null
```

### External IP
```bash
curl -s --max-time 5 ifconfig.me
```

## Processes

### Process count
```bash
ps aux | wc -l | awk '{print $1 - 1, "processes"}'
```

### Zombie processes
```bash
ps aux | awk '$8 ~ /Z/ {print}' | head -5
```

### Uptime and logged-in users
```bash
uptime && who
```

## Docker (if present)

### Running containers
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not available"
```

### Container resource usage
```bash
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null
```

## Tips

- Combine sections for a full report; omit irrelevant ones (e.g., skip Docker if not used).
- On macOS, `vm_stat` reports in pages (usually 16 KB); the awk snippet above converts to GB.
- For repeated monitoring, suggest the user install `htop`, `btop`, or `glances` for an interactive TUI.
- When disk is above 85%, flag it as a warning.
- When load average exceeds the core count, the system may be under pressure.
