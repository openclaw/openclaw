# TCP Tuning & Socket Optimization for Trading

#v16_knowledge #hft #tcp #latency #networking

## Table of Contents

- [Critical Socket Options](#critical-socket-options)
- [TCP_NODELAY (Nagle Algorithm)](#tcp_nodelay)
- [Kernel Buffer Tuning](#kernel-buffer-tuning)
- [CPU Affinity & IRQ Pinning](#cpu-affinity--irq-pinning)
- [Python Async Socket Optimization](#python-async-socket-optimization)
- [Rust TCP Optimization](#rust-tcp-optimization)

## Critical Socket Options

| Опция        | Значение | Эффект                                  |
| ------------ | -------- | --------------------------------------- |
| TCP_NODELAY  | 1        | Отключает Nagle (отправка без задержки) |
| TCP_QUICKACK | 1        | Немедленный ACK (отключает delayed ACK) |
| SO_KEEPALIVE | 1        | Обнаружение мёртвых соединений          |
| SO_RCVBUF    | 4MB      | Увеличенный receive buffer              |
| SO_SNDBUF    | 4MB      | Увеличенный send buffer                 |
| SO_PRIORITY  | 6        | Высокий приоритет в QoS                 |
| IP_TOS       | 0x10     | DSCP для low-delay                      |

## TCP_NODELAY

Nagle algorithm буферизирует маленькие пакеты (~200ms) — **катастрофа для HFT:**

```python
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_QUICKACK, 1)
```

> «Nagle's algorithm was designed for telnet-era networks. In trading systems, it adds 200ms of latency — an eternity. Always set TCP_NODELAY.» — Stevens, "Unix Network Programming"

## Kernel Buffer Tuning

```bash
# /etc/sysctl.conf for trading server
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 1048576 16777216
net.ipv4.tcp_wmem = 4096 1048576 16777216
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_no_metrics_save = 1
net.core.netdev_max_backlog = 50000
```

## CPU Affinity & IRQ Pinning

Привязка NIC прерываний к выделенному ядру:

```bash
# Pin NIC IRQ to CPU core 2
echo 4 > /proc/irq/$(cat /proc/interrupts | grep eth0 | awk '{print $1}' | tr -d ':')/smp_affinity

# Pin trading process to CPU core 3
taskset -c 3 ./trading_engine
```

## Python Async Socket Optimization

```python
import aiohttp

def create_optimized_connector() -> aiohttp.TCPConnector:
    """Create aiohttp connector optimized for HFT API calls."""
    return aiohttp.TCPConnector(
        limit=100,             # Max concurrent connections
        limit_per_host=20,     # Per-host limit
        ttl_dns_cache=300,     # DNS cache 5 min
        use_dns_cache=True,
        keepalive_timeout=30,  # Reuse connections
        enable_cleanup_closed=True,
        force_close=False,     # Keep-alive
    )

async def fast_api_call(session: aiohttp.ClientSession, url: str, data: dict):
    """Low-latency API call with connection reuse."""
    async with session.post(
        url, json=data,
        timeout=aiohttp.ClientTimeout(total=5, connect=1),
    ) as resp:
        return await resp.json()
```

## Rust TCP Optimization

```rust
use tokio::net::TcpStream;
use socket2::{Socket, Domain, Type, Protocol};

fn create_fast_socket() -> std::io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_nodelay(true)?;
    socket.set_recv_buffer_size(4 * 1024 * 1024)?;  // 4MB
    socket.set_send_buffer_size(4 * 1024 * 1024)?;
    socket.set_keepalive(true)?;
    Ok(socket)
}
```

---

_Сгенерировано Knowledge Expansion v16.5_
