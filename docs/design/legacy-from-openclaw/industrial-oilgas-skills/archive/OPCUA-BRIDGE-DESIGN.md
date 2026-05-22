# OPC-UA Bridge 详细设计

**角色**：DMZ 区唯一 OT 接口，连接 OPC-UA 服务器（Zone 0）与 Kafka（Zone 1）  
**物理位置**：数据采集 DMZ（Zone 1）  
**安全原则**：单向数据流（OT → IT），禁止从 IT 侧写回 OT  
**语言**：Python 3.11  
**依赖**：asyncua、aiokafka、prometheus-client

---

## 一、目录结构

```
opcua-bridge/
├── main.py                 # 入口：启动所有 Subscription
├── config.py               # Pydantic Settings（读环境变量）
├── bridge.py               # OPC-UA → Kafka 核心逻辑
├── session.py              # OPC-UA Session 管理（断线重连）
├── mapping.py              # NodeId → equipment_id 映射表
├── health.py               # HTTP /health 接口（让 Docker 健康检查）
├── metrics.py              # Prometheus 指标（采集延迟、丢包率）
├── Dockerfile
├── requirements.txt
└── node_map/
    └── cng_station_nodes.json  # 节点映射文件（按场站维护）
```

---

## 二、config.py

```python
# opcua-bridge/config.py
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # OPC-UA 服务器（Zone 0）
    opcua_url: str = "opc.tcp://192.168.10.100:4840"
    opcua_username: str = ""
    opcua_password: str = ""
    opcua_security_mode: str = "SignAndEncrypt"  # None | Sign | SignAndEncrypt
    opcua_security_policy: str = "Basic256Sha256"

    # Kafka（Zone 1）
    kafka_brokers: str = "kafka:9092"
    kafka_topic_realtime: str = "opcua.realtime"     # 实时采集数据
    kafka_topic_events:   str = "opcua.events"       # 报警/事件

    # 采样间隔
    subscription_interval_ms: int = 1000   # 数据变化订阅检查周期（OPC-UA Subscription）
    poll_interval_sec: int = 5             # 无订阅时的轮询周期

    # 节点映射文件
    node_map_path: str = "node_map/cng_station_nodes.json"

    # 健康检查端口
    health_port: int = 8090

    class Config:
        env_file = ".env"

settings = Settings()
```

---

## 三、节点映射文件（node_map/cng_station_nodes.json）

```json
{
  "station_id": "STATION-CNG-001",
  "description": "天然气压缩机场站节点映射",
  "nodes": [
    {
      "node_id": "ns=2;s=C001.AxialVibration",
      "equipment_id": "C-001",
      "metric": "axial_vibration",
      "unit": "mm/s",
      "data_type": "Float",
      "description": "C-001 轴向振动"
    },
    {
      "node_id": "ns=2;s=C001.OutletPressure",
      "equipment_id": "C-001",
      "metric": "outlet_pressure",
      "unit": "MPa",
      "data_type": "Float",
      "description": "C-001 出口压力"
    },
    {
      "node_id": "ns=2;s=C001.DischargeTemp",
      "equipment_id": "C-001",
      "metric": "discharge_temperature",
      "unit": "°C",
      "data_type": "Float",
      "description": "C-001 排气温度"
    },
    {
      "node_id": "ns=2;s=SDV001.Position",
      "equipment_id": "SDV-001",
      "metric": "valve_position",
      "unit": "%",
      "data_type": "Float",
      "description": "SDV-001 阀位"
    },
    {
      "node_id": "ns=2;s=PI001.Pressure",
      "equipment_id": "PI-001",
      "metric": "inlet_pressure",
      "unit": "MPa",
      "data_type": "Float",
      "description": "PI-001 进站压力"
    }
  ]
}
```

---

## 四、bridge.py（核心逻辑）

```python
# opcua-bridge/bridge.py
import asyncio
import json
import time
from datetime import datetime, UTC
from asyncua import Client, Node
from asyncua.common.subscription import SubHandler
from aiokafka import AIOKafkaProducer
import logging

from config import settings
from mapping import load_node_map
from metrics import record_latency, record_error

logger = logging.getLogger(__name__)


class OpcUaDataHandler(SubHandler):
    """OPC-UA Subscription 回调处理器"""

    def __init__(self, producer: AIOKafkaProducer, node_map: dict):
        self.producer = producer
        self.node_map = node_map   # node_id → {equipment_id, metric, unit, station_id}

    def datachange_notification(self, node: Node, val, data):
        """OPC-UA 数据变化时触发（在 asyncua 内部线程调用）"""
        asyncio.create_task(self._handle_change(node, val, data))

    async def _handle_change(self, node: Node, val, data):
        node_id_str = str(node.nodeid)
        mapping = self.node_map.get(node_id_str)
        if not mapping:
            logger.warning(f"未知 NodeId: {node_id_str}")
            return

        # 构建标准消息
        message = {
            "station_id":    mapping["station_id"],
            "equipment_id":  mapping["equipment_id"],
            "metric":        mapping["metric"],
            "value":         float(val) if val is not None else None,
            "unit":          mapping["unit"],
            "quality":       data.monitored_item_id,  # OPC-UA 质量码
            "source_ts":     data.source_timestamp.isoformat() if data.source_timestamp else None,
            "bridge_ts":     datetime.now(UTC).isoformat(),
            "node_id":       node_id_str,
        }

        start = time.monotonic()
        await self.producer.send(
            settings.kafka_topic_realtime,
            key=f"{mapping['equipment_id']}:{mapping['metric']}".encode(),
            value=json.dumps(message).encode("utf-8"),
        )
        record_latency(time.monotonic() - start)


async def run_bridge():
    """Bridge 主循环，带自动重连"""
    node_map = load_node_map(settings.node_map_path)
    producer = AIOKafkaProducer(bootstrap_servers=settings.kafka_brokers)
    await producer.start()

    retry_delay = 5  # 初始重连等待秒数

    while True:
        try:
            logger.info(f"连接 OPC-UA: {settings.opcua_url}")
            async with Client(url=settings.opcua_url) as client:
                # 安全策略（生产环境必须 SignAndEncrypt）
                if settings.opcua_security_mode != "None":
                    await client.set_security_string(
                        f"{settings.opcua_security_policy},{settings.opcua_security_mode},"
                        "cert/bridge.crt,cert/bridge.key,cert/opcua_server.crt"
                    )
                    await client.connect()

                handler = OpcUaDataHandler(producer, node_map)
                subscription = await client.create_subscription(
                    settings.subscription_interval_ms, handler
                )

                # 订阅所有配置的节点
                nodes = [
                    client.get_node(node_id)
                    for node_id in node_map.keys()
                ]
                await subscription.subscribe_data_change(nodes)
                logger.info(f"已订阅 {len(nodes)} 个节点")

                retry_delay = 5  # 连接成功后重置重连延迟

                # 保持连接，直到异常
                while True:
                    await asyncio.sleep(60)
                    # 心跳检查（asyncua 内部会处理 keep-alive）

        except Exception as e:
            record_error(type(e).__name__)
            logger.error(f"OPC-UA 连接断开: {e}，{retry_delay}s 后重连...")
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 120)  # 指数退避，最大 2 分钟

    await producer.stop()
```

---

## 五、Kafka 消息格式（标准化）

Platform 的 Kafka Consumer 消费此 Topic，写入 PostgreSQL `equipment_readings` 表。

**Topic**: `opcua.realtime`  
**Key**: `{equipment_id}:{metric}` (用于 Kafka 分区，同一设备同一指标进同一分区)

```json
{
  "station_id": "STATION-CNG-001",
  "equipment_id": "C-001",
  "metric": "axial_vibration",
  "value": 4.2,
  "unit": "mm/s",
  "quality": 0,
  "source_ts": "2026-05-08T06:00:00.123Z",
  "bridge_ts": "2026-05-08T06:00:00.145Z",
  "node_id": "ns=2;s=C001.AxialVibration"
}
```

**quality 码约定**（OPC-UA 标准）：

- `0` = Good（正常）
- `0x40000000` = Uncertain（不确定）
- `0x80000000` = Bad（坏值，Platform 应忽略或标记）

---

## 六、Kafka Consumer（Platform 侧）

```python
# platform-api/kafka/opcua_consumer.py
"""
消费 opcua.realtime Topic，写入 TimescaleDB equipment_readings 表
同时更新 Ditto（Eclipse Ditto）数字孪生实例
"""
import json
import asyncio
from aiokafka import AIOKafkaConsumer
from db.session import AsyncSessionLocal
from models.equipment import EquipmentReading

async def start_opcua_consumer():
    consumer = AIOKafkaConsumer(
        "opcua.realtime",
        bootstrap_servers="kafka:9092",
        group_id="platform-reader",
        auto_offset_reset="latest",
        value_deserializer=lambda m: json.loads(m.decode("utf-8")),
    )
    await consumer.start()

    async for msg in consumer:
        data = msg.value
        # 忽略 Bad 质量码
        if data.get("quality", 0) & 0x80000000:
            continue

        async with AsyncSessionLocal() as db:
            reading = EquipmentReading(
                equipment_id=data["equipment_id"],
                metric=data["metric"],
                value=data["value"],
                unit=data["unit"],
                quality=data["quality"],
                source_ts=data["source_ts"],
                station_id=data["station_id"],
            )
            db.add(reading)
            await db.commit()
```

---

## 七、Phase A Mock 模式（无实物时开发调试）

当没有真实 OPC-UA 服务器时，用 `opcua-mock-server` 替代：

```python
# tools/opcua-mock-server.py
"""
本地 OPC-UA 服务器，模拟真实场站数据
开发调试专用，Phase A 必备工具
用法：python tools/opcua-mock-server.py
"""
import asyncio
import math
import random
from asyncua import Server

async def main():
    server = Server()
    await server.init()
    server.set_endpoint("opc.tcp://0.0.0.0:4840/freeopcua/server/")

    uri = "http://clawtwin.local"
    idx = await server.register_namespace(uri)

    objects = server.nodes.objects
    station = await objects.add_object(idx, "STATION-CNG-001")

    # 创建变量节点
    c001_vibration = await station.add_variable(idx, "C001.AxialVibration", 1.0)
    c001_pressure  = await station.add_variable(idx, "C001.OutletPressure", 6.0)
    c001_temp      = await station.add_variable(idx, "C001.DischargeTemp", 75.0)
    sdv001_pos     = await station.add_variable(idx, "SDV001.Position", 100.0)
    pi001_pressure = await station.add_variable(idx, "PI001.Pressure", 4.5)

    await server.start()
    print("OPC-UA Mock Server 启动: opc.tcp://localhost:4840")

    t = 0
    async with server:
        while True:
            t += 1
            # 正弦波模拟 + 随机噪声
            vib = 2.0 + 1.5 * math.sin(t * 0.1) + random.gauss(0, 0.1)
            pres = 6.0 + 0.3 * math.sin(t * 0.05) + random.gauss(0, 0.05)
            temp = 75.0 + 5.0 * math.sin(t * 0.03)

            await c001_vibration.write_value(round(vib, 2))
            await c001_pressure.write_value(round(pres, 2))
            await c001_temp.write_value(round(temp, 1))
            await asyncio.sleep(1)

asyncio.run(main())
```

---

## 八、安全要求（生产环境）

| 要求                    | 实现                                                 |
| ----------------------- | ---------------------------------------------------- |
| OT 侧只允许 Bridge 连接 | 在 OPC-UA 服务器白名单仅放 Bridge IP                 |
| 证书认证                | 客户端证书放在 `opcua-bridge/cert/`，Dockerfile 挂载 |
| 加密传输                | `SecurityMode=SignAndEncrypt` + `Basic256Sha256`     |
| 单向数据流              | Bridge 只 Subscribe（读），禁止 Write 指令           |
| Kafka TLS               | 生产环境 Kafka 启用 TLS（`kafka:9093`）              |
| 网络隔离                | Bridge 容器 `network_mode: none` 除了两个固定端点    |
| 日志                    | 所有连接/断开/异常写结构化日志（JSON），不写明文密码 |

---

## 九、健康检查端点

```python
# opcua-bridge/health.py
from fastapi import FastAPI
from metrics import get_stats

app = FastAPI()

@app.get("/health")
async def health():
    stats = get_stats()
    return {
        "status": "ok" if stats["connected"] else "degraded",
        "opcua_connected": stats["connected"],
        "messages_sent_1h": stats["messages_1h"],
        "last_message_ts": stats["last_ts"],
        "error_count_1h": stats["errors_1h"],
    }
```

Docker Compose healthcheck：

```yaml
opcua-bridge:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8090/health"]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 10s
```
