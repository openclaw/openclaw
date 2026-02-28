"""
OpenClaw 网关与路由系统 - 完整教程 (s05 + s06 合并版)

"From single-agent gateway to multi-agent routing"

本文件整合了 s05 (WebSocket Gateway) 和 s06 (Message Routing) 的完整实现,
展示如何从基础的网络通信层逐步扩展到多 Agent 的智能路由系统.

【架构演进】
  s05: 单一 Agent, 多客户端 WebSocket 网关
  s06: 多 Agent, 优先级路由和会话隔离
  本文件: 完整集成 + 生产级参考注释

【对标 OpenClaw 生产版】
- 认证: src/gateway/auth.ts
- 路由: src/routing/resolve-route.ts
- 会话: src/routing/session-key.ts
- 广播: src/gateway/server-broadcast.ts

【运行方式】
1. 服务器模式 (启动网关):
   python s05_s06_unified.py

2. 测试客户端 (演示路由和多 Agent):
   python s05_s06_unified.py --test-client

3. 交互式 REPL (本地测试路由逻辑):
   python s05_s06_unified.py --repl

【依赖】
pip install anthropic python-dotenv websockets
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
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection
from dotenv import load_dotenv
from anthropic import Anthropic

# ================================================================================
# 环境与配置
# ================================================================================

load_dotenv()

# LLM 配置 (使用 Anthropic API)
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL")
MODEL_ID = os.getenv("MODEL_ID", "claude-sonnet-4-20250514")

# 网关配置
GATEWAY_HOST = os.getenv("GATEWAY_HOST", "127.0.0.1")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "18789"))
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "")

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gateway")

# Anthropic 客户端初始化
_client_kwargs: dict[str, Any] = {"api_key": ANTHROPIC_API_KEY}
if ANTHROPIC_BASE_URL:
    _client_kwargs["base_url"] = ANTHROPIC_BASE_URL
client = Anthropic(**_client_kwargs)

# ================================================================================
# Part 1: Agent 配置与多 Agent 管理
# ================================================================================
#
# 【参考】OpenClaw src/config/types.agents.ts
#
# AgentConfig 定义每个 Agent 的配置. 每个 Agent 可以有不同的:
# - 模型 (可以用不同的 Claude 版本)
# - system prompt (决定 Agent 的"性格"和能力)
# - 工具集 (虽然教学版这里是空的, 生产版会有完整的工具)


@dataclass
class AgentConfig:
    """一个 Agent 的配置."""
    id: str
    model: str
    system_prompt: str
    tools: list[dict] = field(default_factory=list)

    def __repr__(self) -> str:
        return f"AgentConfig(id={self.id!r}, model={self.model!r})"


# ================================================================================
# Part 2: 路由与绑定
# ================================================================================
#
# 【参考】OpenClaw src/routing/bindings.ts 和 src/routing/resolve-route.ts
#
# Binding 定义 "什么条件匹配什么 Agent" 的规则.
# MessageRouter 负责根据消息的来源信息决定由哪个 Agent 处理.
#
# 教学版: 5 层优先级 (peer > guild > account > channel > default)
# 生产版: 7 层优先级 (peer > parent-peer > guild+roles > guild > team > account > channel > default)


@dataclass
class Binding:
    """
    路由绑定规则.
    字段为 None 表示 "通配", priority 越高越先匹配.
    """
    channel: str | None = None
    account_id: str | None = None
    peer_id: str | None = None
    peer_kind: str | None = None  # "direct" 或 "group"
    guild_id: str | None = None
    agent_id: str = "main"
    priority: int = 0

    def __repr__(self) -> str:
        conditions = []
        if self.channel:
            conditions.append(f"channel={self.channel}")
        if self.account_id:
            conditions.append(f"account={self.account_id}")
        if self.guild_id:
            conditions.append(f"guild={self.guild_id}")
        if self.peer_id:
            conditions.append(f"peer={self.peer_id}")
        if self.peer_kind:
            conditions.append(f"kind={self.peer_kind}")
        cond_str = ", ".join(conditions) if conditions else "*"
        return f"Binding({cond_str} -> {self.agent_id}, p={self.priority})"


def build_session_key(
    agent_id: str,
    channel: str,
    account_id: str,
    peer_kind: str,
    peer_id: str,
    dm_scope: str = "per-peer",
) -> str:
    """
    【参考】OpenClaw src/routing/session-key.ts

    根据 dm_scope 构建 session key, 控制会话隔离的粒度:
    - "main": 所有 DM 共用一个会话 (个人助手场景)
    - "per-peer": 每个发送者独立会话 (多用户机器人)
    - "per-channel-peer": 同一用户在不同通道独立会话
    """
    # 标准化
    agent_id = agent_id.strip().lower()
    channel = channel.strip().lower()
    peer_id = peer_id.strip().lower()
    peer_kind = peer_kind.strip().lower() or "direct"

    # 群组消息总是按 channel + kind + peerId 隔离
    if peer_kind != "direct":
        return f"agent:{agent_id}:{channel}:{peer_kind}:{peer_id}"

    # DM 会话根据 scope 决定隔离粒度
    if dm_scope == "main":
        return f"agent:{agent_id}:main"
    elif dm_scope == "per-peer":
        return f"agent:{agent_id}:direct:{peer_id}"
    elif dm_scope == "per-channel-peer":
        return f"agent:{agent_id}:{channel}:direct:{peer_id}"
    else:
        return f"agent:{agent_id}:direct:{peer_id}"


class MessageRouter:
    """
    【参考】OpenClaw src/routing/resolve-route.ts

    消息路由器.
    根据入站消息的来源信息 (channel, sender, guild_id 等),
    决定由哪个 Agent 处理, 以及使用哪个 session key.

    路由解析流程:
      1. 按 priority 降序遍历所有 Binding
      2. 依次尝试匹配每条规则
      3. 第一个匹配上的规则生效
      4. 如果没有匹配, 使用 default_agent
    """

    def __init__(
        self,
        agents: dict[str, AgentConfig],
        bindings: list[Binding],
        default_agent: str = "main",
        dm_scope: str = "per-peer",
    ) -> None:
        self.agents = agents
        # 按 priority 降序排列, 高优先级先匹配
        self.bindings = sorted(bindings, key=lambda b: b.priority, reverse=True)
        self.default_agent = default_agent
        self.dm_scope = dm_scope

    def resolve(
        self,
        channel: str,
        sender: str,
        peer_kind: str = "direct",
        guild_id: str | None = None,
        account_id: str | None = None,
    ) -> tuple[AgentConfig, str]:
        """
        解析入站消息应由哪个 Agent 处理, 以及使用哪个 session key.

        参数:
            channel: 消息来源通道 ("telegram", "discord", "websocket" 等)
            sender: 发送者 ID
            peer_kind: 消息类型 ("direct" = DM, "group" = 群聊)
            guild_id: 群组/服务器 ID (可选)
            account_id: 账号 ID (可选)

        返回:
            (agent_config, session_key)
        """
        matched_agent_id = self.default_agent

        for binding in self.bindings:  # 已按 priority 降序排列
            if self._matches(binding, channel, sender, peer_kind, guild_id, account_id):
                matched_agent_id = binding.agent_id
                log.info(
                    "route: matched %s for channel=%s sender=%s kind=%s",
                    binding, channel, sender, peer_kind,
                )
                break

        # 查找 Agent 配置
        agent = self.agents.get(matched_agent_id)
        if agent is None:
            log.warning(
                "route: agent %r not found, falling back to %r",
                matched_agent_id, self.default_agent,
            )
            agent = self.agents[self.default_agent]

        # 构建 session key
        session_key = build_session_key(
            agent_id=agent.id,
            channel=channel,
            account_id=account_id or "default",
            peer_kind=peer_kind,
            peer_id=sender if peer_kind == "direct" else (guild_id or sender),
            dm_scope=self.dm_scope,
        )

        return agent, session_key

    def _matches(
        self,
        binding: Binding,
        channel: str,
        sender: str,
        peer_kind: str,
        guild_id: str | None,
        account_id: str | None,
    ) -> bool:
        """检查一条绑定规则是否与入站消息匹配."""
        # 每个非空条件都必须匹配
        if binding.channel and binding.channel.lower() != channel.lower():
            return False
        if binding.account_id and binding.account_id.lower() != (account_id or "").lower():
            return False
        if binding.guild_id and binding.guild_id.lower() != (guild_id or "").lower():
            return False
        if binding.peer_id and binding.peer_id.lower() != sender.lower():
            return False
        if binding.peer_kind and binding.peer_kind.lower() != peer_kind.lower():
            return False
        return True

    def describe_bindings(self) -> str:
        """打印所有绑定规则, 用于调试."""
        lines = ["Routing bindings (priority desc):"]
        for i, b in enumerate(self.bindings):
            lines.append(f"  [{i}] {b}")
        lines.append(f"  [default] -> {self.default_agent}")
        return "\n".join(lines)


# ================================================================================
# Part 3: 会话管理
# ================================================================================

@dataclass
class SessionEntry:
    """一个会话的元数据和消息历史."""
    session_key: str
    agent_id: str = "main"
    messages: list[dict[str, str]] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)


class SessionStore:
    """内存会话存储, 支持多 Agent 的 session 管理."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionEntry] = {}

    def get_or_create(self, session_key: str, agent_id: str = "main") -> SessionEntry:
        """获取会话, 不存在则自动创建 (懒加载)."""
        if session_key not in self._sessions:
            self._sessions[session_key] = SessionEntry(
                session_key=session_key,
                agent_id=agent_id,
            )
            log.info("session created: %s (agent=%s)", session_key, agent_id)
        return self._sessions[session_key]

    def get_history(self, session_key: str) -> list[dict[str, str]]:
        """获取指定会话的消息历史."""
        entry = self._sessions.get(session_key)
        return list(entry.messages) if entry else []

    def list_sessions(self) -> list[dict[str, Any]]:
        """列出所有活跃会话."""
        return [
            {
                "session_key": e.session_key,
                "agent_id": e.agent_id,
                "message_count": len(e.messages),
                "last_active": e.last_active,
            }
            for e in self._sessions.values()
        ]


# ================================================================================
# Part 4: Agent Runner
# ================================================================================

def run_agent(agent: AgentConfig, session: SessionEntry, user_text: str) -> str:
    """
    使用指定 Agent 的配置调用 LLM 生成回复.

    参数:
        agent: AgentConfig, Agent 的配置 (包含 model, system_prompt 等)
        session: SessionEntry, 会话对象 (包含消息历史)
        user_text: 用户输入文本

    返回:
        Assistant 的文本回复
    """
    # 追加用户消息到历史
    session.messages.append({"role": "user", "content": user_text})
    session.last_active = time.time()

    # 调用 LLM
    response = client.messages.create(
        model=agent.model,
        max_tokens=2048,
        system=agent.system_prompt,
        messages=session.messages,
    )

    # 提取回复
    assistant_text = ""
    for block in response.content:
        if block.type == "text":
            assistant_text += block.text

    # 追加 assistant 消息到历史
    session.messages.append({"role": "assistant", "content": assistant_text})

    return assistant_text


# ================================================================================
# Part 5: 配置加载
# ================================================================================

DEFAULT_CONFIG = {
    "agents": [
        {
            "id": "main",
            "model": MODEL_ID,
            "system_prompt": "You are a helpful general assistant.",
        },
        {
            "id": "alice",
            "model": MODEL_ID,
            "system_prompt": (
                "You are Alice, a creative writing assistant. "
                "You speak in a literary, poetic style and help with creative writing tasks."
            ),
        },
        {
            "id": "bob",
            "model": MODEL_ID,
            "system_prompt": (
                "You are Bob, a technical assistant. "
                "You are precise and methodical, focusing on code and engineering topics."
            ),
        },
    ],
    "bindings": [
        # 最高优先级: 特定用户 -> 特定 Agent
        {"peer_id": "user-alice-fan", "agent_id": "alice", "priority": 40},
        # 群组级别
        {"guild_id": "dev-server", "agent_id": "bob", "priority": 30},
        # 通道级别
        {"channel": "telegram", "agent_id": "main", "priority": 10},
        {"channel": "discord", "agent_id": "main", "priority": 10},
    ],
    "default_agent": "main",
    "dm_scope": "per-peer",
}


def load_routing_config(config_path: str | None = None) -> tuple[dict[str, AgentConfig], list[Binding], str, str]:
    """加载路由配置. 如果指定了 config_path 则从文件读取, 否则使用默认配置."""
    if config_path and os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        log.info("loaded config from %s", config_path)
    else:
        raw = DEFAULT_CONFIG
        log.info("using default config (no config file)")

    # 解析 Agent 配置
    agents: dict[str, AgentConfig] = {}
    for a in raw.get("agents", []):
        cfg = AgentConfig(
            id=a["id"],
            model=a.get("model", MODEL_ID),
            system_prompt=a.get("system_prompt", "You are a helpful assistant."),
            tools=a.get("tools", []),
        )
        agents[cfg.id] = cfg

    # 解析绑定规则
    bindings: list[Binding] = []
    for b in raw.get("bindings", []):
        binding = Binding(
            channel=b.get("channel"),
            account_id=b.get("account_id"),
            peer_id=b.get("peer_id"),
            peer_kind=b.get("peer_kind"),
            guild_id=b.get("guild_id"),
            agent_id=b.get("agent_id", "main"),
            priority=b.get("priority", 0),
        )
        bindings.append(binding)

    default_agent = raw.get("default_agent", "main")
    dm_scope = raw.get("dm_scope", "per-peer")

    return agents, bindings, default_agent, dm_scope


# ================================================================================
# Part 6: JSON-RPC 2.0 协议辅助函数
# ================================================================================

JSONRPC_VERSION = "2.0"

# 错误码 (遵循 JSON-RPC 2.0 规范)
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603
AUTH_ERROR = -32000


def make_result(req_id: str | int | None, result: Any) -> str:
    """构造 JSON-RPC 2.0 成功响应."""
    return json.dumps({
        "jsonrpc": JSONRPC_VERSION,
        "id": req_id,
        "result": result,
    })


def make_error(req_id: str | int | None, code: int, message: str) -> str:
    """构造 JSON-RPC 2.0 错误响应."""
    return json.dumps({
        "jsonrpc": JSONRPC_VERSION,
        "id": req_id,
        "error": {"code": code, "message": message},
    })


def make_event(event_type: str, payload: dict[str, Any]) -> str:
    """构造 JSON-RPC 2.0 事件通知 (服务端主动推送)."""
    return json.dumps({
        "jsonrpc": JSONRPC_VERSION,
        "method": "event",
        "params": {"type": event_type, **payload},
    })


# ================================================================================
# Part 7: WebSocket 网关服务器
# ================================================================================

@dataclass
class ConnectedClient:
    """已连接客户端的状态."""
    ws: ServerConnection
    client_id: str
    # 客户端可以声明自己的通道和身份信息
    channel: str = "websocket"
    sender: str = ""
    peer_kind: str = "direct"
    guild_id: str = ""
    account_id: str = ""
    connected_at: float = field(default_factory=time.time)


class RoutingGateway:
    """
    【参考】OpenClaw src/gateway/server.impl.ts

    带消息路由功能的网关服务器.
    在基础 WebSocket 网关的基础上增加:
    - 多 Agent 支持
    - 绑定解析
    - Session key 自动构建
    - 路由诊断方法
    """

    def __init__(
        self,
        host: str,
        port: int,
        router: MessageRouter,
        sessions: SessionStore,
        token: str = "",
    ) -> None:
        self.host = host
        self.port = port
        self.router = router
        self.sessions = sessions
        self.token = token
        self.clients: dict[str, ConnectedClient] = {}
        self._start_time = time.time()

        # JSON-RPC 方法路由表
        # 【参考】OpenClaw src/gateway/server-methods.ts
        # 生产版有 50+ 个方法; 教学版这里只演示核心的几个
        self._methods: dict[str, Any] = {
            "health": self._handle_health,
            "chat.send": self._handle_chat_send,
            "chat.history": self._handle_chat_history,
            "routing.resolve": self._handle_routing_resolve,
            "routing.bindings": self._handle_routing_bindings,
            "sessions.list": self._handle_sessions_list,
            "identify": self._handle_identify,
        }

    # -- 认证 -----

    def _authenticate(self, headers: Any) -> bool:
        """验证 Bearer Token 认证."""
        if not self.token:
            return True
        auth_header = headers.get("Authorization", "")
        parts = auth_header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        return parts[1].strip() == self.token

    # -- WebSocket 连接处理 -----

    async def _handle_connection(self, ws: ServerConnection) -> None:
        """处理单个 WebSocket 连接的完整生命周期."""
        client_id = str(uuid.uuid4())[:8]

        # 认证检查
        if not self._authenticate(ws.request.headers if ws.request else {}):
            await ws.send(make_error(None, AUTH_ERROR, "Authentication failed"))
            await ws.close(4001, "Unauthorized")
            return

        # 注册客户端
        client = ConnectedClient(ws=ws, client_id=client_id)
        self.clients[client_id] = client
        log.info("client %s: connected (total: %d)", client_id, len(self.clients))

        # 发送欢迎事件
        await ws.send(make_event("connect.welcome", {"client_id": client_id}))

        # 消息循环
        try:
            async for raw_message in ws:
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8")
                await self._dispatch(client, raw_message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            # 清理
            del self.clients[client_id]
            log.info("client %s: disconnected", client_id)

    async def _dispatch(self, client: ConnectedClient, raw: str) -> None:
        """JSON-RPC 请求分发器."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await client.ws.send(make_error(None, PARSE_ERROR, "Invalid JSON"))
            return

        if not isinstance(msg, dict) or msg.get("jsonrpc") != JSONRPC_VERSION:
            await client.ws.send(make_error(msg.get("id"), INVALID_REQUEST, "Invalid JSON-RPC"))
            return

        req_id = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params", {})

        log.info("client %s: -> %s (id=%s)", client.client_id, method, req_id)

        handler = self._methods.get(method)
        if handler is None:
            await client.ws.send(make_error(req_id, METHOD_NOT_FOUND, f"Unknown: {method}"))
            return

        try:
            result = await handler(client, params)
            await client.ws.send(make_result(req_id, result))
        except Exception as exc:
            log.exception("method %s error", method)
            await client.ws.send(make_error(req_id, INTERNAL_ERROR, str(exc)))

    # -- RPC 方法实现 -----

    async def _handle_health(self, client: ConnectedClient, params: dict) -> dict:
        """health -- 健康检查."""
        return {
            "status": "ok",
            "uptime_seconds": round(time.time() - self._start_time, 1),
            "connected_clients": len(self.clients),
            "agents": list(self.router.agents.keys()),
        }

    async def _handle_identify(self, client: ConnectedClient, params: dict) -> dict:
        """identify -- 客户端声明自己的通道和身份信息."""
        client.channel = params.get("channel", "websocket")
        client.sender = params.get("sender", client.client_id)
        client.peer_kind = params.get("peer_kind", "direct")
        client.guild_id = params.get("guild_id", "")
        client.account_id = params.get("account_id", "")
        log.info(
            "client %s: identified as channel=%s sender=%s kind=%s",
            client.client_id, client.channel, client.sender, client.peer_kind,
        )
        return {"identified": True, "channel": client.channel, "sender": client.sender}

    async def _handle_chat_send(self, client: ConnectedClient, params: dict) -> dict:
        """
        chat.send -- 通过路由器自动解析 Agent 和 session, 然后调用 LLM.

        【核心流程】
        1. 参数验证
        2. 路由解析 (决定由哪个 Agent 处理)
        3. 发送 typing 事件
        4. 调用 Agent
        5. 返回结果 + session 元数据
        """
        text = params.get("text", "").strip()
        if not text:
            raise ValueError("'text' is required")

        # 允许 params 覆盖客户端 identify 的值
        channel = params.get("channel", client.channel)
        sender = params.get("sender", client.sender)
        peer_kind = params.get("peer_kind", client.peer_kind)
        guild_id = params.get("guild_id", client.guild_id) or None
        account_id = params.get("account_id", client.account_id) or None

        # 【关键】路由解析: 确定 Agent 和 session key
        agent_config, session_key = self.router.resolve(
            channel=channel,
            sender=sender,
            peer_kind=peer_kind,
            guild_id=guild_id,
            account_id=account_id,
        )

        log.info(
            "chat.send: routed to agent=%s session=%s",
            agent_config.id, session_key,
        )

        # 推送 typing 事件
        await client.ws.send(make_event("chat.typing", {
            "session_key": session_key,
            "agent_id": agent_config.id,
        }))

        # 调用 Agent (使用对应的配置)
        session = self.sessions.get_or_create(session_key, agent_id=agent_config.id)
        assistant_text = run_agent(agent_config, session, text)

        # 【可选】广播 done 事件 (多客户端同步, s05 的特性)
        # await self._broadcast(make_event("chat.done", {...}))

        return {
            "text": assistant_text,
            "agent_id": agent_config.id,
            "session_key": session_key,
            "message_count": len(session.messages),
        }

    async def _handle_chat_history(self, client: ConnectedClient, params: dict) -> dict:
        """chat.history -- 获取会话的消息历史."""
        session_key = params.get("session_key", "")
        if not session_key:
            raise ValueError("'session_key' is required")
        messages = self.sessions.get_history(session_key)
        limit = params.get("limit", 50)
        if len(messages) > limit:
            messages = messages[-limit:]
        return {"session_key": session_key, "messages": messages, "total": len(messages)}

    async def _handle_routing_resolve(self, client: ConnectedClient, params: dict) -> dict:
        """
        routing.resolve -- 诊断方法: 查看某条消息会被路由到哪个 Agent.

        不实际调用 LLM, 只返回路由解析结果. 用于调试绑定配置.
        """
        channel = params.get("channel", "websocket")
        sender = params.get("sender", "anonymous")
        peer_kind = params.get("peer_kind", "direct")
        guild_id = params.get("guild_id")
        account_id = params.get("account_id")

        agent_config, session_key = self.router.resolve(
            channel=channel,
            sender=sender,
            peer_kind=peer_kind,
            guild_id=guild_id,
            account_id=account_id,
        )

        return {
            "agent_id": agent_config.id,
            "agent_model": agent_config.model,
            "session_key": session_key,
            "system_prompt_preview": (
                agent_config.system_prompt[:100] + "..."
                if len(agent_config.system_prompt) > 100
                else agent_config.system_prompt
            ),
        }

    async def _handle_routing_bindings(self, client: ConnectedClient, params: dict) -> dict:
        """routing.bindings -- 列出所有绑定规则."""
        return {
            "bindings": [
                {
                    "channel": b.channel,
                    "account_id": b.account_id,
                    "peer_id": b.peer_id,
                    "peer_kind": b.peer_kind,
                    "guild_id": b.guild_id,
                    "agent_id": b.agent_id,
                    "priority": b.priority,
                }
                for b in self.router.bindings
            ],
            "default_agent": self.router.default_agent,
            "dm_scope": self.router.dm_scope,
        }

    async def _handle_sessions_list(self, client: ConnectedClient, params: dict) -> dict:
        """sessions.list -- 列出所有活跃会话."""
        return {"sessions": self.sessions.list_sessions()}

    # -- 服务器启动 -----

    async def start(self) -> None:
        """启动 WebSocket 服务器并进入事件循环."""
        log.info("Gateway starting on ws://%s:%d", self.host, self.port)
        log.info("\n%s", self.router.describe_bindings())

        async with websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
        ):
            log.info("Gateway ready. Waiting for connections...")
            await asyncio.Future()


# ================================================================================
# Part 8: 测试客户端 -- 演示路由行为
# ================================================================================

async def test_client() -> None:
    """
    测试客户端: 模拟来自不同通道和用户的消息, 观察路由结果.
    启动: python s05_s06_unified.py --test-client
    """
    uri = f"ws://{GATEWAY_HOST}:{GATEWAY_PORT}"
    headers = {}
    if GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    print(f"[test] connecting to {uri} ...")

    async with websockets.connect(uri, additional_headers=headers) as ws:
        # 接收欢迎
        welcome = json.loads(await ws.recv())
        client_id = welcome.get("params", {}).get("client_id", "?")
        print(f"[test] connected as {client_id}\n")

        req_counter = 0

        async def rpc(method: str, params: dict) -> dict:
            nonlocal req_counter
            req_counter += 1
            rid = f"r-{req_counter}"
            await ws.send(json.dumps({
                "jsonrpc": "2.0",
                "id": rid,
                "method": method,
                "params": params,
            }))
            # 读取响应, 跳过中间事件
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)
                if msg.get("id") == rid:
                    return msg.get("result", msg.get("error", {}))
                else:
                    event_type = msg.get("params", {}).get("type", "?")
                    print(f"  [event] {event_type}")

        # -- 测试 1: 路由诊断 -- 查看不同消息的路由结果 ---
        print("--- Routing Diagnostics ---")

        scenarios = [
            {"channel": "telegram", "sender": "random-user", "peer_kind": "direct"},
            {"channel": "telegram", "sender": "user-alice-fan", "peer_kind": "direct"},
            {"channel": "discord", "sender": "dev-person", "peer_kind": "group", "guild_id": "dev-server"},
            {"channel": "slack", "sender": "someone", "peer_kind": "direct"},
        ]

        for s in scenarios:
            result = await rpc("routing.resolve", s)
            print(
                f"  {s.get('channel'):>10} | sender={s.get('sender'):<16} "
                f"| kind={s.get('peer_kind'):<7} "
                f"-> agent={result.get('agent_id'):<6} "
                f"session={result.get('session_key')}"
            )

        # -- 测试 2: 实际对话 -- 不同路由的 Agent 有不同风格 ---
        print("\n--- Routed Chat ---")

        # 普通用户 -> main agent
        result = await rpc("chat.send", {
            "text": "Hello! Who are you?",
            "channel": "telegram",
            "sender": "normal-user",
        })
        print(f"  [main]  {result.get('text', '')[:120]}...")

        # alice 的粉丝 -> alice agent
        result = await rpc("chat.send", {
            "text": "Hello! Who are you?",
            "channel": "telegram",
            "sender": "user-alice-fan",
        })
        print(f"  [alice] {result.get('text', '')[:120]}...")

        # dev-server 群组 -> bob agent
        result = await rpc("chat.send", {
            "text": "Hello! Who are you?",
            "channel": "discord",
            "sender": "dev-person",
            "peer_kind": "group",
            "guild_id": "dev-server",
        })
        print(f"  [bob]   {result.get('text', '')[:120]}...")

        # -- 测试 3: 列出所有会话 ---
        print("\n--- Active Sessions ---")
        result = await rpc("sessions.list", {})
        for s in result.get("sessions", []):
            print(
                f"  agent={s['agent_id']:<6} "
                f"msgs={s['message_count']:<3} "
                f"key={s['session_key']}"
            )

        # -- 测试 4: 列出绑定规则 ---
        print("\n--- Bindings ---")
        result = await rpc("routing.bindings", {})
        for b in result.get("bindings", []):
            parts = []
            if b.get("channel"):
                parts.append(f"channel={b['channel']}")
            if b.get("peer_id"):
                parts.append(f"peer={b['peer_id']}")
            if b.get("guild_id"):
                parts.append(f"guild={b['guild_id']}")
            cond = ", ".join(parts) if parts else "(default)"
            print(f"  p={b['priority']:<3} {cond:<40} -> {b['agent_id']}")
        print(f"  default -> {result.get('default_agent')}")
        print(f"  dm_scope = {result.get('dm_scope')}")

    print("\n[test] done")


# ================================================================================
# Part 9: 交互式 REPL -- 本地路由调试
# ================================================================================

def repl(router: MessageRouter) -> None:
    """
    交互式 REPL, 输入模拟消息参数, 查看路由结果.
    不需要启动网关, 直接在本地测试路由逻辑.

    使用: python s05_s06_unified.py --repl
    """
    print("=" * 60)
    print("  Routing REPL -- test binding resolution locally")
    print("  Format: <channel> <sender> [kind] [guild_id]")
    print("  Example: telegram user123")
    print("  Example: discord dev-person group dev-server")
    print("  Type 'bindings' to list all bindings")
    print("  Type 'quit' to exit")
    print("=" * 60)

    while True:
        try:
            raw = input("\nroute> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not raw:
            continue
        if raw.lower() in ("quit", "exit", "q"):
            break
        if raw.lower() == "bindings":
            print(router.describe_bindings())
            continue

        parts = raw.split()
        if len(parts) < 2:
            print("  Usage: <channel> <sender> [kind] [guild_id]")
            continue

        channel = parts[0]
        sender = parts[1]
        peer_kind = parts[2] if len(parts) > 2 else "direct"
        guild_id = parts[3] if len(parts) > 3 else None

        agent, session_key = router.resolve(
            channel=channel,
            sender=sender,
            peer_kind=peer_kind,
            guild_id=guild_id,
        )

        print(f"  Agent:       {agent.id} ({agent.model})")
        print(f"  Session Key: {session_key}")
        print(f"  Prompt:      {agent.system_prompt[:80]}...")


# ================================================================================
# Part 10: Main 程序入口
# ================================================================================

def main() -> None:
    """程序入口: 根据命令行参数启动网关或测试客户端."""
    import sys

    # 检查 API 密钥
    if not ANTHROPIC_API_KEY:
        print("Error: ANTHROPIC_API_KEY not set.")
        print("Set it in .env file or environment variable.")
        sys.exit(1)

    # 加载配置
    config_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--config" and i + 1 < len(sys.argv):
            config_path = sys.argv[i + 1]
            break

    agents, bindings, default_agent, dm_scope = load_routing_config(config_path)
    router = MessageRouter(agents, bindings, default_agent, dm_scope)

    if "--test-client" in sys.argv:
        # 测试客户端
        asyncio.run(test_client())
    elif "--repl" in sys.argv:
        # 交互式 REPL
        repl(router)
    else:
        # 启动网关服务器
        print("=" * 60)
        print("  OpenClaw Gateway & Routing - Unified Tutorial")
        print("  (s05 WebSocket Gateway + s06 Multi-Agent Routing)")
        print("=" * 60)
        print(f"  Host:     {GATEWAY_HOST}")
        print(f"  Port:     {GATEWAY_PORT}")
        print(f"  Agents:   {', '.join(agents.keys())}")
        print(f"  Bindings: {len(bindings)} rules")
        print(f"  DM Scope: {dm_scope}")
        print()
        print("  Commands:")
        print("    python s05_s06_unified.py                 # start gateway")
        print("    python s05_s06_unified.py --test-client   # run test suite")
        print("    python s05_s06_unified.py --repl          # local routing REPL")
        print("    python s05_s06_unified.py --config cfg.json # custom config")
        print("=" * 60)

        sessions = SessionStore()
        gateway = RoutingGateway(
            host=GATEWAY_HOST,
            port=GATEWAY_PORT,
            router=router,
            sessions=sessions,
            token=GATEWAY_TOKEN,
        )
        asyncio.run(gateway.start())


if __name__ == "__main__":
    main()
