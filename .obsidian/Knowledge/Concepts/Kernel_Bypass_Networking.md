# Kernel Bypass Networking for HFT

#v16_knowledge #hft #kernel_bypass #latency #networking

## Table of Contents

- [Why Kernel Bypass](#why-kernel-bypass)
- [DPDK (Data Plane Development Kit)](#dpdk)
- [io_uring](#io_uring)
- [XDP (eXpress Data Path)](#xdp)
- [Comparison Matrix](#comparison-matrix)

## Why Kernel Bypass

Стандартный сетевой стек Linux добавляет **10-50μs** задержки на каждый пакет:

```
Application → syscall → Kernel TCP/IP → NIC driver → NIC → Wire
             ↑~2μs    ↑~5-20μs        ↑~3-10μs
```

Kernel bypass исключает ядро из data path:

```
Application → Userspace driver → NIC → Wire
             ↑~0.5-2μs
```

> «In HFT, the difference between 50μs and 5μs latency can mean the difference between profit and loss on every trade.» — "Trading and Exchanges" by Larry Harris

## DPDK

Data Plane Development Kit от Intel — зрелый фреймворк для kernel bypass:

**Принцип работы:**

1. NIC отдаётся в userspace через UIO/VFIO
2. Hugepages для zero-copy буферов
3. Poll-mode driver (PMD) вместо прерываний
4. Lockless ring buffers для межпоточной коммуникации

```c
// DPDK packet receive loop (simplified)
while (1) {
    uint16_t nb_rx = rte_eth_rx_burst(port_id, 0, bufs, BURST_SIZE);
    for (int i = 0; i < nb_rx; i++) {
        process_packet(bufs[i]);  // No syscall, no context switch
        rte_pktmbuf_free(bufs[i]);
    }
}
```

**Латентность:** ~1-3μs end-to-end (vs 20-50μs через kernel)

## io_uring

Современная альтернатива (Linux 5.1+) — не полный bypass, но минимизирует syscalls:

```rust
// Rust io_uring example (tokio-uring)
use tokio_uring::net::TcpStream;

async fn low_latency_send(stream: &TcpStream, data: &[u8]) {
    // Single submission, batched completion
    // Avoids per-operation syscall overhead
    stream.write(data).await.unwrap();
}
```

**Латентность:** ~5-10μs (компромисс между bypass и совместимостью)

## XDP

eXpress Data Path — обработка на уровне NIC driver, до полного стека:

```
Packet → NIC → XDP hook → DROP/PASS/TX/REDIRECT
                ↑ eBPF program (~100ns)
```

Используется для:

- Ультрабыстрая фильтрация market data
- DDoS mitigation на edge
- Pre-processing перед DPDK

## Comparison Matrix

| Параметр      | DPDK            | io_uring    | XDP           | Kernel TCP  |
| ------------- | --------------- | ----------- | ------------- | ----------- |
| Latency       | 1-3μs           | 5-10μs      | 0.1-1μs       | 20-50μs     |
| Complexity    | Высокая         | Средняя     | Средняя       | Низкая      |
| Dedicated CPU | Да              | Нет         | Нет           | Нет         |
| TCP support   | Через TLDK      | Нативный    | Нет (L2/L3)   | Нативный    |
| Best for      | Order execution | General I/O | Packet filter | Prototyping |

**Для Dmarket Bot:** io_uring + epoll — оптимальный баланс (Dmarket API это HTTP REST, а не raw TCP).

---

_Сгенерировано Knowledge Expansion v16.5_
