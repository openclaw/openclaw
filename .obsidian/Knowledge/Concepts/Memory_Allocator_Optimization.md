# Memory Allocator Optimization for Low-Latency Systems

#v16_knowledge #hft #memory #latency #allocator

## Table of Contents

- [Why Allocators Matter](#why-allocators-matter)
- [Arena / Bump Allocators](#arena-allocators)
- [jemalloc vs mimalloc vs tcmalloc](#jemalloc-vs-mimalloc-vs-tcmalloc)
- [Rust Allocator Patterns](#rust-allocator-patterns)
- [Python Memory Optimization](#python-memory-optimization)
- [Object Pool Pattern](#object-pool-pattern)

## Why Allocators Matter

Стандартный `malloc()` в hot path может добавить **1-10μs jitter** из-за:

- Системного вызова `brk()`/`mmap()` для получения памяти от ОС
- Блокировок в мульти-потоковом аллокаторе
- Фрагментации — поиск свободного блока подходящего размера

> «In latency-critical paths, every allocation is a potential jitter source. Pre-allocate, pool, or use arena allocators to eliminate allocation from the hot path entirely.» — "Systems Performance" by Brendan Gregg

## Arena Allocators

Arena (bump allocator) — самый быстрый паттерн: все аллокации линейны, освобождение — одной операцией:

```rust
use bumpalo::Bump;

fn process_market_tick(arena: &Bump, raw: &[u8]) {
    // All allocations from arena — O(1) bump pointer
    let parsed = arena.alloc_str("AAPL");
    let prices = arena.alloc_slice_copy(&[155.0, 155.5, 156.0]);
    // ... process ...
}  // Arena reset — instant deallocation of everything

fn event_loop() {
    let arena = Bump::with_capacity(1024 * 1024); // 1MB pre-allocated
    loop {
        arena.reset(); // O(1) — просто сбрасывает указатель
        let tick = receive_tick();
        process_market_tick(&arena, &tick);
    }
}
```

## jemalloc vs mimalloc vs tcmalloc

| Аллокатор    | Avg latency | P99 latency | Thread scalability |
| ------------ | ----------- | ----------- | ------------------ |
| glibc malloc | 50ns        | 5μs         | Плохая             |
| jemalloc     | 30ns        | 500ns       | Хорошая            |
| mimalloc     | 25ns        | 300ns       | Отличная           |
| tcmalloc     | 35ns        | 400ns       | Хорошая            |
| Arena/Bump   | 5ns         | 10ns        | N/A (per-thread)   |

**Рекомендация:** mimalloc для general-purpose, arena для hot path.

```rust
// Rust: Use mimalloc globally
use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;
```

## Rust Allocator Patterns

### SmallVec (stack-first allocation)

```rust
use smallvec::SmallVec;

// First 8 elements on stack, heap only if overflow
let mut orders: SmallVec<[Order; 8]> = SmallVec::new();
orders.push(Order::new()); // No heap allocation for ≤8 elements
```

### ArrayVec (stack-only, no heap ever)

```rust
use arrayvec::ArrayVec;

let mut book: ArrayVec<(f64, f64), 32> = ArrayVec::new();
book.push((155.0, 100.0)); // Stack only — zero latency jitter
```

## Python Memory Optimization

```python
import array
from collections import deque

# Use array.array instead of list for numeric data
prices = array.array('d')  # C-level double array
prices.append(155.42)

# Pre-sized deque for order book snapshots
order_cache = deque(maxlen=1000)  # Fixed size, O(1) append/popleft

# __slots__ to reduce per-instance memory
class Tick:
    __slots__ = ('price', 'volume', 'timestamp')
    def __init__(self, price: float, volume: int, timestamp: int):
        self.price = price
        self.volume = volume
        self.timestamp = timestamp
```

## Object Pool Pattern

```python
class OrderPool:
    """Pre-allocated object pool to avoid GC pressure."""

    def __init__(self, size: int = 1000):
        self._pool = [Order() for _ in range(size)]
        self._available = list(range(size))

    def acquire(self) -> Order:
        idx = self._available.pop()
        return self._pool[idx]

    def release(self, order: Order):
        order.reset()
        self._available.append(self._pool.index(order))
```

---

_Сгенерировано Knowledge Expansion v16.5_
