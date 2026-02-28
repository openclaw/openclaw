"""
Section 05 -- Gateway Server
"The switchboard"
Gateway 是所有客户端与 Agent 之间的桥梁

============================================================

【本节目标】实现 OpenClaw 的网络通信层: WebSocket 网关

本节专注于"网关层"的实现, 展示如何通过 WebSocket + JSON-RPC 2.0
构建一个支持多客户端并发的实时通信服务器.

【与 s04 的关系】
┌─────────────────────────────────────────────────────────────────┐
│  s04: Multi-Channel Gateway (完整的多通道系统)                   │
│  ────────────────────────────────────────────────────────────   │
│  - 多通道抽象 (CLI/File/Discord/WhatsApp...)                    │
│  - 完整的 agent_loop (工具调用循环)                             │
│  - 消息标准化 (InboundMessage)                                  │
│  - 通道插件系统 (ChannelRegistry)                               │
│  - 本地运行, 单进程                                             │
│                                                                 │
│  s05: Gateway Server (网络层)                                   │
│  ────────────────────────────────────────────────────────────   │
│  - WebSocket 服务器 (支持多客户端并发)                          │
│  - JSON-RPC 2.0 协议 (结构化消息传递)                           │
│  - 认证和连接管理                                               │
│  - 事件推送和广播机制                                           │
│  - 简化的 agent (无工具支持, 专注演示网关逻辑)                  │
│                                                                 │
│  完整的 OpenClaw = s04 的 agent_loop + s05 的网关层               │
└─────────────────────────────────────────────────────────────────┘

【核心功能】
Gateway 负责:

1. WebSocket 连接管理
   - 接受多客户端并发连接
   - 认证验证 (Bearer Token)
   - 连接生命周期管理

2. JSON-RPC 2.0 协议处理
   - 请求解析和验证
   - 方法路由 (类似 HTTP 路由器)
   - 响应和错误处理

3. 会话管理
   - 多会话并发 (每个客户端独立会话)
   - 消息历史存储
   - 会话元数据跟踪

4. 实时事件推送
   - 服务端主动推送 (typing, done 等事件)
   - 多客户端广播 (消息同步)

【架构图】

  Browser    Mobile    CLI Client    Webhook
     |          |          |            |
     v          v          v            v
  +------------ WebSocket / HTTP ------------+
  |            GatewayServer                 |
  |  +-------------------------------------+ |
  |  | JSON-RPC 2.0 Method Router          | |
  |  |  chat.send   -> run_agent()         | |
  |  |  chat.history -> load_history()     | |
  |  |  channels.status -> get_channels()  | |
  |  |  health       -> ok                 | |
  |  +-------------------------------------+ |
  |          |                               |
  |    SessionStore  +  Agent Loop           |
  +------------------------------------------+

【JSON-RPC 2.0 协议】

请求 (客户端 -> 服务器):
  {"jsonrpc":"2.0", "id":"req-1", "method":"chat.send", "params":{"text":"hello"}}

响应 (服务器 -> 客户端):
  {"jsonrpc":"2.0", "id":"req-1", "result":{"text":"...", "session_key":"..."}}

事件 (服务器主动推送, 无 id):
  {"jsonrpc":"2.0", "method":"event", "params":{"type":"chat.delta", "text":"h"}}

【实现的 RPC 方法】
本节实现 4 个核心方法, 演示网关的本质逻辑:

1. health
   - 健康检查, 返回服务器状态

2. chat.send
   - 发送消息给 Agent, 获取回复
   - 推送 typing 和 done 事件

3. chat.history
   - 获取会话的消息历史
   - 支持分页 (limit 参数)

4. channels.status
   - 查询各通道的连接状态

真实 OpenClaw (src/gateway/server.impl.ts) 支持数十种方法:
- 会话管理: sessions.list, sessions.create, sessions.delete
- 聊天操作: chat.edit, chat.delete, chat.search
- 配置管理: config.get, config.set, config.reset
- 系统监控: metrics, logs, debug

【安全机制】
- Bearer Token 认证 (HTTP Authorization header)
- 真实 OpenClaw 还支持: TLS, 设备配对, OAuth 2.0

【运行方式】
1. 启动网关:
   python agents/s05_gateway.py

2. 测试客户端 (另一个终端):
   python agents/s05_gateway.py --test-client

【依赖】
pip install requests tenacity python-dotenv websockets

【配置】
在 .env 文件中设置:
- DEEPSEEK_API_KEY (必需)
- DEEPSEEK_DEFAULT_MODEL (默认 deepseek-chat)
- DEEPSEEK_API_BASE (默认 https://api.deepseek.com/v1)
- GATEWAY_HOST (默认 127.0.0.1)
- GATEWAY_PORT (默认 18789)
- GATEWAY_TOKEN (可选, 留空则禁用认证)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection

# 添加 agents 目录到 sys.path, 以便导入 llm_client
_agents_dir = Path(__file__).resolve().parent
if str(_agents_dir) not in sys.path:
    sys.path.insert(0, str(_agents_dir))

from llm_client import (
    load_env_if_exists,
    deepseek_chat_with_tools,
    LLMClientError,
)

# ---------------------------------------------------------------------------
# 环境与配置
# ---------------------------------------------------------------------------

load_env_if_exists()  # 从 .env 文件加载环境变量 (如果存在)

# LLM 配置 (使用 DeepSeek API, 兼容 OpenAI Chat Completions 格式)
MODEL = os.getenv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat")

# 网关配置
GATEWAY_HOST = os.getenv("GATEWAY_HOST", "127.0.0.1")  # 监听地址 (0.0.0.0 = 所有网卡)
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "18789"))  # 监听端口
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "")  # Bearer Token 认证, 留空则跳过认证

# Agent 系统提示词 (简化版, 无工具说明)
SYSTEM_PROMPT = """\
You are a helpful AI assistant running inside an OpenClaw gateway."""

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gateway")

# ---------------------------------------------------------------------------
# 工具定义 -- 简化版 
# ---------------------------------------------------------------------------
# 注意: s05 使用空工具列表, 因为本节专注于演示网关的网络通信逻辑,
# 而不是 Agent 的工具调用能力.
#
# 如果需要完整的工具支持, 应该:
# 1. 从 s04_multi_channel.py 复制完整的 TOOLS 定义
# 2. 实现对应的 tool handlers
# 3. 在 run_agent 中处理工具调用循环
#
# 这里保持简单, 让 Agent 只做纯文本对话.

TOOLS_OPENAI: list[dict[str, Any]] = []  # 空工具列表

# ---------------------------------------------------------------------------
# Session Store -- 内存会话存储
# ---------------------------------------------------------------------------
# 【简化实现】使用 dict 在内存中存储会话, 演示核心逻辑
#
# 真实 OpenClaw 使用文件系统持久化:
#   ~/.openclaw/agents/<agent_id>/sessions/*.jsonl
#   每个会话一个 JSONL 文件, 记录完整的对话历史
#
# 内存存储的局限:
#   - 重启后数据丢失
#   - 无法跨进程共享 (多实例部署)
#   - 内存占用随会话增长
#
# 生产环境应使用:
#   - 文件系统 (简单, 易调试)
#   - Redis (高性能, 支持分布式)
#   - PostgreSQL (结构化查询, 事务支持)


@dataclass
class SessionEntry:
    """会话数据结构: 存储单个会话的所有信息.
    
    每个会话包含:
    - session_key: 会话唯一标识符
    - messages: 对话历史 (OpenAI/DeepSeek 格式的消息列表)
    - created_at: 会话创建时间戳
    - last_active: 最后活跃时间戳 (用于清理过期会话)
    """
    session_key: str
    messages: list[dict[str, Any]] = field(default_factory=list)  # 使用 Any 以支持复杂消息结构
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)


class SessionStore:
    """内存会话存储: 管理所有活跃会话的生命周期.
    
    职责:
    1. 按 session_key 索引和检索会话
    2. 自动创建新会话 (懒加载模式)
    3. 提供会话历史查询接口
    
    注意: 这是简化的内存实现, 重启后数据会丢失.
    真实 OpenClaw 使用文件系统持久化 (~/.openclaw/agents/<id>/sessions/*.jsonl)
    """

    def __init__(self) -> None:
        # session_key -> SessionEntry 的映射表
        self._sessions: dict[str, SessionEntry] = {}

    def get_or_create(self, session_key: str) -> SessionEntry:
        """获取会话, 不存在则自动创建 (懒加载).
        
        这是网关的核心模式: 第一次收到某个 session_key 的消息时,
        自动创建会话, 无需客户端显式初始化.
        """
        if session_key not in self._sessions:
            self._sessions[session_key] = SessionEntry(session_key=session_key)
            log.info("session created: %s", session_key)
        return self._sessions[session_key]

    def get_history(self, session_key: str) -> list[dict[str, Any]]:
        """获取指定会话的消息历史.
        
        返回: 消息列表的副本 (避免外部修改影响内部状态)
        如果会话不存在, 返回空列表.
        """
        entry = self._sessions.get(session_key)
        if entry is None:
            return []
        return list(entry.messages)

    def list_sessions(self) -> list[str]:
        """列出所有活跃会话的 session_key."""
        return list(self._sessions.keys())


# ---------------------------------------------------------------------------
# Agent Runner -- 调用 LLM 生成回复
# ---------------------------------------------------------------------------

def run_agent(session: SessionEntry, user_text: str) -> str:
    """调用 LLM 生成回复, 并更新会话历史.
    
    流程:
    1. 将用户消息追加到会话历史
    2. 调用 DeepSeek API (传入完整历史实现多轮对话)
    3. 提取 LLM 的文本回复
    4. 将助手回复追加到会话历史
    5. 更新会话活跃时间
    
    注意: 这是简化版, 没有工具调用支持.
    真实 OpenClaw 在这里会调用完整的 agent_loop (见 s04_multi_channel.py),
    支持工具循环、流式输出、错误重试等.
    
    【API 调用】
    使用 llm_client.deepseek_chat_with_tools:
    - 兼容 OpenAI Chat Completions API
    - 支持工具调用 (虽然这里传入空工具列表)
    - 自动处理重试和错误
    """
    # 追加用户消息到历史
    session.messages.append({"role": "user", "content": user_text})
    session.last_active = time.time()

    # 调用 LLM (传入完整历史, 实现上下文记忆)
    # 注意: 异常会向上传播到 _dispatch 的 try-except 中处理
    resp = deepseek_chat_with_tools(
        session.messages,
        TOOLS_OPENAI,
        model=MODEL,
        system_prompt=SYSTEM_PROMPT,
        max_tokens=2048,
    )

    # 提取响应字段 (与 s04 保持一致的命名和提取方式)
    content = resp.get("content") or ""
    tool_calls = resp.get("tool_calls") or []
    finish_reason = resp.get("finish_reason") or "stop"

    # 追加 assistant 消息到历史 (与 s04 保持一致)
    if content:
        session.messages.append({"role": "assistant", "content": content})
    
    return content


# ---------------------------------------------------------------------------
# JSON-RPC 2.0 Protocol Helpers
# ---------------------------------------------------------------------------
#
# JSON-RPC 2.0 消息格式:
#   请求:  {"jsonrpc":"2.0", "id":"req-1", "method":"chat.send", "params":{...}}
#   响应:  {"jsonrpc":"2.0", "id":"req-1", "result":{...}}
#   错误:  {"jsonrpc":"2.0", "id":"req-1", "error":{"code":-32601, "message":"..."}}
#   事件:  {"jsonrpc":"2.0", "method":"event", "params":{"type":"chat.delta", ...}}

JSONRPC_VERSION = "2.0"


def make_result(req_id: str | int | None, result: Any) -> str:
    """构造 JSON-RPC 2.0 成功响应.
    
    格式: {"jsonrpc": "2.0", "id": req_id, "result": {...}}
    
    参数:
    - req_id: 请求 ID (与请求中的 id 对应, 用于客户端匹配响应)
    - result: 方法执行结果 (任意 JSON 可序列化对象)
    """
    return json.dumps({
        "jsonrpc": JSONRPC_VERSION,
        "id": req_id,
        "result": result,
    })


def make_error(req_id: str | int | None, code: int, message: str, data: Any = None) -> str:
    """构造 JSON-RPC 2.0 错误响应.
    
    格式: {"jsonrpc": "2.0", "id": req_id, "error": {"code": ..., "message": ...}}
    
    参数:
    - req_id: 请求 ID (可能为 None, 表示无法解析请求)
    - code: 错误码 (遵循 JSON-RPC 2.0 规范, 见下方常量定义)
    - message: 错误描述
    - data: 可选的额外错误信息
    """
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return json.dumps({
        "jsonrpc": JSONRPC_VERSION,
        "id": req_id,
        "error": err,
    })


def make_event(event_type: str, payload: dict[str, Any]) -> str:
    """构造 JSON-RPC 2.0 事件通知 (服务端主动推送).
    
    格式: {"jsonrpc": "2.0", "method": "event", "params": {"type": ..., ...}}
    
    事件与请求/响应的区别:
    - 事件没有 id 字段 (不需要客户端响应)
    - 事件由服务端主动推送 (不是对请求的回复)
    - 事件用于实时通知: 如 typing 状态, 消息送达, 连接状态变化等
    
    参数:
    - event_type: 事件类型 (如 "chat.typing", "chat.done", "connect.welcome")
    - payload: 事件数据 (会合并到 params 中)
    """
    return json.dumps({
        "jsonrpc": JSONRPC_VERSION,
        "method": "event",
        "params": {"type": event_type, **payload},
    })


# JSON-RPC 2.0 标准错误码 (遵循规范)
# 详见: https://www.jsonrpc.org/specification#error_object
PARSE_ERROR = -32700       # JSON 解析失败 (无效的 JSON 字符串)
INVALID_REQUEST = -32600   # 请求格式错误 (缺少必需字段或格式不符)
METHOD_NOT_FOUND = -32601  # 方法不存在 (未注册的 method)
INVALID_PARAMS = -32602    # 参数错误 (类型不匹配或缺少必需参数)
INTERNAL_ERROR = -32603    # 服务器内部错误 (方法执行时抛出异常)

# 自定义错误码 (规范允许 -32000 到 -32099 范围)
AUTH_ERROR = -32000        # 认证失败 (token 无效或缺失)

# ---------------------------------------------------------------------------
# Gateway Server -- 核心实现
# ---------------------------------------------------------------------------
# 【架构定位】
# 这是 OpenClaw 的"网络层", 负责客户端通信, 而不是 Agent 逻辑.
#
# 职责边界:
#   - 网关层 (s05): WebSocket 连接, JSON-RPC 路由, 认证, 广播
#   - Agent 层 (s04): 消息处理, 工具调用, 会话管理, 多通道适配
#
# 真实 OpenClaw 的网关 (src/gateway/server.impl.ts):
#   - 使用 Node.js ws 库 (高性能 WebSocket)
#   - 支持 TLS 加密 (wss://)
#   - 设备配对和身份绑定
#   - 多客户端广播和订阅过滤
#   - Protocol version 协商 (向后兼容)
#   - 连接池和负载均衡
#
# 本节简化为核心逻辑: WebSocket 服务 + 方法路由 + 会话管理


@dataclass
class ConnectedClient:
    """已连接客户端的状态跟踪.
    
    网关需要为每个 WebSocket 连接维护状态:
    - ws: WebSocket 连接对象 (用于发送消息)
    - client_id: 客户端唯一标识 (自动生成的短 UUID)
    - connected_at: 连接建立时间
    - authenticated: 认证状态 (通过 Bearer Token 验证)
    
    真实 OpenClaw 还会跟踪:
    - 客户端类型 (browser/mobile/cli)
    - 订阅的会话列表 (用于消息广播过滤)
    - 心跳状态和最后活跃时间
    """
    ws: ServerConnection
    client_id: str
    connected_at: float = field(default_factory=time.time)
    authenticated: bool = False


class GatewayServer:
    """WebSocket 网关服务器: OpenClaw 的网络通信层.
    
    【核心职责】
    1. 接受 WebSocket 连接 (支持多客户端并发)
    2. 解析 JSON-RPC 2.0 请求 (结构化协议)
    3. 路由到对应的处理方法 (方法注册表)
    4. 返回 JSON-RPC 响应或推送事件
    5. 管理会话生命周期 (SessionStore)
    6. 广播消息给所有连接的客户端
    
    【与 s04 的区别】
    s04_multi_channel.py: 实现了完整的多通道抽象 (CLI/File/Discord...)
    
    s05_gateway.py:      专注于网络层的 WebSocket + JSON-RPC 实现
                         演示如何在网关层面管理连接和路由消息
    
    【架构定位】
    s05 是"网关层"的教学实现, 展示:
    - WebSocket 连接管理
    - JSON-RPC 协议处理
    - 多客户端并发
    - 事件推送机制

    """

    def __init__(self, host: str, port: int, token: str = "") -> None:
        self.host = host
        self.port = port
        self.token = token  # 空字符串 = 不需要认证
        self.sessions = SessionStore()
        self.clients: dict[str, ConnectedClient] = {}  # client_id -> ConnectedClient
        self._start_time = time.time()

        # JSON-RPC 方法路由表: method name -> handler function
        # 这是网关的"API 注册表", 定义了客户端可以调用的所有方法
        # 真实 OpenClaw 在 server-methods-list.ts 中注册了近百个方法:
        #   - 会话管理: sessions.list, sessions.create, sessions.delete
        #   - 聊天操作: chat.send, chat.history, chat.edit, chat.delete
        #   - 通道控制: channels.status, channels.enable, channels.disable
        #   - 配置管理: config.get, config.set, config.reset
        #   - 系统监控: health, metrics, logs
        self._methods: dict[str, Any] = {
            "health": self._handle_health,
            "chat.send": self._handle_chat_send,
            "chat.history": self._handle_chat_history,
            "channels.status": self._handle_channels_status,
        }

    # -- 认证层 ----------------------------------------------------------------

    def _authenticate(self, headers: Any) -> bool:
        """验证客户端身份 (Bearer Token 认证).
        
        认证流程:
        1. 检查是否配置了 GATEWAY_TOKEN (未配置则跳过认证)
        2. 从 HTTP headers 中提取 Authorization 字段
        3. 验证格式: "Bearer <token>"
        4. 比对 token 是否匹配
        
        使用方式:
        客户端在 WebSocket 握手时需要提供 HTTP header:
          Authorization: Bearer <your-token>
        
        真实 OpenClaw 支持更多认证方式 (src/gateway/auth.ts):
        - Bearer Token (API 密钥)
        - Password (用户密码)
        - Device Pairing (设备配对, 类似 WhatsApp Web)
        - TLS Client Certificate (双向 TLS)
        - OAuth 2.0 (第三方登录)
        """
        if not self.token:
            # 未配置 token, 跳过认证 (开发模式)
            return True

        # 提取 Authorization header
        auth_header = headers.get("Authorization", "")
        if not auth_header:
            return False

        # 解析 "Bearer <token>" 格式
        parts = auth_header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False

        # 验证 token
        return parts[1].strip() == self.token

    # -- WebSocket 连接管理 ----------------------------------------------------

    async def _handle_connection(self, ws: ServerConnection) -> None:
        """处理单个 WebSocket 连接的完整生命周期.
        
        生命周期阶段:
        1. 连接建立 (WebSocket 握手完成)
        2. 认证检查 (验证 Bearer Token)
        3. 注册客户端 (分配 client_id, 加入连接池)
        4. 发送欢迎事件 (通知客户端连接成功)
        5. 消息循环 (接收并分发每条消息)
        6. 连接关闭 (清理客户端状态)
        
        这个方法会为每个连接创建一个独立的协程,
        多个客户端可以同时连接和通信 (并发处理).
        """
        # 生成客户端 ID (短 UUID, 用于日志和追踪)
        client_id = str(uuid.uuid4())[:8]

        # 阶段 1: 认证检查
        # 在连接建立后立即验证, 失败则拒绝连接
        authenticated = self._authenticate(ws.request.headers if ws.request else {})
        if not authenticated:
            error_msg = make_error(None, AUTH_ERROR, "Authentication failed")
            await ws.send(error_msg)
            await ws.close(4001, "Unauthorized")  # WebSocket 关闭码 4001 = 自定义认证失败
            log.warning("client %s: auth failed, connection rejected", client_id)
            return

        # 阶段 2: 注册客户端
        # 创建客户端状态并加入连接池
        client = ConnectedClient(ws=ws, client_id=client_id, authenticated=True)
        self.clients[client_id] = client
        log.info("client %s: connected (total: %d)", client_id, len(self.clients))

        # 阶段 3: 发送欢迎事件
        # 通知客户端连接成功, 提供 client_id 和服务器时间
        # (类似 OpenClaw 的 connect.challenge 事件, 用于协议版本协商)
        welcome = make_event("connect.welcome", {
            "client_id": client_id,
            "server_time": time.time(),
        })
        await ws.send(welcome)

        # 阶段 4: 消息循环
        # 持续接收并处理客户端发送的消息, 直到连接关闭
        try:
            async for raw_message in ws:
                # WebSocket 可能发送文本或二进制数据
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8")
                # 分发到 JSON-RPC 路由器
                await self._dispatch(client, raw_message)
        except websockets.exceptions.ConnectionClosed:
            # 正常关闭 (客户端断开或网络中断)
            pass
        finally:
            # 阶段 5: 清理
            # 从连接池中移除客户端
            del self.clients[client_id]
            log.info("client %s: disconnected (total: %d)", client_id, len(self.clients))

    async def _dispatch(self, client: ConnectedClient, raw: str) -> None:
        """JSON-RPC 请求分发器: 解析请求并路由到对应的处理方法.
        
        【核心流程】这是网关的"消息路由器", 处理每条 WebSocket 消息:
        
        1. JSON 解析
           - 将原始字符串解析为 JSON 对象
           - 解析失败 -> 返回 PARSE_ERROR (-32700)
        
        2. 协议验证
           - 检查 jsonrpc 字段是否为 "2.0"
           - 验证失败 -> 返回 INVALID_REQUEST (-32600)
        
        3. 方法路由
           - 从方法注册表 (_methods) 中查找处理器
           - 方法不存在 -> 返回 METHOD_NOT_FOUND (-32601)
        
        4. 方法执行
           - 调用处理器函数 (传入 client 和 params)
           - 成功 -> 返回 result 响应
           - 异常 -> 返回 INTERNAL_ERROR (-32603)
        
        【JSON-RPC 2.0 消息格式】
        请求:  {"jsonrpc": "2.0", "id": "req-1", "method": "chat.send", "params": {...}}
        响应:  {"jsonrpc": "2.0", "id": "req-1", "result": {...}}
        错误:  {"jsonrpc": "2.0", "id": "req-1", "error": {"code": -32601, "message": "..."}}
        
        【错误处理策略】
        - 解析错误: 无法获取 req_id, 返回 id=None 的错误响应
        - 方法错误: 捕获异常, 记录日志, 返回友好的错误消息
        - 所有错误都返回响应 (不会让客户端无限等待)
        """
        # 阶段 1: JSON 解析
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            # 无法解析 JSON, 返回协议错误
            resp = make_error(None, PARSE_ERROR, "Parse error: invalid JSON")
            await client.ws.send(resp)
            return

        # 阶段 2: 协议验证
        # 检查是否符合 JSON-RPC 2.0 规范
        if not isinstance(msg, dict) or msg.get("jsonrpc") != JSONRPC_VERSION:
            resp = make_error(msg.get("id"), INVALID_REQUEST, "Invalid JSON-RPC request")
            await client.ws.send(resp)
            return

        # 提取请求字段
        req_id = msg.get("id")        # 请求 ID (客户端用于匹配响应)
        method = msg.get("method", "")  # 方法名 (如 "chat.send")
        params = msg.get("params", {})  # 方法参数

        log.info("client %s: -> %s (id=%s)", client.client_id, method, req_id)

        # 阶段 3: 方法路由
        # 从注册表中查找对应的处理器函数
        handler = self._methods.get(method)
        if handler is None:
            resp = make_error(req_id, METHOD_NOT_FOUND, f"Method not found: {method}")
            await client.ws.send(resp)
            return

        # 阶段 4: 方法执行
        # 调用处理器, 捕获异常, 返回结果或错误
        try:
            result = await handler(client, params)
            resp = make_result(req_id, result)
        except Exception as exc:
            # 方法执行失败, 记录详细日志并返回错误
            log.exception("client %s: method %s raised error", client.client_id, method)
            resp = make_error(req_id, INTERNAL_ERROR, str(exc))

        await client.ws.send(resp)

    # -- RPC 方法实现 ----------------------------------------------------------
    # 以下是网关提供的 JSON-RPC 方法, 客户端可以通过 WebSocket 调用.
    # 每个方法接收 (client, params) 并返回 result dict.

    async def _handle_health(self, client: ConnectedClient, params: dict) -> dict:
        """RPC 方法: health -- 服务器健康检查.
        
        用途:
        - 客户端心跳检测 (定期调用确认服务器在线)
        - 监控系统健康检查 (Prometheus/Grafana)
        - 负载均衡器健康探测
        
        返回:
        - status: 服务状态 ("ok" 表示正常)
        - uptime_seconds: 服务器运行时长
        - connected_clients: 当前连接的客户端数
        - active_sessions: 活跃会话数
        
        真实 OpenClaw 还返回:
        - version: 服务器版本号
        - model_status: LLM 模型可用性
        - channel_status: 各通道连接状态
        - memory_usage: 内存使用情况
        """
        return {
            "status": "ok",
            "uptime_seconds": round(time.time() - self._start_time, 1),
            "connected_clients": len(self.clients),
            "active_sessions": len(self.sessions.list_sessions()),
        }

    async def _handle_chat_send(self, client: ConnectedClient, params: dict) -> dict:
        """RPC 方法: chat.send -- 发送消息给 Agent 并获取回复.
        
        【最核心的方法】这是网关的主要功能, 对应 OpenClaw 的 server-chat.ts
        
        参数:
        - text: 用户消息文本 (必需)
        - session_key: 会话标识 (可选, 默认 "default")
        
        流程:
        1. 参数验证 (text 不能为空)
        2. 发送 "typing" 事件 (通知客户端 Agent 正在思考)
        3. 调用 run_agent 生成回复 (LLM 调用)
        4. 广播 "done" 事件 (通知所有订阅此会话的客户端)
        5. 返回回复文本和会话元数据
        
        【事件推送】
        这个方法演示了 JSON-RPC 的事件机制:
        - typing 事件: 在 LLM 调用前推送 (让客户端显示"正在输入...")
        - done 事件: 在回复生成后广播 (多客户端同步)
        
        【多客户端同步】
        done 事件会广播给所有连接的客户端, 实现:
        - 多设备同步 (手机和电脑同时看到回复)
        - 协作模式 (多人共享同一个 Agent 会话)
        
        真实 OpenClaw 的 chat.send 还支持:
        - 流式输出 (chat.delta 事件逐字推送)
        - 工具调用 (tool.use / tool.result 事件)
        - 附件上传 (图片/文件)
        - 消息编辑和删除
        """
        # 参数验证
        text = params.get("text", "").strip()
        if not text:
            raise ValueError("Parameter 'text' is required and must be non-empty")

        session_key = params.get("session_key", "default")

        # 推送 typing 事件 (通知客户端 Agent 开始处理)
        # 这让客户端可以显示"正在输入..."状态
        typing_event = make_event("chat.typing", {
            "session_key": session_key,
        })
        await client.ws.send(typing_event)

        # 调用 Agent 生成回复
        # 这里会阻塞等待 LLM 返回 (真实系统会用异步流式处理)
        session = self.sessions.get_or_create(session_key)
        reply = run_agent(session, text)

        # 广播 done 事件给所有客户端
        # 这实现了多设备同步: 所有连接到网关的客户端都会收到这条回复
        done_event = make_event("chat.done", {
            "session_key": session_key,
            "text": reply,
        })
        await self._broadcast(done_event)

        # 返回 RPC 响应 (包含回复文本和会话元数据)
        return {
            "text": reply,
            "session_key": session_key,
            "message_count": len(session.messages),
        }

    async def _handle_chat_history(self, client: ConnectedClient, params: dict) -> dict:
        """RPC 方法: chat.history -- 获取会话的消息历史.
        
        用途:
        - 客户端初始化时加载历史消息
        - 用户切换会话时显示上下文
        - 导出对话记录
        
        参数:
        - session_key: 会话标识 (可选, 默认 "default")
        - limit: 返回的最大消息数 (可选, 默认 50)
        
        返回:
        - session_key: 会话标识
        - messages: 消息列表 (最近的 limit 条)
        - total: 会话中的总消息数
        
        【分页策略】
        只返回最近的 limit 条消息, 避免一次性传输过多数据.
        客户端可以通过多次调用实现分页加载.
        
        真实 OpenClaw 的 sessions.preview 还支持:
        - offset 参数 (分页偏移)
        - 按时间范围过滤
        - 消息搜索和过滤
        - 包含工具调用的详细信息
        """
        session_key = params.get("session_key", "default")
        limit = params.get("limit", 50)

        # 获取完整历史
        messages = self.sessions.get_history(session_key)
        
        # 截取最近的 limit 条消息 (避免传输过多数据)
        if len(messages) > limit:
            messages = messages[-limit:]

        return {
            "session_key": session_key,
            "messages": messages,
            "total": len(self.sessions.get_history(session_key)),  # 总消息数 (用于分页)
        }

    async def _handle_channels_status(self, client: ConnectedClient, params: dict) -> dict:
        """RPC 方法: channels.status -- 查询各通道的连接状态.
        
        用途:
        - 客户端显示通道连接状态 (UI 指示器)
        - 监控系统检查通道健康度
        - 调试通道连接问题
        
        返回:
        - channels: 通道状态列表, 每个通道包含:
          - id: 通道标识 (如 "websocket", "telegram", "discord")
          - status: 连接状态 ("connected", "disconnected", "error")
          - 其他通道特定的元数据 (如客户端数, 消息队列长度)
        
        【注意】这是简化的模拟实现.
        真实 OpenClaw 会:
        - 探测每个通道插件的实际连接状态
        - 返回通道配置信息 (是否启用, 速率限制等)
        - 包含通道的健康指标 (延迟, 错误率, 消息吞吐量)
        
        真实通道示例:
        - Telegram: bot token 状态, webhook URL, 消息队列
        - Discord: bot 在线状态, 已加入的服务器数
        - WhatsApp: 扫码状态, 设备配对信息
        - Slack: workspace 连接状态, 订阅的频道
        """
        return {
            "channels": [
                {"id": "websocket", "status": "connected", "clients": len(self.clients)},
                {"id": "http_webhook", "status": "listening"},
            ]
        }

    # -- 广播机制 --------------------------------------------------------------

    async def _broadcast(self, message: str) -> None:
        """向所有已连接客户端广播消息 (并发发送).
        
        【核心功能】实现多客户端同步:
        - 当一个客户端发送消息, 所有其他客户端也能实时收到回复
        - 用于多设备同步 (手机 + 电脑同时在线)
        - 用于协作模式 (多人共享同一个 Agent)
        
        【并发策略】
        使用 asyncio.gather 并发发送, 而不是串行循环:
        - 串行: 10 个客户端需要 10x 延迟
        - 并发: 所有客户端几乎同时收到消息
        
        【错误处理】
        - return_exceptions=True: 单个客户端发送失败不影响其他客户端
        - 失败的发送会被记录到日志, 但不会中断广播
        
        真实 OpenClaw 的广播系统 (server-broadcast.ts) 支持:
        - 按 session_key 过滤 (只广播给订阅了该会话的客户端)
        - 按客户端角色过滤 (如只广播给管理员)
        - 消息优先级和速率限制
        - 离线消息队列 (客户端重连后补发)
        """
        if not self.clients:
            return

        # 为每个客户端创建发送任务
        tasks = []
        for c in self.clients.values():
            tasks.append(c.ws.send(message))

        # 并发执行所有发送任务
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # 检查发送结果, 记录失败的客户端
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                log.warning("broadcast: failed to send to a client: %s", result)

    # -- HTTP Webhook 处理 -----------------------------------------------------

    async def _handle_http(self, path: str, body: dict) -> dict:
        """处理 HTTP Webhook 请求 (RESTful API 端点).
        
        【设计】网关同时支持两种通信方式:
        1. WebSocket (双向实时通信, 用于客户端 UI)
        2. HTTP (单向请求-响应, 用于外部系统集成)
        
        【HTTP 端点】
        - /health: 健康检查 (负载均衡器探测)
        - /hook/agent: 外部系统触发 Agent 运行 (如定时任务, CI/CD)
        
        【注意】这是简化实现, 只演示核心逻辑.
        真实 OpenClaw 的 HTTP 层 (server-http.ts) 还支持:
        - /hook/wake: 唤醒心跳 (防止服务器休眠)
        - /api/v1/chat/completions: OpenAI 兼容 API (让 OpenClaw 可以作为 OpenAI 的替代品)
        - /webhook/telegram: Telegram Bot API webhook
        - /webhook/slack: Slack Events API
        - /webhook/discord: Discord Bot webhook
        - /webhook/github: GitHub Actions 触发
        
        【使用示例】
        curl -X POST http://localhost:18789/hook/agent \
          -H "Content-Type: application/json" \
          -d '{"text": "hello", "session_key": "webhook-test"}'
        """
        # 健康检查端点
        if path == "/health":
            return {"status": "ok"}

        # Agent 触发端点 (外部系统调用 Agent)
        if path == "/hook/agent":
            text = body.get("text", "")
            session_key = body.get("session_key", "webhook")
            
            # 参数验证
            if not text:
                return {"error": "Missing 'text' field"}

            # 调用 Agent (与 WebSocket 的 chat.send 逻辑相同)
            session = self.sessions.get_or_create(session_key)
            reply = run_agent(session, text)
            
            return {"text": reply, "session_key": session_key}

        # 未知路径
        return {"error": f"Unknown path: {path}"}

    # -- 服务器启动 ------------------------------------------------------------

    async def start(self) -> None:
        """启动 WebSocket 服务器并进入事件循环.
        
        【启动流程】
        1. 打印启动信息 (地址, 端口, 认证状态)
        2. 创建 WebSocket 服务器 (绑定到指定地址和端口)
        3. 进入事件循环 (等待客户端连接)
        
        【事件循环】
        - websockets.serve 会为每个新连接创建一个协程
        - 每个连接由 _handle_connection 处理 (并发执行)
        - await asyncio.Future() 让服务器永久运行 (除非收到 Ctrl+C)
        
        【并发模型】
        这是异步并发 (asyncio), 不是多线程:
        - 单线程处理所有连接 (事件驱动)
        - 高效处理大量并发连接 
        - 避免线程切换开销
        
        【停止服务器】
        - Ctrl+C: 触发 KeyboardInterrupt, 优雅关闭
        - 所有活跃连接会收到关闭通知
        - 正在处理的请求会完成后再退出
        """
        log.info("Gateway starting on ws://%s:%d", self.host, self.port)
        if self.token:
            log.info("Authentication: Bearer token required")
        else:
            log.info("Authentication: disabled (no GATEWAY_TOKEN set)")

        # 创建并启动 WebSocket 服务器
        async with websockets.serve(
            self._handle_connection,  # 连接处理器 (每个连接一个协程)
            self.host,
            self.port,
        ):
            log.info("Gateway ready. Waiting for connections...")
            # 保持服务器运行 (永不完成的 Future)
            # 除非收到 Ctrl+C 或其他中断信号
            await asyncio.Future()


# ---------------------------------------------------------------------------
# 测试客户端 -- 验证网关功能
# ---------------------------------------------------------------------------

async def test_client() -> None:
    """测试客户端: 验证网关的所有核心功能.
    
    【测试流程】
    1. 连接到网关 (WebSocket 握手 + 认证)
    2. 接收欢迎事件 (验证事件推送)
    3. 调用 health 方法 (验证基础 RPC)
    4. 调用 chat.send 方法 (验证 Agent 调用)
    5. 接收 typing 和 done 事件 (验证事件流)
    6. 调用 chat.history 方法 (验证历史查询)
    7. 调用 channels.status 方法 (验证状态查询)
    8. 调用不存在的方法 (验证错误处理)
    
    【运行方式】
    终端 1: python agents/s05_gateway.py          (启动网关)
    终端 2: python agents/s05_gateway.py --test-client  (运行测试)
    
    【预期输出】
    - 欢迎事件包含 client_id
    - health 返回服务器状态
    - chat.send 返回 Agent 回复
    - chat.history 返回消息历史
    - channels.status 返回通道列表
    - 未知方法返回 METHOD_NOT_FOUND 错误
    """
    uri = f"ws://{GATEWAY_HOST}:{GATEWAY_PORT}"
    headers = {}
    if GATEWAY_TOKEN:
        # 如果配置了 token, 在握手时提供认证信息
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    print(f"[test-client] connecting to {uri} ...")

    async with websockets.connect(uri, additional_headers=headers) as ws:
        # 测试 1: 接收欢迎事件
        # 连接成功后, 服务器会主动推送 connect.welcome 事件
        welcome = json.loads(await ws.recv())
        print(f"[test-client] welcome: {json.dumps(welcome, indent=2)}")

        # 测试 2: health 方法 (健康检查)
        # 发送 JSON-RPC 请求, 等待响应
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "h-1",
            "method": "health",
            "params": {},
        }))
        health_resp = json.loads(await ws.recv())
        print(f"[test-client] health: {json.dumps(health_resp, indent=2)}")

        # 测试 3: chat.send 方法 (发送消息给 Agent)
        # 这是最核心的功能测试
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "c-1",
            "method": "chat.send",
            "params": {"text": "What is a gateway in software architecture?", "session_key": "test"},
        }))

        # 接收响应和事件
        # chat.send 会触发多条消息:
        # 1. typing 事件 (服务端推送, 无 id)
        # 2. done 事件 (服务端推送, 无 id)
        # 3. result 响应 (有 id, 与请求匹配)
        #
        # 我们需要循环接收, 直到收到匹配的 result 响应
        while True:
            raw = await ws.recv()
            msg = json.loads(raw)
            
            # 检查是否是我们等待的响应 (通过 id 匹配)
            if msg.get("id") == "c-1":
                # 这是 result 响应, 提取回复文本
                text = msg.get("result", {}).get("text", "")
                print(f"[test-client] chat.send result: {text[:200]}...")
                break
            else:
                # 这是事件 (typing/done), 打印事件类型
                event_type = msg.get("params", {}).get("type", "unknown")
                print(f"[test-client] event: {event_type}")

        # 测试 4: chat.history 方法 (获取会话历史)
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "h-2",
            "method": "chat.history",
            "params": {"session_key": "test"},
        }))
        history_resp = json.loads(await ws.recv())
        msg_count = history_resp.get("result", {}).get("total", 0)
        print(f"[test-client] chat.history: {msg_count} messages in session")

        # 测试 5: channels.status 方法 (查询通道状态)
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "s-1",
            "method": "channels.status",
            "params": {},
        }))
        status_resp = json.loads(await ws.recv())
        print(f"[test-client] channels.status: {json.dumps(status_resp.get('result', {}), indent=2)}")

        # 测试 6: 错误处理 (调用不存在的方法)
        # 验证网关能正确返回 METHOD_NOT_FOUND 错误
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "e-1",
            "method": "no.such.method",
            "params": {},
        }))
        err_resp = json.loads(await ws.recv())
        print(f"[test-client] error test: {json.dumps(err_resp.get('error', {}))}")

    print("[test-client] done")


# ---------------------------------------------------------------------------
# Main -- 程序入口
# ---------------------------------------------------------------------------

def main() -> None:
    """程序入口: 根据命令行参数启动网关或测试客户端.
    
    【运行模式】
    1. 服务器模式 (默认):
       python agents/s05_gateway.py
       启动 WebSocket 网关, 监听连接
    
    2. 测试客户端模式:
       python agents/s05_gateway.py --test-client
       连接到网关并执行测试序列
    
    【配置】
    通过环境变量配置 (.env 文件):
    - DEEPSEEK_API_KEY: DeepSeek API 密钥 (必需)
    - DEEPSEEK_DEFAULT_MODEL: 使用的模型 (默认 deepseek-chat)
    - DEEPSEEK_API_BASE: API 端点 (默认 https://api.deepseek.com/v1)
    - GATEWAY_HOST: 监听地址 (默认 127.0.0.1)
    - GATEWAY_PORT: 监听端口 (默认 18789)
    - GATEWAY_TOKEN: 认证 token (可选, 留空则禁用认证)
    
    【API 密钥检查】
    程序启动时会检查 DEEPSEEK_API_KEY 是否配置,
    未配置会提示错误并退出.
    
    【测试流程】
    先启动服务器 (终端 1), 再运行测试客户端 (终端 2),
    验证网关的所有核心功能是否正常工作.
    """
    import sys
    
    # 检查 API 密钥是否配置
    if not os.getenv("DEEPSEEK_API_KEY"):
        print("Error: DEEPSEEK_API_KEY not set.")
        print("Copy .env.example to .env and fill in your key.")
        sys.exit(1)
    
    if "--test-client" in sys.argv:
        # 测试客户端模式
        asyncio.run(test_client())
    else:
        # 服务器模式: 打印配置信息并启动网关
        print("=" * 60)
        print("  OpenClaw Mini -- Section 05: Gateway Server")
        print("  The switchboard")
        print("=" * 60)
        print(f"  Host:  {GATEWAY_HOST}")
        print(f"  Port:  {GATEWAY_PORT}")
        print(f"  Model: {MODEL}")
        print(f"  Auth:  {'Bearer token' if GATEWAY_TOKEN else 'disabled'}")
        print()
        print("  Test:  python agents/s05_gateway.py --test-client")
        print("=" * 60)
        
        # 创建并启动网关服务器
        gateway = GatewayServer(
            host=GATEWAY_HOST,
            port=GATEWAY_PORT,
            token=GATEWAY_TOKEN,
        )
        asyncio.run(gateway.start())


if __name__ == "__main__":
    main()


# ===========================================================================
# 总结: s05 Gateway Server 的核心要点
# ===========================================================================
#
# 【本节重点】
# s05 专注于"网关层"的实现, 展示如何构建一个支持多客户端并发的
# WebSocket 服务器, 使用 JSON-RPC 2.0 协议进行结构化通信.
#
# 【核心组件】
#
# 1. GatewayServer (网关服务器)
#    ├─ _handle_connection: 管理单个 WebSocket 连接的生命周期
#    ├─ _dispatch: JSON-RPC 请求路由器 (解析 -> 验证 -> 路由 -> 执行)
#    ├─ _authenticate: Bearer Token 认证
#    ├─ _broadcast: 多客户端消息广播
#    └─ _methods: RPC 方法注册表
#
# 2. SessionStore (会话存储)
#    ├─ get_or_create: 懒加载会话
#    ├─ get_history: 查询历史
#    └─ list_sessions: 列举所有会话
#
# 3. JSON-RPC 协议层
#    ├─ make_result: 构造成功响应
#    ├─ make_error: 构造错误响应
#    └─ make_event: 构造事件通知
#
# 4. RPC 方法实现
#    ├─ health: 健康检查
#    ├─ chat.send: 发送消息给 Agent
#    ├─ chat.history: 获取会话历史
#    └─ channels.status: 查询通道状态
