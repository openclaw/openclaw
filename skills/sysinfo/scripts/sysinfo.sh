#!/usr/bin/env bash
# sysinfo.sh — Quick system resource overview
set -euo pipefail

SECTION="${1:-all}"

bar() {
  local pct=$1 width=20
  local filled=$((pct * width / 100))
  local empty=$((width - filled))
  local warn=""
  [[ $pct -ge 80 ]] && warn=" ⚠️"
  printf "[%s%s] %d%%%s" "$(printf '█%.0s' $(seq 1 $filled 2>/dev/null) || true)" "$(printf '░%.0s' $(seq 1 $empty 2>/dev/null) || true)" "$pct" "$warn"
}

section_uptime() {
  echo "## ⏱️ Uptime"
  uptime -p 2>/dev/null || uptime
  echo ""
}

section_cpu() {
  echo "## 🧠 CPU"
  if [[ -f /proc/cpuinfo ]]; then
    local cores=$(grep -c ^processor /proc/cpuinfo)
    local model=$(grep "model name" /proc/cpuinfo | head -1 | cut -d: -f2 | xargs)
    echo "Model: ${model}"
    echo "Cores: ${cores}"
  else
    sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Unknown CPU"
    echo "Cores: $(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo '?')"
  fi
  echo "Load avg: $(cat /proc/loadavg 2>/dev/null | cut -d' ' -f1-3 || uptime | grep -oP 'load average[s]?: .+' || echo 'N/A')"
  echo ""
}

section_memory() {
  echo "## 💾 Memory"
  if command -v free &>/dev/null; then
    local total used pct
    read -r total used <<< $(free -m | awk '/^Mem:/ {print $2, $3}')
    pct=$((used * 100 / total))
    echo "RAM: ${used}MB / ${total}MB $(bar $pct)"
    
    read -r stotal sused <<< $(free -m | awk '/^Swap:/ {print $2, $3}')
    if [[ "$stotal" -gt 0 ]]; then
      spct=$((sused * 100 / stotal))
      echo "Swap: ${sused}MB / ${stotal}MB $(bar $spct)"
    else
      echo "Swap: None"
    fi
  else
    vm_stat 2>/dev/null | head -10 || echo "Memory info unavailable"
  fi
  echo ""
}

section_disk() {
  echo "## 💽 Disk"
  df -h --output=target,size,used,avail,pcent 2>/dev/null | grep -E '^(/|Mounted)' || df -h | grep -E '^(/dev|Filesystem)'
  echo ""
}

section_network() {
  echo "## 🌐 Network"
  if command -v ip &>/dev/null; then
    ip -4 addr show | grep -oP 'inet \K[\d.]+(?=/)' | while read -r ip; do
      iface=$(ip -4 addr | grep "$ip" | awk '{print $NF}')
      echo "${iface}: ${ip}"
    done
  elif command -v ifconfig &>/dev/null; then
    ifconfig | grep "inet " | awk '{print $2}'
  fi
  echo ""
  echo "Active connections: $(ss -tun 2>/dev/null | tail -n +2 | wc -l || netstat -tun 2>/dev/null | tail -n +3 | wc -l || echo '?')"
  echo ""
}

section_processes() {
  echo "## 📊 Top Processes"
  echo "**By CPU:**"
  ps aux --sort=-%cpu 2>/dev/null | head -6 | awk 'NR==1{printf "%-10s %5s %5s %s\n", "USER", "CPU%", "MEM%", "COMMAND"} NR>1{printf "%-10s %5s %5s %s\n", $1, $3, $4, $11}' || ps aux | head -6
  echo ""
  echo "**By Memory:**"
  ps aux --sort=-%mem 2>/dev/null | head -6 | awk 'NR==1{printf "%-10s %5s %5s %s\n", "USER", "CPU%", "MEM%", "COMMAND"} NR>1{printf "%-10s %5s %5s %s\n", $1, $3, $4, $11}' || true
  echo ""
}

section_docker() {
  echo "## 🐳 Docker"
  if command -v docker &>/dev/null; then
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not running or no permission"
  else
    echo "Docker not installed"
  fi
  echo ""
}

case "$SECTION" in
  all)
    section_uptime
    section_cpu
    section_memory
    section_disk
    section_network
    section_processes
    section_docker
    ;;
  cpu) section_cpu ;;
  memory) section_memory ;;
  disk) section_disk ;;
  network) section_network ;;
  processes) section_processes ;;
  uptime) section_uptime ;;
  docker) section_docker ;;
  *)
    echo "Unknown section: $SECTION"
    echo "Available: all, cpu, memory, disk, network, processes, uptime, docker"
    exit 1
    ;;
esac
