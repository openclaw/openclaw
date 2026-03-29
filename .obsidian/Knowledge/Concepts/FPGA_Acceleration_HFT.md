# FPGA Acceleration for HFT

#v16_knowledge #hft #fpga #latency #hardware

## Table of Contents

- [Why FPGA in HFT](#why-fpga-in-hft)
- [FPGA vs CPU vs GPU](#fpga-vs-cpu-vs-gpu)
- [Common HFT FPGA Architectures](#common-hft-fpga-architectures)
- [Market Data Processing Pipeline](#market-data-processing-pipeline)
- [Order Entry Acceleration](#order-entry-acceleration)
- [Development Workflow](#development-workflow)

## Why FPGA in HFT

FPGA (Field-Programmable Gate Array) обеспечивает **детерминированную** задержку на уровне наносекунд:

```
Software (CPU):  Parse packet → Decode → Strategy → Encode → Send  ~5-50μs
FPGA:            All in hardware pipeline, single clock domain      ~0.1-1μs
```

> «The key advantage of FPGA is not raw speed but determinism. A software system with 5μs average latency might spike to 100μs under load. An FPGA system at 500ns maintains that latency regardless of load.» — "FPGA-Based Trading Systems" by David Thomas

## FPGA vs CPU vs GPU

| Параметр         | FPGA          | CPU            | GPU             |
| ---------------- | ------------- | -------------- | --------------- |
| Latency          | 100ns-1μs     | 5-50μs         | 10-100μs        |
| Determinism      | Нс-уровень    | Jitter ±10μs   | Jitter ±50μs    |
| Throughput       | 10-100 Gbps   | 1-10 Gbps      | 10-50 Gbps      |
| Power            | 10-35W        | 65-250W        | 150-350W        |
| Dev time         | Месяцы        | Дни            | Недели          |
| Cost (dev board) | $2-10K        | $500           | $1-2K           |
| Best for         | Tick-to-trade | Strategy logic | Batch analytics |

## Common HFT FPGA Architectures

### 1. NIC-integrated (Solarflare/Xilinx)

```
Network → FPGA on NIC → PCIe → CPU (strategy only)
          ↑ Market data parsing
          ↑ TCP/UDP offload
          ↑ Timestamping (ns precision)
```

### 2. Bump-in-the-wire

```
Exchange → FPGA → Strategy FPGA → Exchange
           ↑ Full tick-to-trade in hardware
           ↑ Sub-microsecond latency
```

### 3. Hybrid CPU+FPGA

```
Market Data → FPGA (parse, filter) → CPU (complex strategy) → FPGA (order encode, send)
```

## Market Data Processing Pipeline

Типичный FPGA pipeline для парсинга FIX/ITCH:

```verilog
// Simplified FPGA market data parser (Verilog-like pseudocode)
module market_data_parser (
    input  wire        clk,
    input  wire [63:0] raw_data,
    input  wire        data_valid,
    output reg  [63:0] price,
    output reg  [31:0] quantity,
    output reg         tick_valid
);
    // Pipeline stage 1: Field extraction (1 clock cycle)
    // Pipeline stage 2: BCD to binary conversion (1 clock cycle)
    // Pipeline stage 3: Output valid tick (1 clock cycle)
    // Total: 3 clock cycles @ 250MHz = 12ns
endmodule
```

## Order Entry Acceleration

```
Strategy decision → FPGA order builder → TCP checksum → NIC TX
Total: ~200-500ns (vs 5-20μs через software stack)
```

## Development Workflow

1. **Simulation**: ModelSim/Vivado — верификация логики
2. **Synthesis**: Xilinx Vivado / Intel Quartus — компиляция в bitstream
3. **Place & Route**: Автоматическое размещение на кристалле (часы)
4. **Timing Closure**: Проверка что все пути укладываются в clock period
5. **Deployment**: Загрузка bitstream на FPGA через JTAG

**Для Dmarket Bot:** FPGA избыточен (REST API с ~50ms latency). Актуально для crypto CEX с FIX/WebSocket и sub-ms требованиями.

---

_Сгенерировано Knowledge Expansion v16.5_
