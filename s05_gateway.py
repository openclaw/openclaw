"""
"From single-agent gateway to multi-agent routing"

本文件展示如何从基础的网络通信层逐步扩展到多 Agent 的智能路由系统.

【运行方式】
1. 服务器模式 (启动网关):
   python agents/s05_gateway.py

2. 测试客户端 (自动化演示路由和多 Agent):
   python agents/s05_gateway.py --test-client

3. 交互式对话 (自由提问，验证会话记录和工具调用):
   python agents/s05_gateway.py --chat

4. 交互式 REPL (本地测试路由逻辑，无需网关):
   python agents/s05_gateway.py --repl

【依赖】
pip install python-dotenv websockets
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
import logging
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection
from dotenv import load_dotenv

_agents_dir = Path(__file__).resolve().parent
if str(_agents_dir) not in sys.path:
    sys.path.insert(0, str(_agents_dir))

from llm_client import (
    load_env_if_exists,
    deepseek_chat_with_tools,
    LLMClientConfig,
    LLMClientError,
    LLMValidationError,
)

# 从 s04 导入完整工具链和 agent 逻辑
from s04_multi_channel import (
    TOOLS_OPENAI,
    SessionStore as S04SessionStore,
    SYSTEM_PROMPT as S04_SYSTEM_PROMPT,
    process_tool_call,
)

# ================================================================================
# 环境与配置
# ================================================================================

load_dotenv()
load_env_if_exists()

# LLM 配置 (使用 DeepSeek / llm_client，与 s04 一致)
MODEL = os.getenv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat")

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

# ================================================================================
# Part 1: Agent 配置与多 Agent 管理
# ================================================================================
#
# 【参考】OpenClaw src/config/types.agents.ts
#
# AgentConfig 定义每个 Agent 的配置. 每个 Agent 可以有不同的:
# - 模型 (可用不同模型，默认与 s04 一致使用 DeepSeek)
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
    peer_id: str | None = None  # 对方的ID或群组ID
    peer_kind: str | None = None  # "direct"(1v1 私聊) 或 "group" （多人群聊）
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

'''
例子 1: 群组消息（Discord dev-server）
# 小张在 Discord 开发群里说了一句话
message = {
    "channel": "discord",         # 通道是 Discord
    "peer_kind": "group",         # 这是群组消息
    "peer_id": "dev-server",      # 群组ID是 dev-server
    "sender": "xiaozs",           # 发送者是 xiaozs
    "text": "大家好！"
}
# 构建 session key：
# peer_kind="group" → 群组消息
# 所以会按 agent:alice:discord:group:dev-server 隔离
# 这个群里所有人的消息都在同一个会话中！

例子 2: 一对一消息（DM）
# 小张私聊 Alice
message = {
    "channel": "telegram",        # 通道是 Telegram
    "peer_kind": "direct",        # 这是一对一消息
    "peer_id": "xiaozs",          # 对方是 xiaozs
    "sender": "xiaozs",           # 发送者是 xiaozs
    "text": "Hi Alice, 能帮我看下代码吗？"
}

# 构建 session key (假设 dm_scope="per-peer"):
# peer_kind="direct" → DM 消息
# 所以会按 agent:alice:direct:xiaozs 隔离
# 这个对话的所有消息都在这个 session 中

例子 3: 同一个人在不同群里
# 小张在 Discord dev-server 说话
message1 = {
    "channel": "discord",
    "peer_kind": "group",
    "peer_id": "dev-server",  # 群ID
    "sender": "xiaozs"
}

# 小张在 Slack 工程频道说话
message2 = {
    "channel": "slack",
    "peer_kind": "group",
    "peer_id": "engineering",  # 不同群ID
    "sender": "xiaozs"
}

# 结果：两个不同的 session key，分别是：
# agent:alice:discord:group:dev-server
# agent:alice:slack:group:engineering
# ↓
# Alice 会分别记住两个群的聊天记录

场景 1: dm_scope = "per-peer" （多用户机器人）
# 小张的 DM
build_session_key(
    agent_id="alice",
    peer_kind="direct",
    peer_id="user-123",  # 小张
    dm_scope="per-peer"
)
# 结果: "agent:alice:direct:user-123"

# 小李的 DM
build_session_key(
    agent_id="alice",
    peer_kind="direct",
    peer_id="user-456",  # 小李
    dm_scope="per-peer"
)
# 结果: "agent:alice:direct:user-456"  ← 【不同！】

# 意味着：

公开 Discord 机器人
  - 小张: "hi"
  - Alice: "你好！"（小张的私聊记录）
  
  - 小李: "hi"
  - Alice: "你好！"（小李的私聊记录，独立的）
  
小张和小李的 DM 完全分开，不会混淆

场景 2: dm_scope = "per-channel-peer" （多通道多用户）
# 小张在 Telegram 的 DM
build_session_key(
    agent_id="alice",
    channel="telegram",
    peer_kind="direct",
    peer_id="user-123",  # 小张
    dm_scope="per-channel-peer"
)
# 结果: "agent:alice:telegram:direct:user-123"

# 小张在 Discord 的 DM
build_session_key(
    agent_id="alice",
    channel="discord",
    peer_kind="direct",
    peer_id="user-123",  # 同一个小张
    dm_scope="per-channel-peer"
)
# 结果: "agent:alice:discord:direct:user-123"  ← 【不同！】
'''

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

    # 群组消息（group，多人对话）总是按 channel + kind + peerId 隔离
    if peer_kind != "direct":  # direct: 仅两个人的私密对话
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
        
        即：
        一条新消息来了
            ↓
        MessageRouter.resolve() 回答两个问题：
            1. 这条消息应该给谁处理？(哪个 Agent)
            2. 这条消息应该存在哪个对话记录里？(哪个 session key)
            ↓
        返回答案

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
#
# 使用 s04 的 SessionStore（持久化到 workspace/.sessions）.
# 网关通过 S04SessionStore 提供 load_session / save_turn / list_sessions.
#


# ================================================================================
# Part 4: Agent Runner（与 s04 agent_loop 等效，支持多 Agent 的 system_prompt 和 model）
# ================================================================================

def run_agent_with_tools(
    agent: AgentConfig,
    session_store: S04SessionStore,
    session_key: str,
    user_text: str,
) -> str:
    """
    处理一轮用户输入，调用 LLM（含工具循环），返回最终文本回复.
    逻辑与 s04 的 agent_loop 一致，但支持 AgentConfig 的 system_prompt 和 model.

    参数:
        agent: AgentConfig，决定 model 和 system_prompt
        session_store: s04 SessionStore，持久化会话
        session_key: 会话键
        user_text: 用户输入

    返回:
        助手的最终文本回复
    """
    session_data = session_store.load_session(session_key)
    messages = session_data["history"]
    messages.append({"role": "user", "content": user_text})

    # 合并 s04 的工具说明与 agent 个性（每个 agent 都具备工具能力）
    system_prompt = f"{S04_SYSTEM_PROMPT}\n\nPersonality: {agent.system_prompt}"

    all_assistant_blocks: list = []

    while True:
        resp = deepseek_chat_with_tools(
            messages,
            TOOLS_OPENAI,
            model=agent.model,
            system_prompt=system_prompt,
            max_tokens=4096,
        )

        content = resp.get("content") or ""
        tool_calls = resp.get("tool_calls") or []
        finish_reason = resp.get("finish_reason") or "stop"

        if content:
            all_assistant_blocks.append({"type": "text", "text": content})
        for tc in tool_calls:
            try:
                tc_args = json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else tc["arguments"]
            except json.JSONDecodeError:
                tc_args = {}
            all_assistant_blocks.append({
                "type": "tool_use",
                "id": tc["id"],
                "name": tc["name"],
                "input": tc_args,
            })

        if tool_calls:
            assistant_msg: dict = {"role": "assistant", "content": content}
            assistant_msg["tool_calls"] = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": tc["arguments"]},
                }
                for tc in tool_calls
            ]
            messages.append(assistant_msg)

            for tc in tool_calls:
                try:
                    args = json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else tc["arguments"]
                except json.JSONDecodeError:
                    args = {}

                log.info("  [tool] %s(%s)", tc["name"], json.dumps(args, ensure_ascii=False)[:80])
                result = process_tool_call(tc["name"], args)

                tool_msg = {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                }
                messages.append(tool_msg)

                all_assistant_blocks.append({
                    "type": "tool_result",
                    "tool_use_id": tc["id"],
                    "output": result,
                })

            continue

        if content:
            messages.append({"role": "assistant", "content": content})
        final_text = content
        break

    session_store.save_turn(session_key, user_text, all_assistant_blocks)
    return final_text


# ================================================================================
# Part 5: 配置加载
# ================================================================================

DEFAULT_CONFIG = {
    "agents": [
        {
            "id": "main",
            "model": MODEL,
            "system_prompt": "You are a helpful general assistant.",
        },
        {
            "id": "alice",
            "model": MODEL,
            "system_prompt": (
                "You are Alice, a creative writing assistant. "
                "You speak in a literary, poetic style and help with creative writing tasks."
            ),
        },
        {
            "id": "bob",
            "model": MODEL,
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
            model=a.get("model", MODEL),
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

"""
下面相当于是定义并实现了暴露的网关所提供的服务，下面是个例子
// 客户端
client.send(JSON.stringify({
    jsonrpc: "2.0",
    id: "chat-001",
    method: "chat.send",  // ← 调用 self._methods["chat.send"]
    params: {
        text: "你好，请介绍一下自己",
        channel: "telegram",
        sender: "alice",
    }
}));

// 服务器处理流程：
// 1. 查找 self._methods["chat.send"]
// 2. 调用 self._handle_chat_send()
// 3. 内部逻辑：
//    - 调用 self.router.resolve() 确定用哪个 Agent
//    - 调用 run_agent_with_tools() 执行 LLM（含工具循环，与 s04 agent_loop 等效）
//    - 会话由 s04 SessionStore 持久化
// 4. 返回结果

// 客户端收到响应：
{
    "jsonrpc": "2.0",
    "id": "chat-001",
    "result": {
        "text": "你好！我是一个 AI 助手...",
        "agent_id": "alice",
        "session_key": "telegram:alice:direct",
        "message_count": 2
    }
}
"""

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
        sessions: S04SessionStore,
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

        # 调用 Agent（与 s04 agent_loop 等效：含工具循环、持久化会话）
        try:
            assistant_text = await asyncio.to_thread(
                run_agent_with_tools,
                agent_config,
                self.sessions,
                session_key,
                text,
            )
        except LLMClientError as e:
            log.warning("LLM 请求失败 agent=%s: %s", agent_config.id, e)
            raise ValueError(f"LLM 请求失败: {e}") from e

        session_data = self.sessions.load_session(session_key)
        message_count = len(session_data["history"])

        return {
            "text": assistant_text,
            "agent_id": agent_config.id,
            "session_key": session_key,
            "message_count": message_count,
        }

    async def _handle_chat_history(self, client: ConnectedClient, params: dict) -> dict:
        """chat.history -- 获取会话的消息历史（来自 s04 持久化存储）."""
        session_key = params.get("session_key", "")
        if not session_key:
            raise ValueError("'session_key' is required")
        session_data = self.sessions.load_session(session_key)
        messages = session_data["history"]
        limit = params.get("limit", 50)
        if len(messages) > limit:
            messages = messages[-limit:]
        return {"session_key": session_key, "messages": messages, "total": len(session_data["history"])}

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
        """sessions.list -- 列出所有活跃会话（适配 s04 SessionStore 格式）."""
        raw = self.sessions.list_sessions()
        sessions = []
        for m in raw:
            sk = m.get("session_key", "")
            parts = sk.split(":") if sk else []
            agent_id = parts[1] if len(parts) > 1 else "main"
            sessions.append({
                "session_key": sk,
                "agent_id": agent_id,
                "message_count": m.get("message_count", 0),
                "last_active": m.get("updated_at", ""),
            })
        return {"sessions": sessions}

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
    启动: python s05_gateway.py.py --test-client
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
# Part 8b: 交互式对话客户端 -- 可自由提问以验证会话和工具
# ================================================================================

async def interactive_chat() -> None:
    """
    交互式对话客户端: 连接网关后可持续输入问题，验证会话记录和工具调用.
    启动: python agents/s05_gateway.py --chat

    命令: /quit 退出  /sessions 列出会话  /history 查看当前会话历史
    """
    uri = f"ws://{GATEWAY_HOST}:{GATEWAY_PORT}"
    headers = {}
    if GATEWAY_TOKEN:
        headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

    print(f"[chat] connecting to {uri} ...")
    try:
        ws = await websockets.connect(uri, additional_headers=headers)
    except Exception as e:
        print(f"[chat] Failed to connect. Is the gateway running? {e}")
        return

    welcome = json.loads(await ws.recv())
    client_id = welcome.get("params", {}).get("client_id", "?")
    print(f"[chat] connected as {client_id}\n")

    req_counter = 0
    current_session_key: str | None = None

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
        while True:
            raw = await ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == rid:
                return msg.get("result", msg.get("error", {}))
            event_type = msg.get("params", {}).get("type", "?")
            if event_type == "chat.typing":
                print("  ... ", end="", flush=True)

    print("=" * 50)
    print("  交互式对话 - 验证会话记录与工具调用")
    print("  输入问题后回车发送，/quit 退出")
    print("  命令: /sessions 列出会话  /history 查看当前会话历史")
    print("=" * 50)

    chat_params = {"channel": "websocket", "sender": "chat-user"}

    try:
        while True:
            try:
                user_input = await asyncio.to_thread(input, "\nYou> ")
            except (EOFError, KeyboardInterrupt):
                print()
                break

            text = user_input.strip()
            if not text:
                continue

            if text.lower() in ("/quit", "/exit", "q", "quit", "exit"):
                print("Bye.")
                break
            if text.lower() == "/sessions":
                result = await rpc("sessions.list", {})
                for s in result.get("sessions", []):
                    print(f"  {s['agent_id']:<8} msgs={s['message_count']:<3} {s['session_key']}")
                continue
            if text.lower() == "/history":
                if current_session_key:
                    result = await rpc("chat.history", {"session_key": current_session_key})
                    for m in result.get("messages", []):
                        role = m.get("role", "?")
                        content = (m.get("content") or "")[:200]
                        print(f"  [{role}] {content}{'...' if len(m.get('content',''))>200 else ''}")
                else:
                    print("  (先发送一条消息以建立会话)")
                continue

            result = await rpc("chat.send", {**chat_params, "text": text})
            if isinstance(result, dict) and "text" in result:
                current_session_key = result.get("session_key") or current_session_key
                print(f"\nAgent> {result['text']}")
            else:
                err = result.get("message", str(result)) if isinstance(result, dict) else str(result)
                print(f"\nAgent> [Error] {err}")

    finally:
        await ws.close()
    print("\n[chat] disconnected")


# ================================================================================
# Part 9: 交互式 REPL -- 本地路由调试
# ================================================================================

def repl(router: MessageRouter) -> None:
    """
    交互式 REPL, 输入模拟消息参数, 查看路由结果.
    不需要启动网关, 直接在本地测试路由逻辑.

    使用: python s05_gateway.py.py --repl
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

    # 检查 API 密钥（与 s04 一致使用 DeepSeek / llm_client）
    try:
        LLMClientConfig().require_api_key()
    except LLMValidationError as e:
        print(f"Error: {e}")
        print("Set DEEPSEEK_API_KEY in .env file or environment variable.")
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
        # 测试客户端（自动化测试套件）
        asyncio.run(test_client())
    elif "--chat" in sys.argv:
        # 交互式对话（可自由提问，验证会话和工具）
        asyncio.run(interactive_chat())
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
        print("    python agents/s05_gateway.py                   # start gateway")
        print("    python agents/s05_gateway.py --test-client     # run test suite")
        print("    python agents/s05_gateway.py --chat             # interactive chat (ask questions)")
        print("    python agents/s05_gateway.py --repl            # local routing REPL")
        print("    python agents/s05_gateway.py --config cfg.json # custom config")
        print("=" * 60)

        sessions = S04SessionStore()
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
