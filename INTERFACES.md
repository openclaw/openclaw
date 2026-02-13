# OpenClaw Python 接口契约

> 每个批次完成后由 /done 命令自动更新。
> 新批次开始时由 /start 命令自动读取。
> 最后更新：批次 7（2026-02-13）

---

## openclaw_py.types.base
路径: openclaw_py/types/base.py

```python
from openclaw_py.types import (
    ChatType,
    DmPolicy,
    DmScope,
    GroupPolicy,
    LogLevel,
    MarkdownTableMode,
    ReplyMode,
    ReplyToMode,
    SessionMaintenanceMode,
    SessionResetMode,
    SessionScope,
    SessionSendPolicyAction,
    TypingMode,
    normalize_chat_type,
)
```

### 类型定义

**ChatType**: Literal["direct", "group", "channel"]
- 聊天类型：直接消息、群组、频道

**ReplyMode**: Literal["text", "command"]
- 回复模式

**TypingMode**: Literal["never", "instant", "thinking", "message"]
- 打字状态显示模式

**SessionScope**: Literal["per-sender", "global"]
- 会话作用域

**DmScope**: Literal["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]
- 直接消息作用域

**ReplyToMode**: Literal["off", "first", "all"]
- 回复引用模式

**GroupPolicy**: Literal["open", "disabled", "allowlist"]
- 群组消息策略

**DmPolicy**: Literal["pairing", "allowlist", "open", "disabled"]
- 直接消息策略

**MarkdownTableMode**: Literal["off", "bullets", "code"]
- Markdown 表格渲染模式

**SessionResetMode**: Literal["daily", "idle"]
- 会话重置模式

**SessionSendPolicyAction**: Literal["allow", "deny"]
- 会话发送策略动作

**SessionMaintenanceMode**: Literal["enforce", "warn"]
- 会话维护模式

**LogLevel**: Literal["silent", "fatal", "error", "warn", "info", "debug", "trace"]
- 日志级别

### 函数

```python
def normalize_chat_type(raw: str | None) -> ChatType | None:
    """将字符串规范化为 ChatType。

    - "dm" 会转换为 "direct"
    - 大小写不敏感
    - 自动去除前后空白
    - 无效值返回 None
    """
```

---

## openclaw_py.config

### openclaw_py.config.types
路径: openclaw_py/config/types.py

```python
from openclaw_py.config import (
    OpenClawConfig,
    LoggingConfig,
    SessionConfig,
    TelegramConfig,
    ModelsConfig,
    GatewayConfig,
    IdentityConfig,
    # 以及其他 40+ 配置模型
)
```

**主要配置模型**：

- `OpenClawConfig` - 根配置（包含 logging, session, models, telegram, gateway 等）
- `LoggingConfig` - 日志配置（level, file, console_style 等）
- `SessionConfig` - 会话配置（scope, dm_scope, idle_minutes, maintenance 等）
- `TelegramConfig` - Telegram 配置（bot_token, dm_policy, group_policy, stream_mode 等）
- `ModelsConfig` - AI 模型配置（providers, mode 等）
- `ModelProviderConfig` - 模型提供商配置（base_url, api_key, models 等）
- `ModelDefinitionConfig` - 模型定义（id, name, api, cost 等）
- `GatewayConfig` - Gateway 服务器配置（enabled, host, port, password 等）

所有配置使用 Pydantic v2 BaseModel，支持自动验证和类型检查。

### openclaw_py.config.env_substitution
路径: openclaw_py/config/env_substitution.py

```python
from openclaw_py.config import substitute_env_vars, MissingEnvVarError

def substitute_env_vars(
    obj: Any,
    env: dict[str, str] | None = None,
    config_path: str = "",
) -> Any:
    """递归替换配置中的环境变量。
    
    - 支持 ${VAR_NAME} 语法
    - 支持 $${VAR} 转义为 ${VAR}
    - 只匹配大写字母开头的变量名
    """

class MissingEnvVarError(Exception):
    """环境变量缺失异常"""
    var_name: str
    config_path: str
```

### openclaw_py.config.paths
路径: openclaw_py/config/paths.py

```python
from openclaw_py.config import (
    resolve_config_path,
    resolve_state_dir,
    resolve_home_dir,
    expand_home_prefix,
    ensure_state_dir,
)

def resolve_config_path(env: dict[str, str] | None = None) -> Path:
    """解析配置文件路径（默认: ~/.openclaw/openclaw.yaml）"""

def resolve_state_dir(env: dict[str, str] | None = None) -> Path:
    """解析状态目录（默认: ~/.openclaw）"""

def resolve_home_dir(env: dict[str, str] | None = None) -> Path:
    """解析用户主目录（支持 OPENCLAW_HOME 覆盖）"""

def expand_home_prefix(path: str, env: dict[str, str] | None = None) -> Path:
    """展开 ~ 前缀为用户主目录"""

def ensure_state_dir(env: dict[str, str] | None = None) -> Path:
    """确保状态目录存在（创建如果不存在）"""
```

### openclaw_py.config.loader
路径: openclaw_py/config/loader.py

```python
from openclaw_py.config import (
    load_config_file,
    load_config_sync,
    read_config_file_snapshot,
    parse_config_file,
    ConfigLoadError,
    ConfigParseError,
    ConfigValidationError,
)

async def load_config_file(
    path: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> OpenClawConfig:
    """加载配置文件（支持 YAML/JSON）。
    
    - 自动环境变量替换
    - 应用默认值
    - Pydantic 验证
    """

def load_config_sync(
    path: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> OpenClawConfig:
    """同步版本的 load_config_file"""

async def read_config_file_snapshot(
    path: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> ConfigFileSnapshot:
    """读取配置文件快照（包含原始内容、解析结果、验证结果）"""

def parse_config_file(content: str, format: Literal["yaml", "json"]) -> dict[str, Any]:
    """解析配置文件内容"""

class ConfigLoadError(Exception):
    """配置加载错误基类"""

class ConfigParseError(ConfigLoadError):
    """配置解析错误"""

class ConfigValidationError(ConfigLoadError):
    """配置验证错误"""
    issues: list[ConfigValidationIssue]
```

### openclaw_py.config.defaults
路径: openclaw_py/config/defaults.py

```python
from openclaw_py.config import apply_defaults

def apply_defaults(config: OpenClawConfig) -> OpenClawConfig:
    """应用默认配置值"""
```

---

## openclaw_py.logging

### openclaw_py.logging.logger
路径: openclaw_py/logging/logger.py

```python
from openclaw_py.logging import (
    setup_logger,
    get_logger,
    reset_logger,
    is_logger_initialized,
    get_current_config,
    log_info,
    log_warn,
    log_error,
    log_debug,
    log_success,
    log_trace,
    DEFAULT_LOG_DIR,
    DEFAULT_LOG_FILE,
)
```

**常量**：

```python
DEFAULT_LOG_DIR: Path = Path.home() / ".openclaw" / "logs"
DEFAULT_LOG_FILE: Path = DEFAULT_LOG_DIR / "openclaw.log"
```

**函数**：

```python
def setup_logger(config: LoggingConfig | None = None) -> None:
    """初始化日志系统。

    - 使用 loguru 作为底层实现
    - 支持文件和控制台输出
    - 支持日志级别：silent, fatal, error, warn, info, debug, trace
    - 支持控制台样式：pretty, compact, json
    - 自动日志轮转（10 MB）和压缩（保留 7 天）
    """

def get_logger():
    """获取全局 logger 实例（如果未初始化会自动初始化）"""

def reset_logger() -> None:
    """重置日志系统（清除所有 handler）"""

def is_logger_initialized() -> bool:
    """检查 logger 是否已初始化"""

def get_current_config() -> LoggingConfig | None:
    """获取当前日志配置"""

def log_info(message: str, **kwargs: Any) -> None:
    """记录 INFO 级别日志"""

def log_warn(message: str, **kwargs: Any) -> None:
    """记录 WARNING 级别日志"""

def log_error(message: str, **kwargs: Any) -> None:
    """记录 ERROR 级别日志"""

def log_debug(message: str, **kwargs: Any) -> None:
    """记录 DEBUG 级别日志"""

def log_success(message: str, **kwargs: Any) -> None:
    """记录 SUCCESS 级别日志（显示为绿色）"""

def log_trace(message: str, **kwargs: Any) -> None:
    """记录 TRACE 级别日志"""
```

---

## openclaw_py.utils

### openclaw_py.utils.common
路径: openclaw_py/utils/common.py

```python
from openclaw_py.utils import (
    ensure_dir,
    path_exists,
    clamp,
    clamp_int,
    clamp_number,
    escape_regexp,
    safe_parse_json,
    is_plain_object,
    is_record,
    normalize_path,
)
```

**文件系统工具**：

```python
async def ensure_dir(dir_path: str | Path) -> None:
    """确保目录存在（不存在则创建）"""

async def path_exists(path: str | Path) -> bool:
    """检查路径是否存在"""
```

**数字工具**：

```python
def clamp(value: float, min_val: float, max_val: float) -> float:
    """将数字限制在 [min_val, max_val] 范围内"""

def clamp_int(value: int | float, min_val: int, max_val: int) -> int:
    """将整数限制在范围内（float 会向下取整）"""

def clamp_number(value: float, min_val: float, max_val: float) -> float:
    """clamp() 的别名"""
```

**字符串工具**：

```python
def escape_regexp(text: str) -> str:
    """转义字符串中的正则表达式特殊字符"""

def normalize_path(path: str) -> str:
    """规范化路径（确保以 / 开头）"""
```

**JSON 工具**：

```python
def safe_parse_json(text: str) -> dict | list | Any | None:
    """安全解析 JSON（失败返回 None）"""
```

**类型守卫**：

```python
def is_plain_object(value: Any) -> bool:
    """检查是否为普通 dict 对象（不包括 list、None、class 等）"""

def is_record(value: Any) -> bool:
    """检查是否为 dict-like 对象（比 is_plain_object 宽松）"""
```

---

## openclaw_py.sessions

### openclaw_py.sessions.types
路径: openclaw_py/sessions/types.py

```python
from openclaw_py.sessions import (
    SessionEntry,
    SessionOrigin,
    merge_session_entry,
)
```

**SessionOrigin** (Pydantic BaseModel):
```python
class SessionOrigin(BaseModel):
    label: str | None = None
    provider: str | None = None
    surface: str | None = None
    chat_type: ChatType | None = None
    from_: str | None = Field(None, alias="from")
    to: str | None = None
    account_id: str | None = None
    thread_id: str | int | None = None
```

**SessionEntry** (Pydantic BaseModel):
```python
class SessionEntry(BaseModel):
    # 核心标识
    session_id: str
    updated_at: int  # 毫秒时间戳

    # 会话元数据
    session_file: str | None = None
    spawned_by: str | None = None
    label: str | None = None
    display_name: str | None = None

    # 聊天上下文
    chat_type: ChatType | None = None
    channel: str | None = None
    group_id: str | None = None
    origin: SessionOrigin | None = None

    # 最后路由
    last_channel: str | None = None
    last_to: str | None = None
    last_account_id: str | None = None
    last_thread_id: str | int | None = None

    # Agent 执行状态
    aborted_last_run: bool = False
    system_sent: bool = False

    # 模型追踪
    model_provider: str | None = None
    model: str | None = None
    context_tokens: int | None = None

    # 用量追踪
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    compaction_count: int = 0

    # 覆盖设置
    provider_override: str | None = None
    model_override: str | None = None
    auth_profile_override: str | None = None
    send_policy: str | None = None
    group_activation: str | None = None

    # 扩展元数据
    extra: dict[str, Any] | None = None
```

**函数**：
```python
def merge_session_entry(
    existing: SessionEntry | None,
    patch: dict[str, Any],
) -> SessionEntry:
    """合并部分更新到现有会话条目"""
```

### openclaw_py.sessions.key_utils
路径: openclaw_py/sessions/key_utils.py

```python
from openclaw_py.sessions import (
    ParsedAgentSessionKey,
    parse_agent_session_key,
    is_cron_run_session_key,
    is_subagent_session_key,
    is_acp_session_key,
    resolve_thread_parent_session_key,
)
```

**ParsedAgentSessionKey** (NamedTuple):
```python
class ParsedAgentSessionKey(NamedTuple):
    agent_id: str
    rest: str
```

**函数**：
```python
def parse_agent_session_key(session_key: str | None) -> ParsedAgentSessionKey | None:
    """解析 agent:id:rest 格式的会话密钥"""

def is_cron_run_session_key(session_key: str | None) -> bool:
    """检查是否为 cron 运行会话（agent:id:cron:name:run:id）"""

def is_subagent_session_key(session_key: str | None) -> bool:
    """检查是否为 subagent 会话"""

def is_acp_session_key(session_key: str | None) -> bool:
    """检查是否为 ACP (Agent Communication Protocol) 会话"""

def resolve_thread_parent_session_key(session_key: str | None) -> str | None:
    """解析线程会话的父会话密钥（:thread: 或 :topic: 分隔符）"""
```

**常量**：
```python
THREAD_SESSION_MARKERS = [":thread:", ":topic:"]
```

### openclaw_py.sessions.label
路径: openclaw_py/sessions/label.py

```python
from openclaw_py.sessions import (
    SESSION_LABEL_MAX_LENGTH,
    ParsedSessionLabel,
    parse_session_label,
)
```

**常量**：
```python
SESSION_LABEL_MAX_LENGTH = 64
```

**ParsedSessionLabel** (NamedTuple):
```python
class ParsedSessionLabel(NamedTuple):
    ok: bool
    label: str | None = None
    error: str | None = None
```

**函数**：
```python
def parse_session_label(raw: Any) -> ParsedSessionLabel:
    """解析和验证会话标签（最大 64 字符）"""
```

### openclaw_py.sessions.store
路径: openclaw_py/sessions/store.py

```python
from openclaw_py.sessions import (
    load_session_store,
    save_session_store,
    update_session_store,
    read_session_updated_at,
    prune_stale_entries,
    cap_entry_count,
    rotate_session_file,
    clear_session_store_cache_for_test,
)
```

**异步函数**：
```python
async def load_session_store(
    store_path: str | Path,
    skip_cache: bool = False,
) -> dict[str, SessionEntry]:
    """从 JSON 文件加载会话存储（支持缓存，TTL 45秒）"""

async def save_session_store(
    store_path: str | Path,
    store: dict[str, SessionEntry],
    skip_maintenance: bool = False,
) -> None:
    """保存会话存储到 JSON 文件（原子写入，带文件锁）"""

async def update_session_store(
    store_path: str | Path,
    mutator: Callable[[dict[str, SessionEntry]], T],
    skip_maintenance: bool = False,
) -> T:
    """原子更新会话存储"""

async def read_session_updated_at(
    store_path: str | Path,
    session_key: str,
) -> int | None:
    """读取会话的 updated_at 时间戳"""

async def rotate_session_file(
    store_path: str | Path,
    max_bytes: int | None = None,
) -> bool:
    """文件轮转（默认 10MB，保留 3 个备份）"""
```

**同步函数**：
```python
def prune_stale_entries(
    store: dict[str, SessionEntry],
    max_age_ms: int | None = None,
    log: bool = True,
) -> int:
    """清理过期会话（默认 30 天）"""

def cap_entry_count(
    store: dict[str, SessionEntry],
    max_entries: int | None = None,
    log: bool = True,
) -> int:
    """限制会话数量（默认 500）"""

def clear_session_store_cache_for_test() -> None:
    """清除会话存储缓存（测试用）"""
```

**常量**：
```python
DEFAULT_SESSION_STORE_TTL_MS = 45_000  # 45 秒缓存
DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000  # 30 天
DEFAULT_SESSION_MAX_ENTRIES = 500
DEFAULT_SESSION_ROTATE_BYTES = 10 * 1024 * 1024  # 10 MB
```

### openclaw_py.sessions.memory_store
路径: openclaw_py/sessions/memory_store.py

```python
from openclaw_py.sessions import (
    AcpSession,
    InMemorySessionStore,
    default_acp_session_store,
)
```

**AcpSession** (NamedTuple):
```python
class AcpSession(NamedTuple):
    session_id: str
    session_key: str
    cwd: str
    created_at: int  # 毫秒时间戳
    active_run_id: str | None
    abort_event: asyncio.Event | None
```

**InMemorySessionStore** (类):
```python
class InMemorySessionStore:
    """内存会话存储（用于 ACP/subagent 会话）"""

    async def create_session(
        self,
        session_key: str,
        cwd: str,
        session_id: str | None = None,
    ) -> AcpSession:
        """创建新会话"""

    async def get_session(self, session_id: str) -> AcpSession | None:
        """通过 ID 获取会话"""

    async def get_session_by_run_id(self, run_id: str) -> AcpSession | None:
        """通过运行 ID 获取会话"""

    async def set_active_run(
        self,
        session_id: str,
        run_id: str,
        abort_event: asyncio.Event,
    ) -> None:
        """设置活动运行"""

    async def clear_active_run(self, session_id: str) -> None:
        """清除活动运行"""

    async def cancel_active_run(self, session_id: str) -> bool:
        """取消活动运行"""

    async def clear_all_sessions_for_test() -> None:
        """清除所有会话（测试用）"""
```

**全局实例**：
```python
default_acp_session_store: InMemorySessionStore
```

---

## 批次 5：Gateway HTTP Server (2026-02-13)

---

## openclaw_py.gateway.types
路径: openclaw_py/gateway/types.py

```python
from openclaw_py.gateway.types import (
    GatewayAuth,
    HealthCheckResponse,
    SessionListResponse,
    ConfigSnapshotResponse,
)
```

### 数据模型

**GatewayAuth** (Pydantic):
```python
class GatewayAuth(BaseModel):
    """Gateway 认证结果"""
    authenticated: bool
    source: str  # "password" | "token" | "local-direct" | "none"
    client_ip: str | None = None
```

**HealthCheckResponse** (Pydantic):
```python
class HealthCheckResponse(BaseModel):
    """健康检查响应"""
    status: str = "ok"
    version: str | None = None
    uptime_seconds: float | None = None
    config_loaded: bool = True
```

**SessionListResponse** (Pydantic):
```python
class SessionListResponse(BaseModel):
    """会话列表响应"""
    sessions: dict[str, dict[str, Any]]
    count: int
```

**ConfigSnapshotResponse** (Pydantic):
```python
class ConfigSnapshotResponse(BaseModel):
    """配置快照响应"""
    config: dict[str, Any]
    path: str | None = None
    loaded_at: int | None = None  # 毫秒时间戳
```

---

## openclaw_py.gateway.http_common
路径: openclaw_py/gateway/http_common.py

```python
from openclaw_py.gateway.http_common import (
    send_json,
    send_text,
    send_unauthorized,
    send_invalid_request,
    send_not_found,
    send_method_not_allowed,
)
```

### HTTP 响应工具函数

```python
def send_json(status_code: int, body: Any) -> JSONResponse:
    """发送 JSON 响应"""

def send_text(body: str, status_code: int = 200) -> Response:
    """发送纯文本响应"""

def send_unauthorized(message: str = "Unauthorized") -> JSONResponse:
    """发送 401 Unauthorized 响应"""

def send_invalid_request(message: str) -> JSONResponse:
    """发送 400 Bad Request 响应"""

def send_not_found(message: str = "Not Found") -> JSONResponse:
    """发送 404 Not Found 响应"""

def send_method_not_allowed(method: str = "POST") -> JSONResponse:
    """发送 405 Method Not Allowed 响应"""
```

---

## openclaw_py.gateway.auth
路径: openclaw_py/gateway/auth.py

```python
from openclaw_py.gateway.auth import (
    get_client_ip,
    is_local_request,
    authorize_gateway_request,
)
```

### 认证函数

```python
def get_client_ip(request: Request) -> str:
    """从请求中获取客户端 IP 地址
    
    检查顺序：X-Forwarded-For -> X-Real-IP -> client.host
    """

def is_local_request(client_ip: str) -> bool:
    """检查请求是否来自本地
    
    Returns:
        True if IP is 127.0.0.1, ::1, or localhost
    """

def authorize_gateway_request(
    request: Request,
    config: GatewayConfig,
) -> GatewayAuth:
    """授权 Gateway HTTP 请求
    
    认证优先级：local-direct > token > password
    
    Returns:
        GatewayAuth 对象，包含认证结果和来源
    """
```

---

## openclaw_py.gateway.app
路径: openclaw_py/gateway/app.py

```python
from openclaw_py.gateway.app import create_app
```

### FastAPI 应用工厂

```python
def create_app(config: OpenClawConfig) -> FastAPI:
    """创建并配置 FastAPI 应用
    
    功能：
    - 配置 CORS 中间件
    - 注册所有路由（health, sessions, config）
    - 在 app.state 中存储配置
    
    Args:
        config: OpenClaw 完整配置
        
    Returns:
        配置好的 FastAPI 应用实例
    """
```

---

## openclaw_py.gateway.server
路径: openclaw_py/gateway/server.py

```python
from openclaw_py.gateway.server import (
    GatewayServer,
    start_server,
    stop_server,
)
```

### 服务器类和函数

**GatewayServer** (类):
```python
class GatewayServer:
    """Gateway HTTP 服务器包装器
    
    管理 uvicorn 服务器的生命周期
    """
    
    def __init__(self, config: OpenClawConfig):
        """初始化 Gateway 服务器"""
    
    async def start(self) -> None:
        """启动 HTTP 服务器
        
        Raises:
            RuntimeError: 如果服务器已在运行
        """
    
    async def stop(self) -> None:
        """停止 HTTP 服务器（优雅关闭，5秒超时）"""
    
    async def __aenter__(self):
        """异步上下文管理器入口"""
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """异步上下文管理器退出"""
```

**辅助函数**:
```python
async def start_server(config: OpenClawConfig | None = None) -> GatewayServer:
    """启动 Gateway HTTP 服务器
    
    Args:
        config: OpenClaw 配置（如未提供则从文件加载）
        
    Returns:
        GatewayServer 实例
    """

async def stop_server(server: GatewayServer) -> None:
    """停止 Gateway HTTP 服务器
    
    Args:
        server: 要停止的 GatewayServer 实例
    """
```

---

## openclaw_py.gateway.routes (路由模块)

### 可用的 HTTP 端点

**健康检查** (`routes/health.py`):
- `GET /health` - 简单健康检查
- `GET /api/health` - 详细健康检查（含版本和运行时间）

**会话管理** (`routes/sessions.py`):
- `GET /api/sessions` - 列出所有会话（需要认证）
- `GET /api/sessions/{session_key:path}` - 获取单个会话（需要认证）
- `DELETE /api/sessions/{session_key:path}` - 删除会话（需要认证）

**配置访问** (`routes/config.py`):
- `GET /api/config` - 获取配置（脱敏，需要认证）
- `GET /api/config/snapshot` - 获取配置快照（含元数据，需要认证）

### 认证方式

1. **Local Direct**: 来自 127.0.0.1 的请求无需认证
2. **Bearer Token**: `Authorization: Bearer <token>` 头部
3. **Password**: `X-Password: <password>` 头部

优先级：local > token > password

---

## 批次 6：Gateway WebSocket Server (2026-02-13)

---

## openclaw_py.gateway.ws_types
路径: openclaw_py/gateway/ws_types.py

```python
from openclaw_py.gateway.ws_types import (
    ConnectParams,
    WebSocketClient,
    WebSocketFrame,
    WebSocketRequest,
    WebSocketResponse,
    WebSocketEvent,
    WebSocketError,
    ConnectionState,
)
```

### 数据模型

**ConnectParams** (Pydantic):
```python
class ConnectParams(BaseModel):
    """WebSocket 连接参数（connect 帧中发送）"""
    client_id: str | None = None
    client_version: str | None = None
    protocol_version: str = "1.0"
    device_id: str | None = None
    platform: str | None = None
```

**WebSocketClient** (Pydantic):
```python
class WebSocketClient(BaseModel):
    """WebSocket 客户端信息"""
    conn_id: str  # 唯一连接 ID
    client_id: str | None = None  # 客户端提供的 ID
    client_version: str | None = None
    protocol_version: str = "1.0"
    device_id: str | None = None
    platform: str | None = None
    client_ip: str | None = None
    authenticated: bool = False
    auth_source: str | None = None  # "token" | "password" | "local-direct"
    connected_at: int  # 毫秒时间戳
```

**WebSocketFrame** (Pydantic):
```python
class WebSocketFrame(BaseModel):
    """WebSocket 消息帧（JSON-RPC 风格）"""
    type: str  # "request" | "response" | "event"
    id: str | None = None  # 请求/响应匹配 ID
    method: str | None = None  # 请求方法名
    params: dict[str, Any] | None = None  # 请求/事件参数
    result: Any = None  # 成功响应结果
    error: dict[str, Any] | None = None  # 失败响应错误
    event: str | None = None  # 事件名称
```

**WebSocketRequest** (Pydantic):
```python
class WebSocketRequest(BaseModel):
    """WebSocket 请求帧"""
    type: str = "request"
    id: str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)
```

**WebSocketResponse** (Pydantic):
```python
class WebSocketResponse(BaseModel):
    """WebSocket 响应帧"""
    type: str = "response"
    id: str
    result: Any = None
    error: dict[str, Any] | None = None
```

**WebSocketEvent** (Pydantic):
```python
class WebSocketEvent(BaseModel):
    """WebSocket 事件帧（服务端 -> 客户端广播）"""
    type: str = "event"
    event: str
    params: dict[str, Any] = Field(default_factory=dict)
```

**WebSocketError** (Pydantic):
```python
class WebSocketError(BaseModel):
    """WebSocket 错误信息"""
    code: str
    message: str
    details: dict[str, Any] | None = None
```

**ConnectionState** (非 Pydantic 类):
```python
class ConnectionState:
    """WebSocket 连接状态跟踪"""
    def __init__(self, websocket: WebSocket, client: WebSocketClient):
        self.websocket = websocket
        self.client = client
        self.is_alive = True
        self.last_pong_at: int | None = None
```

---

## openclaw_py.gateway.ws_protocol
路径: openclaw_py/gateway/ws_protocol.py

```python
from openclaw_py.gateway.ws_protocol import (
    parse_frame,
    create_response,
    create_error_response,
    create_event,
    validate_request,
    serialize_frame,
)
```

### 协议解析和创建函数

```python
def parse_frame(raw_message: str) -> WebSocketFrame | None:
    """解析原始 WebSocket 消息为帧

    Args:
        raw_message: 原始 JSON 字符串

    Returns:
        WebSocketFrame 如果有效，否则 None
    """

def create_response(
    request_id: str,
    result: Any = None,
    error: WebSocketError | None = None,
) -> str:
    """创建响应帧 JSON 字符串

    Args:
        request_id: 响应的请求 ID
        result: 成功结果数据
        error: 错误信息（如果失败）

    Returns:
        响应帧的 JSON 字符串
    """

def create_error_response(
    request_id: str,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> str:
    """创建错误响应帧

    Args:
        request_id: 失败请求的 ID
        code: 错误代码（如 "invalid_method", "unauthorized"）
        message: 人类可读的错误消息
        details: 额外错误详情

    Returns:
        错误响应的 JSON 字符串
    """

def create_event(event_name: str, params: dict[str, Any] | None = None) -> str:
    """创建事件帧 JSON 字符串

    Args:
        event_name: 事件名称
        params: 事件参数/载荷

    Returns:
        事件帧的 JSON 字符串
    """

def validate_request(frame: WebSocketFrame) -> WebSocketRequest | None:
    """验证并转换帧为请求

    Args:
        frame: 已解析的 WebSocket 帧

    Returns:
        WebSocketRequest 如果有效，否则 None
    """

def serialize_frame(
    frame: WebSocketFrame | WebSocketRequest | WebSocketResponse | WebSocketEvent
) -> str:
    """序列化帧为 JSON 字符串

    Args:
        frame: 要序列化的帧对象

    Returns:
        JSON 字符串
    """
```

---

## openclaw_py.gateway.ws_broadcast
路径: openclaw_py/gateway/ws_broadcast.py

```python
from openclaw_py.gateway.ws_broadcast import (
    broadcast_event,
    send_to_client,
    send_response_to_client,
)
```

### 广播和发送函数

```python
async def broadcast_event(
    event_name: str,
    params: dict[str, Any] | None = None,
    connections: set[ConnectionState] | None = None,
    drop_if_slow: bool = False,
) -> int:
    """广播事件到所有已连接客户端

    Args:
        event_name: 要广播的事件名称
        params: 事件参数/载荷
        connections: 活动连接集合（如果为 None，不广播）
        drop_if_slow: 如果为 True，跳过接收慢的客户端

    Returns:
        收到事件的客户端数量
    """

async def send_to_client(
    websocket: WebSocket,
    message: str,
    conn_id: str | None = None,
) -> bool:
    """发送消息到特定客户端

    Args:
        websocket: WebSocket 连接
        message: 要发送的 JSON 消息
        conn_id: 连接 ID（用于日志）

    Returns:
        如果成功发送返回 True，否则 False
    """

async def send_response_to_client(
    websocket: WebSocket,
    response_json: str,
    conn_id: str | None = None,
) -> bool:
    """发送响应帧到客户端

    这是 send_to_client 的便捷包装器，用于响应。

    Args:
        websocket: WebSocket 连接
        response_json: JSON 响应字符串
        conn_id: 连接 ID（用于日志）

    Returns:
        如果成功发送返回 True，否则 False
    """
```

---

## openclaw_py.gateway.ws_connection
路径: openclaw_py/gateway/ws_connection.py

```python
from openclaw_py.gateway.ws_connection import (
    WebSocketConnectionManager,
    handle_websocket_connection,
    authenticate_connection,
)
```

### 连接管理器

**WebSocketConnectionManager** (类):
```python
class WebSocketConnectionManager:
    """管理 WebSocket 连接和路由"""

    def __init__(self):
        """初始化连接管理器"""
        self.connections: set[ConnectionState] = set()
        self.clients_by_id: dict[str, ConnectionState] = {}

    def add_connection(self, conn_state: ConnectionState) -> None:
        """添加新连接"""

    def remove_connection(self, conn_state: ConnectionState) -> None:
        """移除连接"""

    def get_connection_count(self) -> int:
        """获取活动连接数量"""

    def get_client_by_id(self, client_id: str) -> ConnectionState | None:
        """通过客户端 ID 获取连接"""
```

### 连接处理函数

```python
async def handle_websocket_connection(
    websocket: WebSocket,
    config: GatewayConfig,
    manager: WebSocketConnectionManager,
    client_ip: str | None = None,
) -> None:
    """处理 WebSocket 连接生命周期

    Args:
        websocket: FastAPI WebSocket 连接
        config: Gateway 配置
        manager: 连接管理器
        client_ip: 客户端 IP 地址（用于认证）
    """

def authenticate_connection(
    client_ip: str | None,
    config: GatewayConfig,
) -> tuple[bool, str | None]:
    """认证 WebSocket 连接

    Args:
        client_ip: 客户端 IP 地址
        config: Gateway 配置

    Returns:
        元组 (authenticated, auth_source)
        - authenticated: 是否认证成功
        - auth_source: 认证来源（"local-direct" | "token" | "password" | None）

    支持的认证方式：
    - 本地 IP (127.0.0.1, ::1) 自动允许
    - TestClient (IP 为 None 或 "testclient") 允许用于测试
    - 远程连接暂不支持（将来会添加 token/password 认证）
    """
```

---

## openclaw_py.gateway.ws_server
路径: openclaw_py/gateway/ws_server.py

```python
from openclaw_py.gateway.ws_server import (
    get_connection_manager,
    create_websocket_router,
    broadcast_to_all,
)
```

### WebSocket 服务器函数

```python
def get_connection_manager() -> WebSocketConnectionManager:
    """获取全局 WebSocket 连接管理器（单例）

    Returns:
        WebSocket 连接管理器实例
    """

def create_websocket_router(config: GatewayConfig) -> APIRouter:
    """创建 WebSocket 路由器和端点

    Args:
        config: Gateway 配置

    Returns:
        包含 WebSocket 路由的 FastAPI APIRouter

    提供的端点：
    - WebSocket /ws: 主 WebSocket 端点（客户端连接）
    - GET /ws-test: 交互式 HTML 测试页面
    """

async def broadcast_to_all(event_name: str, params: dict | None = None) -> int:
    """广播事件到所有已连接客户端

    这是使用全局连接管理器的便捷函数。

    Args:
        event_name: 事件名称
        params: 事件参数

    Returns:
        收到事件的客户端数量
    """
```

### WebSocket 端点

**WebSocket 端点** (`/ws`):
- 主 WebSocket 端点供客户端连接
- 协议：JSON-RPC 风格消息帧
- 首帧必须是 `connect` 请求
- 认证：本地直连、token、password（将来）
- 内置方法：
  - `connect`: 建立连接
  - `ping`: 心跳检测
  - `get_status`: 获取连接状态

**测试页面** (`/ws-test`):
- 交互式 HTML WebSocket 测试客户端
- 提供连接/断开/Ping/获取状态按钮
- 支持发送自定义请求
- 实时显示发送/接收的消息

---

## 批次 7：Agent 运行时 - 模型调用 (2026-02-13)

---

## openclaw_py.agents.types
路径: openclaw_py/agents/types.py

```python
from openclaw_py.agents.types import (
    ModelRef,
    UsageInfo,
    AgentMessage,
    AgentResponse,
    StreamChunk,
    ModelInfo,
    ProviderConfig,
    validate_message_role,
)
```

### 数据模型

**ModelRef** (Pydantic):
```python
class ModelRef(BaseModel):
    """AI 模型引用（provider/model 格式）"""
    provider: str  # 提供商 ID（如 "anthropic", "openai"）
    model: str  # 模型 ID（如 "claude-opus-4-6", "gpt-4-turbo"）

    def __str__(self) -> str:
        """返回 'provider/model' 格式"""
```

**UsageInfo** (Pydantic):
```python
class UsageInfo(BaseModel):
    """AI 模型 token 用量信息"""
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_creation_tokens: int | None = None
    total_tokens: int | None = None

    def has_usage(self) -> bool:
        """检查是否有任何 token 使用记录"""
```

**AgentMessage** (Pydantic):
```python
class AgentMessage(BaseModel):
    """Agent 对话消息"""
    role: Literal["system", "user", "assistant"]
    content: str
```

**AgentResponse** (Pydantic):
```python
class AgentResponse(BaseModel):
    """Agent 响应（非流式）"""
    content: str
    usage: UsageInfo | None = None
    model: str | None = None
    finish_reason: str | None = None
```

**StreamChunk** (Pydantic):
```python
class StreamChunk(BaseModel):
    """流式响应块"""
    delta: str  # 增量文本内容
```

**ModelInfo** (Pydantic):
```python
class ModelInfo(BaseModel):
    """模型元数据"""
    id: str  # 模型 ID
    name: str | None = None  # 显示名称
    provider: str  # 提供商
    api: str | None = None  # API 类型
    context_window: int | None = None  # 上下文窗口大小
    max_tokens: int | None = None  # 最大输出 token
    temperature: float | None = None  # 默认温度
    cost_per_mtok_input: float | None = None  # 输入成本（每百万 token）
    cost_per_mtok_output: float | None = None  # 输出成本（每百万 token）
    cost_per_mtok_cache_read: float | None = None  # 缓存读取成本
    cost_per_mtok_cache_write: float | None = None  # 缓存写入成本
```

**ProviderConfig** (Pydantic):
```python
class ProviderConfig(BaseModel):
    """AI 提供商配置"""
    name: str  # 提供商名称
    api_key: str | None = None  # API 密钥
    base_url: str | None = None  # 自定义 API 端点
    timeout: float | None = None  # 请求超时（秒）
    max_retries: int | None = None  # 最大重试次数
```

### 函数

```python
def validate_message_role(role: str) -> bool:
    """验证消息角色是否有效"""
```

---

## openclaw_py.agents.defaults
路径: openclaw_py/agents/defaults.py

```python
from openclaw_py.agents.defaults import (
    DEFAULT_PROVIDER,
    DEFAULT_MODEL,
    DEFAULT_CONTEXT_TOKENS,
    DEFAULT_MAX_TOKENS,
    DEFAULT_TEMPERATURE,
)
```

### 常量

```python
DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-sonnet-4-5"
DEFAULT_CONTEXT_TOKENS = 200_000
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TEMPERATURE = 1.0
```

---

## openclaw_py.agents.usage
路径: openclaw_py/agents/usage.py

```python
from openclaw_py.agents.usage import (
    normalize_usage,
    derive_prompt_tokens,
    merge_usage,
)
```

### 函数

```python
def normalize_usage(raw: dict[str, Any] | Any | None) -> UsageInfo | None:
    """规范化不同提供商的 token 用量格式

    支持格式：
    - Anthropic: input_tokens, output_tokens, cache_*
    - OpenAI: prompt_tokens, completion_tokens
    - litellm: inputTokens, outputTokens

    自动计算 total_tokens 如果未提供。
    """

def derive_prompt_tokens(total: int | None, completion: int | None) -> int | None:
    """从 total 和 completion 推导 prompt tokens（OpenAI 格式）"""

def merge_usage(usage1: UsageInfo | None, usage2: UsageInfo | None) -> UsageInfo | None:
    """合并两个 UsageInfo 对象（累加所有 token 计数）"""
```

---

## openclaw_py.agents.model_selection
路径: openclaw_py/agents/model_selection.py

```python
from openclaw_py.agents.model_selection import (
    normalize_provider_id,
    normalize_model_id,
    parse_model_ref,
    model_key,
    ANTHROPIC_MODEL_ALIASES,
    OPENAI_MODEL_ALIASES,
)
```

### 常量

```python
ANTHROPIC_MODEL_ALIASES = {
    "opus-4.6": "claude-opus-4-6",
    "sonnet-4.5": "claude-sonnet-4-5",
    "haiku-4.5": "claude-haiku-4-5",
}

OPENAI_MODEL_ALIASES = {
    "gpt-4": "gpt-4-turbo",
}
```

### 函数

```python
def normalize_provider_id(provider: str) -> str:
    """规范化提供商 ID

    - 转小写，去除空白
    - "Z.AI" → "zai"
    - "opencode-zen" → "opencode"
    - "qwen" → "qwen-portal"
    """

def normalize_model_id(provider: str, model: str) -> str:
    """规范化模型 ID

    - 转小写，去除空白
    - 处理提供商特定别名（如 "opus-4.6" → "claude-opus-4-6"）
    - 替换 "." 为 "-"
    - Anthropic: 自动添加 "claude-" 前缀
    """

def parse_model_ref(
    raw: str,
    default_provider: str = DEFAULT_PROVIDER,
) -> ModelRef | None:
    """解析模型引用字符串

    支持格式：
    - "provider/model" - 显式提供商
    - "model" - 使用默认提供商

    示例：
    - "anthropic/opus-4.6" → ModelRef(provider="anthropic", model="claude-opus-4-6")
    - "gpt-4" → ModelRef(provider="openai", model="gpt-4-turbo")
    """

def model_key(provider: str, model: str) -> str:
    """生成模型键（provider/model 格式）"""
```

---

## openclaw_py.agents.model_catalog
路径: openclaw_py/agents/model_catalog.py

```python
from openclaw_py.agents.model_catalog import (
    load_model_catalog,
    get_model_info,
    list_models,
    get_model_context_window,
    get_model_max_tokens,
    get_model_temperature,
)
```

### 函数

```python
def load_model_catalog(config: OpenClawConfig | None = None) -> dict[str, ModelInfo]:
    """从配置加载模型目录

    从 config.models.providers 中加载所有模型定义。

    Returns:
        字典映射 "provider/model" → ModelInfo
    """

def get_model_info(
    provider: str,
    model: str,
    catalog: dict[str, ModelInfo] | None = None,
    config: OpenClawConfig | None = None,
) -> ModelInfo | None:
    """获取模型元数据信息

    Args:
        provider: 提供商 ID
        model: 模型 ID
        catalog: 预加载的模型目录（可选）
        config: OpenClaw 配置（如果 catalog 为 None 则使用）

    Returns:
        ModelInfo 如果找到，否则 None
    """

def list_models(
    provider: str | None = None,
    catalog: dict[str, ModelInfo] | None = None,
    config: OpenClawConfig | None = None,
) -> list[ModelInfo]:
    """列出可用模型

    Args:
        provider: 仅列出该提供商的模型（可选，None 表示全部）
        catalog: 预加载的模型目录（可选）
        config: OpenClaw 配置（如果 catalog 为 None 则使用）

    Returns:
        ModelInfo 列表
    """

def get_model_context_window(
    provider: str,
    model: str,
    catalog: dict[str, ModelInfo] | None = None,
    config: OpenClawConfig | None = None,
) -> int:
    """获取模型上下文窗口大小

    Returns:
        上下文窗口大小（如果未知则返回 DEFAULT_CONTEXT_TOKENS）
    """

def get_model_max_tokens(
    provider: str,
    model: str,
    catalog: dict[str, ModelInfo] | None = None,
    config: OpenClawConfig | None = None,
) -> int:
    """获取模型最大输出 token 数

    Returns:
        最大输出 token（如果未知则返回 DEFAULT_MAX_TOKENS）
    """

def get_model_temperature(
    provider: str,
    model: str,
    catalog: dict[str, ModelInfo] | None = None,
    config: OpenClawConfig | None = None,
) -> float:
    """获取模型默认温度

    Returns:
        默认温度（如果未知则返回 DEFAULT_TEMPERATURE）
    """
```

---

## openclaw_py.agents.providers.base
路径: openclaw_py/agents/providers/base.py

```python
from openclaw_py.agents.providers.base import BaseProvider
```

### 基础提供商类

**BaseProvider** (抽象类):
```python
class BaseProvider(ABC):
    """AI 模型提供商抽象基类

    所有提供商必须实现 create_message()，
    可选实现 create_message_stream() 支持流式响应。
    """

    def __init__(self, config: ProviderConfig):
        """初始化提供商

        Args:
            config: 提供商配置
        """

    @abstractmethod
    async def create_message(
        self,
        messages: list[AgentMessage],
        model: str,
        max_tokens: int | None = None,
        temperature: float | None = None,
        system: str | None = None,
        **kwargs,
    ) -> AgentResponse:
        """创建消息（非流式）

        Args:
            messages: 对话消息列表
            model: 模型标识符
            max_tokens: 最大生成 token 数
            temperature: 采样温度 (0.0-2.0)
            system: 系统提示词
            **kwargs: 提供商特定参数

        Returns:
            AgentResponse 包含生成内容和用量

        Raises:
            Exception: API 调用失败
        """

    async def create_message_stream(
        self,
        messages: list[AgentMessage],
        model: str,
        max_tokens: int | None = None,
        temperature: float | None = None,
        system: str | None = None,
        **kwargs,
    ) -> AsyncGenerator[StreamChunk, None]:
        """创建流式消息（可选）

        Args:
            messages: 对话消息列表
            model: 模型标识符
            max_tokens: 最大生成 token 数
            temperature: 采样温度 (0.0-2.0)
            system: 系统提示词
            **kwargs: 提供商特定参数

        Yields:
            StreamChunk 对象（包含增量内容）

        Raises:
            NotImplementedError: 如果不支持流式
            Exception: API 调用失败
        """

    def supports_streaming(self) -> bool:
        """检查提供商是否支持流式

        Returns:
            True 如果支持流式
        """
```

---

## openclaw_py.agents.providers.anthropic_provider
路径: openclaw_py/agents/providers/anthropic_provider.py

```python
from openclaw_py.agents.providers.anthropic_provider import AnthropicProvider
```

### Anthropic Claude 提供商

**AnthropicProvider** (BaseProvider):
```python
class AnthropicProvider(BaseProvider):
    """Anthropic Claude API 提供商

    支持：
    - Claude 3/4 系列模型
    - 流式和非流式响应
    - 系统提示词
    - Prompt caching（缓存）
    """

    def __init__(self, config: ProviderConfig):
        """初始化 Anthropic 提供商

        Args:
            config: 提供商配置（包含 api_key, base_url 等）
        """

    async def create_message(...) -> AgentResponse:
        """实现非流式消息创建"""

    async def create_message_stream(...) -> AsyncGenerator[StreamChunk, None]:
        """实现流式消息创建"""
```

---

## openclaw_py.agents.providers.openai_provider
路径: openclaw_py/agents/providers/openai_provider.py

```python
from openclaw_py.agents.providers.openai_provider import OpenAIProvider
```

### OpenAI 提供商

**OpenAIProvider** (BaseProvider):
```python
class OpenAIProvider(BaseProvider):
    """OpenAI API 提供商

    支持：
    - GPT-4/3.5 系列模型
    - 流式和非流式响应
    - 系统消息（作为消息列表第一条）
    """

    def __init__(self, config: ProviderConfig):
        """初始化 OpenAI 提供商

        Args:
            config: 提供商配置（包含 api_key, base_url 等）
        """

    async def create_message(...) -> AgentResponse:
        """实现非流式消息创建"""

    async def create_message_stream(...) -> AsyncGenerator[StreamChunk, None]:
        """实现流式消息创建"""
```

---

## openclaw_py.agents.providers.litellm_provider
路径: openclaw_py/agents/providers/litellm_provider.py

```python
from openclaw_py.agents.providers.litellm_provider import LiteLLMProvider
```

### LiteLLM 多模型提供商

**LiteLLMProvider** (BaseProvider):
```python
class LiteLLMProvider(BaseProvider):
    """LiteLLM 统一 API 提供商

    支持：
    - 多种模型提供商（Google Gemini, Azure OpenAI 等）
    - 统一接口
    - 流式和非流式响应
    """

    def __init__(self, config: ProviderConfig):
        """初始化 LiteLLM 提供商

        Args:
            config: 提供商配置
        """

    async def create_message(...) -> AgentResponse:
        """实现非流式消息创建"""

    async def create_message_stream(...) -> AsyncGenerator[StreamChunk, None]:
        """实现流式消息创建"""
```

---

## openclaw_py.agents.runtime
路径: openclaw_py/agents/runtime.py

```python
from openclaw_py.agents.runtime import (
    get_provider_from_config,
    create_agent_message,
)
```

### Agent 运行时函数

```python
def get_provider_from_config(
    provider_name: str,
    config: OpenClawConfig | None = None,
) -> BaseProvider | None:
    """从配置获取提供商实例

    Args:
        provider_name: 提供商名称（"anthropic", "openai" 等）
        config: OpenClaw 配置

    Returns:
        提供商实例，如果未配置则返回 None

    支持的提供商：
    - anthropic → AnthropicProvider
    - openai → OpenAIProvider
    - 其他 → LiteLLMProvider（通用）
    """

async def create_agent_message(
    messages: list[AgentMessage],
    model_ref: ModelRef | str,
    config: OpenClawConfig | None = None,
    stream: bool = False,
    max_tokens: int | None = None,
    temperature: float | None = None,
    system: str | None = None,
    **kwargs,
) -> AgentResponse | AsyncGenerator[StreamChunk, None]:
    """创建 Agent 消息（主入口）

    Args:
        messages: 对话消息列表
        model_ref: 模型引用（ModelRef 对象或 "provider/model" 字符串）
        config: OpenClaw 配置
        stream: 是否使用流式响应
        max_tokens: 最大生成 token 数
        temperature: 采样温度
        system: 系统提示词
        **kwargs: 提供商特定参数

    Returns:
        如果 stream=False，返回 AgentResponse
        如果 stream=True，返回 AsyncGenerator[StreamChunk, None]

    Raises:
        ValueError: 模型引用无效或提供商未配置
        Exception: API 调用失败
    """
```

---

## 批次 8：Agent 上下文 + 用量 (2026-02-13)

---

## openclaw_py.agents.context_window
路径: openclaw_py/agents/context_window.py

```python
from openclaw_py.agents.context_window import (
    CONTEXT_WINDOW_HARD_MIN_TOKENS,
    CONTEXT_WINDOW_WARN_BELOW_TOKENS,
    ContextWindowInfo,
    ContextWindowGuardResult,
    resolve_context_window_info,
    evaluate_context_window_guard,
)
```

### 常量

```python
CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000  # 硬性最小上下文窗口
CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000  # 警告阈值
```

### 数据模型

**ContextWindowInfo** (NamedTuple):
```python
class ContextWindowInfo(NamedTuple):
    """上下文窗口大小信息

    Attributes:
        tokens: 上下文窗口大小（token 数）
        source: 来源（"model" | "modelsConfig" | "agentContextTokens" | "default"）
    """
    tokens: int
    source: ContextWindowSource
```

**ContextWindowGuardResult** (NamedTuple):
```python
class ContextWindowGuardResult(NamedTuple):
    """上下文窗口守卫评估结果

    Attributes:
        tokens: 上下文窗口大小
        source: 来源
        should_warn: 是否应该警告（< 32K）
        should_block: 是否应该阻止（< 16K）
    """
    tokens: int
    source: ContextWindowSource
    should_warn: bool
    should_block: bool
```

### 函数

```python
def resolve_context_window_info(
    cfg: OpenClawConfig | None,
    provider: str,
    model_id: str,
    model_context_window: int | None = None,
    default_tokens: int = DEFAULT_CONTEXT_TOKENS,
) -> ContextWindowInfo:
    """从多个来源解析上下文窗口大小

    优先级：modelsConfig > model_context_window > default_tokens
    如果配置了 agentContextTokens 上限，会应用该上限。
    """

def evaluate_context_window_guard(
    info: ContextWindowInfo,
    warn_below_tokens: int | None = None,
    hard_min_tokens: int | None = None,
) -> ContextWindowGuardResult:
    """评估上下文窗口是否应触发警告或阻止"""
```

---

## openclaw_py.agents.token_estimation
路径: openclaw_py/agents/token_estimation.py

```python
from openclaw_py.agents.token_estimation import (
    estimate_tokens,
    estimate_messages_tokens,
)
```

### 函数

```python
def estimate_tokens(message: AgentMessage) -> int:
    """估算单条消息的 token 数
    
    使用简单启发式：字符数 / 4 + 角色开销
    支持字符串和结构化内容（list）
    """

def estimate_messages_tokens(messages: list[AgentMessage]) -> int:
    """估算消息列表的总 token 数"""
```

---

## openclaw_py.agents.message_chunking
路径: openclaw_py/agents/message_chunking.py

```python
from openclaw_py.agents.message_chunking import (
    BASE_CHUNK_RATIO,
    MIN_CHUNK_RATIO,
    SAFETY_MARGIN,
    split_messages_by_token_share,
    chunk_messages_by_max_tokens,
    compute_adaptive_chunk_ratio,
    is_oversized_for_summary,
)
```

### 常量

```python
BASE_CHUNK_RATIO = 0.4  # 基础分块比例（上下文的 40%）
MIN_CHUNK_RATIO = 0.15  # 最小分块比例（上下文的 15%）
SAFETY_MARGIN = 1.2  # 安全边际（20% 缓冲）
```

### 函数

```python
def split_messages_by_token_share(
    messages: list[AgentMessage],
    parts: int = 2,
) -> list[list[AgentMessage]]:
    """按 token 份额分割消息（用于并行总结）"""

def chunk_messages_by_max_tokens(
    messages: list[AgentMessage],
    max_tokens: int,
) -> list[list[AgentMessage]]:
    """按最大 token 数分割消息"""

def compute_adaptive_chunk_ratio(
    messages: list[AgentMessage],
    context_window: int,
) -> float:
    """计算自适应分块比例（基于平均消息大小）"""

def is_oversized_for_summary(
    message: AgentMessage,
    context_window: int,
) -> bool:
    """检查单条消息是否过大无法总结（> 50% 上下文窗口）"""
```

---

## openclaw_py.agents.compaction
路径: openclaw_py/agents/compaction.py

```python
from openclaw_py.agents.compaction import (
    PruneHistoryResult,
    prune_history_for_context_share,
)
```

### 数据模型

**PruneHistoryResult** (NamedTuple):
```python
class PruneHistoryResult(NamedTuple):
    """历史修剪结果

    Attributes:
        messages: 修剪后保留的消息
        dropped_messages_list: 被删除的消息列表
        dropped_chunks: 删除的块数
        dropped_messages: 删除的消息总数
        dropped_tokens: 删除的 token 总数
        kept_tokens: 保留的 token 总数
        budget_tokens: 强制执行的 token 预算
    """
    messages: list[AgentMessage]
    dropped_messages_list: list[AgentMessage]
    dropped_chunks: int
    dropped_messages: int
    dropped_tokens: int
    kept_tokens: int
    budget_tokens: int
```

### 函数

```python
def prune_history_for_context_share(
    messages: list[AgentMessage],
    max_context_tokens: int,
    max_history_share: float = 0.5,
    parts: int = 2,
) -> PruneHistoryResult:
    """修剪消息历史以适应上下文窗口预算
    
    删除最旧的消息块，直到历史适应预算。
    每次删除后修复 tool_use/tool_result 配对。
    """
```

---

## openclaw_py.agents.transcript_repair
路径: openclaw_py/agents/transcript_repair.py

```python
from openclaw_py.agents.transcript_repair import (
    ToolUseRepairReport,
    ToolCallInputRepairReport,
    repair_tool_use_result_pairing,
    repair_tool_call_inputs,
    make_missing_tool_result,
)
```

### 数据模型

**ToolUseRepairReport** (NamedTuple):
```python
class ToolUseRepairReport(NamedTuple):
    """tool_use/tool_result 修复报告"""
    messages: list[AgentMessage]
    added: list[AgentMessage]  # 添加的合成 tool_result
    dropped_duplicate_count: int  # 删除的重复数
    dropped_orphan_count: int  # 删除的孤立数
    moved: bool  # 是否移动了 tool_result
```

**ToolCallInputRepairReport** (NamedTuple):
```python
class ToolCallInputRepairReport(NamedTuple):
    """tool_call 输入修复报告"""
    messages: list[AgentMessage]
    dropped_tool_calls: int  # 删除的无效 tool_call
    dropped_assistant_messages: int  # 删除的空消息
```

### 函数

```python
def repair_tool_use_result_pairing(
    messages: list[AgentMessage],
) -> ToolUseRepairReport:
    """修复 tool_use/tool_result 配对问题
    
    - 移动匹配的 tool_result 到 assistant 后
    - 为缺失 ID 插入合成错误 tool_result
    - 删除重复和孤立的 tool_result
    """

def repair_tool_call_inputs(
    messages: list[AgentMessage],
) -> ToolCallInputRepairReport:
    """修复缺少 input/arguments 的 tool_call
    
    删除无效的 tool_call 块。
    """

def make_missing_tool_result(
    tool_call_id: str,
    tool_name: str | None = None,
) -> AgentMessage:
    """创建缺失 tool_result 的合成错误消息"""
```

---

## openclaw_py.agents.usage (批次 8 增强)
路径: openclaw_py/agents/usage.py

### 批次 8 新增函数

```python
from openclaw_py.agents.usage import (
    # 批次 7 已有：normalize_usage, derive_prompt_tokens, merge_usage
    # 批次 8 新增：
    has_nonzero_usage,
    derive_session_total_tokens,
)

def has_nonzero_usage(usage: UsageInfo | None) -> bool:
    """检查用量是否有任何非零 token 计数"""

def derive_session_total_tokens(
    usage: UsageInfo | None,
    context_tokens: int | None = None,
) -> int | None:
    """计算会话总 token 数（input + cache，限制在上下文窗口内）"""
```

---

## openclaw_py.agents.types (批次 8 增强)
路径: openclaw_py/agents/types.py

### 批次 8 变更

**AgentMessage** 类型增强：
```python
class AgentMessage(BaseModel):
    """对话消息（批次 8 增强：支持结构化内容）"""

    # 批次 8：新增 "toolResult" 角色
    role: Literal["system", "user", "assistant", "toolResult"]

    # 批次 8：content 支持 list（用于 tool_use blocks）
    content: str | list[Any]

    name: str | None = None
    metadata: dict[str, Any] | None = None
```

---

## 批次 9：Agent 工具 + Skills (2026-02-13)

---

## openclaw_py.agents.tools.types
路径: openclaw_py/agents/tools/types.py

```python
from openclaw_py.agents.tools.types import (
    AnyAgentTool,
    AgentTool,
    ToolContext,
    ToolExecuteFunc,
    ToolParameter,
    ToolPolicy,
    ToolProfile,
    ToolResult,
)
```

### 数据模型

**ToolParameter** (Pydantic):
```python
class ToolParameter(BaseModel):
    """工具参数定义"""
    type: Literal["string", "number", "boolean", "array", "object"]
    description: str | None = None
    required: bool = False
    default: Any = None
    items: dict[str, Any] | None = None  # array 类型
    properties: dict[str, Any] | None = None  # object 类型
    enum: list[str] | None = None  # string 枚举
    minimum: float | None = None
    maximum: float | None = None
```

**ToolResult** (Pydantic):
```python
class ToolResult(BaseModel):
    """工具执行结果"""
    content: str  # 文本内容（必需）
    is_error: bool = False  # 是否为错误
    images: list[dict[str, Any]] = []  # 图片列表
    metadata: dict[str, Any] | None = None  # 额外元数据
```

**ToolContext** (Pydantic):
```python
class ToolContext(BaseModel):
    """工具执行上下文"""
    cwd: str | None = None  # 工作目录
    sandbox_root: str | None = None  # Sandbox 根目录
    sandboxed: bool = False  # 是否为沙箱环境
    agent_session_key: str | None = None  # Agent 会话密钥
    agent_channel: str | None = None  # Agent 频道
    agent_account_id: str | None = None  # Agent 账号 ID
    config: Any = None  # 配置（避免循环导入）
```

**AgentTool** (Pydantic):
```python
class AgentTool(BaseModel):
    """Agent 工具定义（与 Anthropic SDK 兼容）"""
    name: str  # 工具名称（唯一标识符）
    description: str  # 工具描述
    input_schema: dict[str, Any] = {}  # 参数 schema（JSON Schema）
    execute: ToolExecuteFunc | None = None  # 执行函数
```

**ToolPolicy** (Pydantic):
```python
class ToolPolicy(BaseModel):
    """工具策略配置"""
    allow: list[str] = []  # 允许的工具列表（工具名或 group:name）
    deny: list[str] = []  # 拒绝的工具列表
```

**ToolProfile** (Pydantic):
```python
class ToolProfile(BaseModel):
    """工具配置文件（预设策略）"""
    id: Literal["minimal", "coding", "messaging", "full"]
    policy: ToolPolicy
```

### 类型别名

```python
ToolExecuteFunc = Callable[[dict[str, Any], ToolContext | None], Awaitable[ToolResult]]
AnyAgentTool = AgentTool
```

---

## openclaw_py.agents.tools.common
路径: openclaw_py/agents/tools/common.py

```python
from openclaw_py.agents.tools.common import (
    # 参数读取
    read_string_param,
    read_string_or_number_param,
    read_number_param,
    read_int_param,
    read_bool_param,
    read_list_param,
    read_dict_param,
    # 结果格式化
    text_result,
    json_result,
    error_result,
    success_result,
)
```

### 参数读取函数

```python
def read_string_param(
    params: dict[str, Any],
    key: str,
    *,
    required: bool = False,
    trim: bool = True,
    label: str | None = None,
    allow_empty: bool = False,
) -> str | None:
    """从参数中读取字符串"""

def read_number_param(
    params: dict[str, Any],
    key: str,
    *,
    required: bool = False,
    label: str | None = None,
    min_value: float | None = None,
    max_value: float | None = None,
) -> float | None:
    """从参数中读取数字"""

def read_int_param(...) -> int | None:
    """从参数中读取整数"""

def read_bool_param(
    params: dict[str, Any],
    key: str,
    *,
    default: bool | None = None,
) -> bool | None:
    """从参数中读取布尔值"""
```

### 结果格式化函数

```python
def text_result(content: str, is_error: bool = False) -> ToolResult:
    """创建纯文本工具结果"""

def json_result(
    data: Any,
    *,
    is_error: bool = False,
    pretty: bool = False,
) -> ToolResult:
    """创建 JSON 工具结果"""

def error_result(message: str, details: dict[str, Any] | None = None) -> ToolResult:
    """创建错误工具结果"""

def success_result(message: str, data: dict[str, Any] | None = None) -> ToolResult:
    """创建成功工具结果"""
```

---

## openclaw_py.agents.tools.policy
路径: openclaw_py/agents/tools/policy.py

```python
from openclaw_py.agents.tools.policy import (
    normalize_tool_name,
    is_owner_only_tool_name,
    expand_tool_groups,
    is_tool_allowed_by_policy,
    filter_tools_by_policy,
    apply_owner_only_tool_policy,
    resolve_tool_profile_policy,
    get_tool_profile,
    TOOL_GROUPS,
    TOOL_PROFILES,
)
```

### 常量

```python
TOOL_GROUPS: dict[str, list[str]] = {
    "group:memory": ["memory_search", "memory_get"],
    "group:web": ["web_search", "web_fetch"],
    "group:fs": ["read", "write", "edit", "apply_patch"],
    "group:runtime": ["exec", "process"],
    "group:sessions": ["sessions_list", "sessions_history", ...],
    "group:ui": ["browser", "canvas"],
    "group:automation": ["cron", "gateway"],
    "group:messaging": ["message"],
    "group:openclaw": [...]  # 所有 OpenClaw 原生工具
}

TOOL_PROFILES: dict[str, ToolPolicy] = {
    "minimal": ToolPolicy(allow=["session_status"]),
    "coding": ToolPolicy(allow=["group:fs", "group:runtime", ...]),
    "messaging": ToolPolicy(allow=["group:messaging", ...]),
    "full": ToolPolicy(allow=[], deny=[]),
}
```

### 函数

```python
def normalize_tool_name(name: str) -> str:
    """规范化工具名称（小写，应用别名）"""

def expand_tool_groups(names: list[str]) -> set[str]:
    """展开工具组为具体工具名称"""

def is_tool_allowed_by_policy(tool_name: str, policy: ToolPolicy) -> bool:
    """检查工具是否被策略允许"""

def filter_tools_by_policy(
    tools: list[AnyAgentTool],
    policy: ToolPolicy,
) -> list[AnyAgentTool]:
    """根据策略过滤工具列表"""

def apply_owner_only_tool_policy(
    tools: list[AnyAgentTool],
    sender_is_owner: bool,
) -> list[AnyAgentTool]:
    """应用 owner-only 工具策略"""

def resolve_tool_profile_policy(
    profile_id: Literal["minimal", "coding", "messaging", "full"] | None,
) -> ToolPolicy:
    """解析工具配置文件策略"""
```

---

## openclaw_py.agents.tools.bash_exec
路径: openclaw_py/agents/tools/bash_exec.py

```python
from openclaw_py.agents.tools.bash_exec import create_exec_tool
```

### 函数

```python
def create_exec_tool() -> AgentTool:
    """创建 exec 工具（Bash 命令执行）

    工具参数：
    - command: str - 要执行的 bash 命令
    - timeout_seconds: number - 超时（默认 120）
    - max_output_chars: number - 最大输出字符数（默认 200000）

    安全特性：
    - 非沙箱环境阻止危险环境变量
    - 不允许自定义 PATH
    - 超时保护
    """
```

---

## openclaw_py.agents.tools.web_fetch
路径: openclaw_py/agents/tools/web_fetch.py

```python
from openclaw_py.agents.tools.web_fetch import create_web_fetch_tool
```

### 函数

```python
def create_web_fetch_tool() -> AgentTool:
    """创建 web_fetch 工具（URL 获取）

    工具参数：
    - url: str - HTTP/HTTPS URL
    - max_chars: number - 最大字符数（默认 50000）

    功能：
    - 使用 httpx 获取 URL 内容
    - 自动跟随重定向
    - 内容截断
    """
```

---

## openclaw_py.agents.tools.web_search
路径: openclaw_py/agents/tools/web_search.py

```python
from openclaw_py.agents.tools.web_search import create_web_search_tool
```

### 函数

```python
def create_web_search_tool() -> AgentTool:
    """创建 web_search 工具（搜索引擎）

    工具参数：
    - query: str - 搜索查询

    注：当前为占位符实现，需要集成搜索 API
    """
```

---

## openclaw_py.agents.tools.create_tools
路径: openclaw_py/agents/tools/create_tools.py

```python
from openclaw_py.agents.tools.create_tools import (
    create_openclaw_tools,
    create_coding_tools,
    get_tool_context,
)
```

### 函数

```python
def create_openclaw_tools(
    *,
    config: OpenClawConfig | None = None,
    sandboxed: bool = False,
    agent_session_key: str | None = None,
    agent_channel: str | None = None,
    agent_account_id: str | None = None,
    cwd: str | None = None,
    sandbox_root: str | None = None,
) -> list[AnyAgentTool]:
    """创建 OpenClaw 工具集

    Returns:
        工具列表（exec, web_search, web_fetch 等）
    """

def create_coding_tools(
    *,
    config: OpenClawConfig | None = None,
    cwd: str | None = None,
    sandbox_root: str | None = None,
) -> list[AnyAgentTool]:
    """创建编码工具集（Bash + File 操作）"""

def get_tool_context(
    *,
    config: OpenClawConfig | None = None,
    sandboxed: bool = False,
    cwd: str | None = None,
    sandbox_root: str | None = None,
    agent_session_key: str | None = None,
    agent_channel: str | None = None,
    agent_account_id: str | None = None,
) -> ToolContext:
    """创建工具执行上下文"""
```

---

## openclaw_py.agents.skills.types
路径: openclaw_py/agents/skills/types.py

```python
from openclaw_py.agents.skills.types import (
    Skill,
    SkillEntry,
    SkillSnapshot,
    SkillInstallSpec,
    SkillCommandSpec,
    SkillsInstallPreferences,
    OpenClawSkillMetadata,
    SkillInvocationPolicy,
)
```

### 数据模型

**Skill** (Pydantic):
```python
class Skill(BaseModel):
    """Skill 定义"""
    name: str  # Skill 名称
    description: str  # Skill 描述
    content: str  # Skill 内容（Markdown）
    meta: OpenClawSkillMetadata = {}
```

**SkillEntry** (Pydantic):
```python
class SkillEntry(BaseModel):
    """Skill 条目"""
    skill: Skill
    frontmatter: dict[str, str] = {}  # YAML frontmatter
    metadata: OpenClawSkillMetadata | None = None
    invocation: SkillInvocationPolicy | None = None
```

**SkillSnapshot** (Pydantic):
```python
class SkillSnapshot(BaseModel):
    """Skill 快照"""
    prompt: str  # Skills prompt 文本
    skills: list[dict[str, Any]] = []  # Skill 列表
    resolved_skills: list[Skill] | None = None
    version: int | None = None
```

**OpenClawSkillMetadata** (Pydantic):
```python
class OpenClawSkillMetadata(BaseModel):
    """Skill 元数据"""
    always: bool = False  # 是否总是加载
    skill_key: str | None = None
    primary_env: str | None = None
    emoji: str | None = None
    homepage: str | None = None
    os: list[str] = []  # 支持的操作系统
    requires: dict[str, Any] = {}  # 依赖要求
    install: list[SkillInstallSpec] = []  # 安装规范
```

---

## openclaw_py.agents.skills.workspace
路径: openclaw_py/agents/skills/workspace.py

```python
from openclaw_py.agents.skills.workspace import (
    load_workspace_skill_entries,
    build_workspace_skill_snapshot,
    build_workspace_skills_prompt,
)
```

### 函数

```python
async def load_workspace_skill_entries(
    workspace_dir: str | Path,
) -> list[SkillEntry]:
    """从工作区加载 Skill 条目

    扫描 .claude/skills/ 目录中的 .md 文件
    """

async def build_workspace_skill_snapshot(
    workspace_dir: str | Path,
) -> SkillSnapshot:
    """构建工作区 Skill 快照"""

def build_workspace_skills_prompt(
    snapshot: SkillSnapshot,
) -> str:
    """构建工作区 Skills prompt"""
```

---

## 批次 10：Telegram 核心 Bot (2026-02-13)

---

## openclaw_py.channels.telegram.types
路径: openclaw_py/channels/telegram/types.py

```python
from openclaw_py.channels.telegram.types import (
    TelegramStreamMode,
    TelegramMediaRef,
    TelegramBotOptions,
    TelegramMessageContext,
    StickerMetadata,
)
```

**TelegramStreamMode**: str - Draft streaming 模式 ("off" | "partial" | "block")

**TelegramMediaRef, TelegramBotOptions, TelegramMessageContext, StickerMetadata** - Pydantic 模型（完整定义见源码）

---

## openclaw_py.channels.telegram
路径: openclaw_py/channels/telegram/

```python
from openclaw_py.channels.telegram import (
    # Types
    TelegramBotOptions,
    TelegramMediaRef,
    TelegramMessageContext,
    # Bot
    TelegramBotInstance,
    create_telegram_bot,
    start_telegram_bot,
    # Accounts
    ResolvedTelegramAccount,
    resolve_telegram_account,
    list_telegram_account_ids,
    # Token
    resolve_telegram_token,
    # Helpers
    build_telegram_group_peer_id,
    normalize_telegram_chat_type,
    # Context
    build_telegram_message_context,
    # Updates
    TelegramUpdateDedupe,
    create_telegram_update_dedupe,
    MediaGroupBuffer,
    # Monitoring
    monitor_telegram_provider,
    get_telegram_bot_info,
)
```

### 核心功能

**Bot 创建**:
```python
async def create_telegram_bot(
    token: str | None = None,
    account_id: str = "default",
    config: OpenClawConfig | None = None,
    **options,
) -> TelegramBotInstance:
    """创建 Telegram bot（aiogram 3.x）"""
```

**账户管理**:
```python
def resolve_telegram_account(
    config: OpenClawConfig,
    account_id: str | None = None,
) -> ResolvedTelegramAccount:
    """解析 Telegram 账户（支持多账户）"""
```

**消息上下文**:
```python
def build_telegram_message_context(
    message: dict,
    account_id: str,
    config: OpenClawConfig,
    account_config: TelegramAccountConfig,
) -> TelegramMessageContext | None:
    """构建消息上下文（会话密钥、权限、媒体）"""
```

**监控**:
```python
async def monitor_telegram_provider(
    config: OpenClawConfig,
    interval_seconds: int = 60,
) -> None:
    """周期性健康检查"""
```

---

## openclaw_py.channels.telegram.caption
路径: openclaw_py/channels/telegram/caption.py

```python
from openclaw_py.channels.telegram.caption import (
    TELEGRAM_MAX_CAPTION_LENGTH,
    split_telegram_caption,
)

TELEGRAM_MAX_CAPTION_LENGTH = 1024

def split_telegram_caption(text: str | None) -> dict[str, str | None]:
    """Split caption if exceeds 1024 chars. Returns dict with caption/followUpText."""
```

---

## openclaw_py.channels.telegram.format
路径: openclaw_py/channels/telegram/format.py

```python
from openclaw_py.channels.telegram.format import (
    MarkdownTableMode,
    TelegramFormattedChunk,
    escape_html,
    escape_html_attr,
    markdown_to_telegram_html_basic,
    render_telegram_html_text,
    markdown_to_telegram_html,
    markdown_to_telegram_chunks,
    markdown_to_telegram_html_chunks,
)

MarkdownTableMode = Literal["text", "code", "skip"]

class TelegramFormattedChunk(NamedTuple):
    html: str
    text: str

def escape_html(text: str) -> str: ...
def escape_html_attr(text: str) -> str: ...
def markdown_to_telegram_html_basic(markdown_text: str) -> str: ...
def render_telegram_html_text(
    text: str,
    text_mode: Literal["markdown", "html"] = "markdown",
    table_mode: MarkdownTableMode = "text",
) -> str: ...
def markdown_to_telegram_html(markdown: str, table_mode: MarkdownTableMode = "text") -> str: ...
def markdown_to_telegram_chunks(
    markdown: str,
    limit: int,
    table_mode: MarkdownTableMode = "text",
) -> list[TelegramFormattedChunk]: ...
def markdown_to_telegram_html_chunks(
    markdown: str,
    limit: int,
    table_mode: MarkdownTableMode = "text",
) -> list[str]: ...
```

---

## openclaw_py.channels.telegram.download
路径: openclaw_py/channels/telegram/download.py

```python
from openclaw_py.channels.telegram.download import (
    TelegramFileInfo,
    SavedMedia,
    get_telegram_file,
    download_telegram_file,
)

class TelegramFileInfo(NamedTuple):
    file_id: str
    file_unique_id: str | None = None
    file_size: int | None = None
    file_path: str | None = None

class SavedMedia(NamedTuple):
    file_path: str
    content_type: str | None
    size: int

async def get_telegram_file(
    token: str,
    file_id: str,
    timeout_ms: int = 30000,
) -> TelegramFileInfo: ...

async def download_telegram_file(
    token: str,
    info: TelegramFileInfo,
    save_dir: str | Path,
    max_bytes: int | None = None,
    timeout_ms: int = 60000,
) -> SavedMedia: ...
```

---

## openclaw_py.channels.telegram.media
路径: openclaw_py/channels/telegram/media.py

```python
from openclaw_py.channels.telegram.media import (
    MediaKind,
    LoadedMedia,
    media_kind_from_mime,
    is_gif_media,
    load_web_media,
    detect_mime_from_buffer,
)

MediaKind = Literal["photo", "video", "audio", "voice", "document", "animation", "sticker"]

class LoadedMedia(NamedTuple):
    content: bytes
    mime: str | None
    filename: str | None

def media_kind_from_mime(mime: str | None) -> MediaKind: ...
def is_gif_media(mime: str | None, filename: str | None = None) -> bool: ...
async def load_web_media(
    url: str,
    max_bytes: int | None = None,
    timeout_ms: int = 30000,
) -> LoadedMedia: ...
def detect_mime_from_buffer(buffer: bytes, filename: str | None = None) -> str | None: ...
```

---

## openclaw_py.channels.telegram.draft_chunking
路径: openclaw_py/channels/telegram/draft_chunking.py

```python
from openclaw_py.channels.telegram.draft_chunking import (
    DEFAULT_TELEGRAM_DRAFT_STREAM_MIN,
    DEFAULT_TELEGRAM_DRAFT_STREAM_MAX,
    DEFAULT_TEXT_CHUNK_LIMIT,
    BreakPreference,
    DraftChunkConfig,
    resolve_telegram_draft_streaming_chunking,
)

DEFAULT_TELEGRAM_DRAFT_STREAM_MIN = 200
DEFAULT_TELEGRAM_DRAFT_STREAM_MAX = 800
DEFAULT_TEXT_CHUNK_LIMIT = 4096

BreakPreference = Literal["paragraph", "newline", "sentence"]

class DraftChunkConfig(NamedTuple):
    min_chars: int
    max_chars: int
    break_preference: BreakPreference

def resolve_telegram_draft_streaming_chunking(
    config: OpenClawConfig | None,
    account_id: str | None = None,
) -> DraftChunkConfig: ...
```

---

## openclaw_py.channels.telegram.draft_stream
路径: openclaw_py/channels/telegram/draft_stream.py

```python
from openclaw_py.channels.telegram.draft_stream import (
    TELEGRAM_DRAFT_MAX_CHARS,
    DEFAULT_THROTTLE_MS,
    TelegramDraftStream,
    create_telegram_draft_stream,
)

TELEGRAM_DRAFT_MAX_CHARS = 4096
DEFAULT_THROTTLE_MS = 300

class TelegramDraftStream:
    def __init__(
        self,
        bot: Bot,
        chat_id: int,
        message_id: int,
        max_chars: int = TELEGRAM_DRAFT_MAX_CHARS,
        throttle_ms: int = DEFAULT_THROTTLE_MS,
        message_thread_id: int | None = None,
        log_fn: Callable[[str], None] | None = None,
        warn_fn: Callable[[str], None] | None = None,
    ): ...

    async def flush(self) -> None: ...
    def update(self, text: str) -> None: ...
    def stop(self) -> None: ...

def create_telegram_draft_stream(
    bot: Bot,
    chat_id: int,
    message_id: int,
    max_chars: int = TELEGRAM_DRAFT_MAX_CHARS,
    throttle_ms: int = DEFAULT_THROTTLE_MS,
    message_thread_id: int | None = None,
    log_fn: Callable[[str], None] | None = None,
    warn_fn: Callable[[str], None] | None = None,
) -> TelegramDraftStream: ...
```

---

## openclaw_py.channels.telegram.group_migration
路径: openclaw_py/channels/telegram/group_migration.py

```python
from openclaw_py.channels.telegram.group_migration import (
    MigrationScope,
    TelegramGroupMigrationResult,
    migrate_telegram_groups_in_place,
    resolve_account_groups,
    migrate_telegram_group_config,
)

MigrationScope = Literal["account", "global"]

class TelegramGroupMigrationResult(NamedTuple):
    migrated: bool
    skipped_existing: bool
    scopes: list[MigrationScope]

def migrate_telegram_groups_in_place(
    groups: dict[str, Any] | None,
    old_chat_id: str,
    new_chat_id: str,
) -> dict[str, bool]: ...

def resolve_account_groups(
    config: OpenClawConfig,
    account_id: str | None,
) -> dict[str, Any] | None: ...

def migrate_telegram_group_config(
    config: OpenClawConfig,
    old_chat_id: str,
    new_chat_id: str,
    account_id: str | None = None,
) -> TelegramGroupMigrationResult: ...
```

---

## openclaw_py.channels.telegram.send
路径: openclaw_py/channels/telegram/send.py

```python
from openclaw_py.channels.telegram.send import (
    TelegramSendResult,
    TelegramSendOptions,
    normalize_chat_id,
    normalize_message_id,
    build_inline_keyboard,
    send_telegram_text,
    send_telegram_photo,
    send_telegram_document,
    send_message_telegram,
)

class TelegramSendResult(NamedTuple):
    message_id: str
    chat_id: str

class TelegramSendOptions(NamedTuple):
    token: str | None = None
    account_id: str | None = None
    verbose: bool = False
    media_url: str | None = None
    max_bytes: int | None = None
    text_mode: Literal["markdown", "html"] = "markdown"
    plain_text: str | None = None
    as_voice: bool = False
    as_video_note: bool = False
    silent: bool = False
    reply_to_message_id: int | None = None
    quote_text: str | None = None
    message_thread_id: int | None = None
    buttons: list[list[dict[str, str]]] | None = None

def normalize_chat_id(to: str) -> str: ...
def normalize_message_id(raw: str | int) -> int: ...
def build_inline_keyboard(buttons: list[list[dict[str, str]]] | None) -> InlineKeyboardMarkup | None: ...

async def send_telegram_text(
    bot: Bot,
    chat_id: str | int,
    text: str,
    parse_mode: ParseMode = ParseMode.HTML,
    reply_to_message_id: int | None = None,
    message_thread_id: int | None = None,
    reply_markup: InlineKeyboardMarkup | None = None,
    disable_notification: bool = False,
) -> TelegramSendResult: ...

async def send_telegram_photo(
    bot: Bot,
    chat_id: str | int,
    photo_path: str | Path | bytes,
    caption: str | None = None,
    parse_mode: ParseMode = ParseMode.HTML,
    reply_to_message_id: int | None = None,
    message_thread_id: int | None = None,
    reply_markup: InlineKeyboardMarkup | None = None,
    disable_notification: bool = False,
) -> TelegramSendResult: ...

async def send_telegram_document(
    bot: Bot,
    chat_id: str | int,
    document_path: str | Path | bytes,
    filename: str | None = None,
    caption: str | None = None,
    parse_mode: ParseMode = ParseMode.HTML,
    reply_to_message_id: int | None = None,
    message_thread_id: int | None = None,
    reply_markup: InlineKeyboardMarkup | None = None,
    disable_notification: bool = False,
) -> TelegramSendResult: ...

async def send_message_telegram(
    to: str,
    text: str,
    config: OpenClawConfig | None = None,
    **options: Any,
) -> TelegramSendResult: ...
```

---

## openclaw_py.channels.telegram.webhook
路径: openclaw_py/channels/telegram/webhook.py

```python
from openclaw_py.channels.telegram.webhook import (
    TelegramWebhookServer,
    start_telegram_webhook,
)

class TelegramWebhookServer:
    def __init__(
        self,
        bot: Bot,
        dispatcher: Dispatcher,
        path: str,
        health_path: str,
        secret: str | None = None,
    ): ...

    async def start(
        self,
        host: str = "0.0.0.0",
        port: int = 8787,
        public_url: str | None = None,
    ) -> None: ...

    async def stop(self) -> None: ...

async def start_telegram_webhook(
    token: str | None = None,
    account_id: str = "default",
    config: OpenClawConfig | None = None,
    path: str = "/telegram-webhook",
    health_path: str = "/healthz",
    port: int = 8787,
    host: str = "0.0.0.0",
    secret: str | None = None,
    public_url: str | None = None,
    abort_signal: asyncio.Event | None = None,
    on_startup: Callable[[], None] | None = None,
) -> TelegramWebhookServer: ...
```

---


## openclaw_py.agents.auth_profiles.types
路径: openclaw_py/agents/auth_profiles/types.py

```python
from openclaw_py.agents.auth_profiles.types import (
    ApiKeyCredential,
    TokenCredential,
    OAuthCredential,
    AuthProfileCredential,
    AuthProfileFailureReason,
    ProfileUsageStats,
    AuthProfileStore,
)

class ApiKeyCredential(BaseModel):
    type: Literal["api_key"]
    provider: str
    key: str | None
    email: str | None
    metadata: dict[str, str] | None

class TokenCredential(BaseModel):
    type: Literal["token"]
    provider: str
    token: str
    expires: int | None  # ms since epoch
    email: str | None

class OAuthCredential(BaseModel):
    type: Literal["oauth"]
    provider: str
    access: str
    refresh: str | None
    expires: int | None
    client_id: str | None
    client_secret: str | None
    enterprise_url: str | None

AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential

AuthProfileFailureReason = Literal[
    "auth_error",
    "rate_limit",
    "billing",
    "overloaded",
    "network_error",
]

class ProfileUsageStats(BaseModel):
    last_used: int | None  # ms since epoch
    cooldown_until: int | None
    disabled_until: int | None
    disabled_reason: AuthProfileFailureReason | None
    error_count: int
    failure_counts: dict[AuthProfileFailureReason, int] | None
    last_failure_at: int | None

class AuthProfileStore(BaseModel):
    version: int
    profiles: dict[str, AuthProfileCredential]
    order: dict[str, list[str]] | None
    last_good: dict[str, str] | None
    usage_stats: dict[str, ProfileUsageStats] | None
```

---

## openclaw_py.agents.auth_profiles.store
路径: openclaw_py/agents/auth_profiles/store.py

```python
from openclaw_py.agents.auth_profiles.store import (
    load_auth_profile_store,
    ensure_auth_profile_store,
    save_auth_profile_store,
    update_auth_profile_store_with_lock,
)

def load_auth_profile_store(agent_dir: str | None = None) -> AuthProfileStore | None: ...

def ensure_auth_profile_store(agent_dir: str | None = None) -> AuthProfileStore: ...

def save_auth_profile_store(
    store: AuthProfileStore,
    agent_dir: str | None = None,
) -> None: ...

async def update_auth_profile_store_with_lock(
    params: dict,  # Keys: agent_dir, updater: Callable[[AuthProfileStore], bool]
) -> AuthProfileStore | None: ...
```

---

## openclaw_py.agents.auth_profiles.profiles
路径: openclaw_py.agents.auth_profiles/profiles.py

```python
from openclaw_py.agents.auth_profiles.profiles import (
    upsert_auth_profile,
    list_profiles_for_provider,
    mark_auth_profile_good,
    set_auth_profile_order,
    normalize_secret_input,
)

def normalize_secret_input(secret: str) -> str: ...

def upsert_auth_profile(
    profile_id: str,
    credential: AuthProfileCredential,
    agent_dir: str | None = None,
) -> None: ...

def list_profiles_for_provider(
    store: AuthProfileStore,
    provider: str,
) -> list[str]: ...

async def mark_auth_profile_good(
    profile_id: str,
    cfg: OpenClawConfig | None = None,
    agent_dir: str | None = None,
) -> None: ...

def set_auth_profile_order(
    provider: str,
    order: list[str],
    agent_dir: str | None = None,
) -> None: ...
```

---

## openclaw_py.agents.auth_profiles.order
路径: openclaw_py/agents/auth_profiles/order.py

```python
from openclaw_py.agents.auth_profiles.order import (
    resolve_auth_profile_order,
    sort_profiles_by_cooldown,
)

def resolve_auth_profile_order(
    cfg: OpenClawConfig | None,
    store: AuthProfileStore,
    provider: str,
    preferred_profile: str | None = None,
) -> list[str]: ...

def sort_profiles_by_cooldown(
    profile_ids: list[str],
    store: AuthProfileStore,
) -> list[str]: ...
```

---

## openclaw_py.agents.auth_profiles.usage
路径: openclaw_py/agents/auth_profiles/usage.py

```python
from openclaw_py.agents.auth_profiles.usage import (
    calculate_auth_profile_cooldown_ms,
    is_profile_in_cooldown,
    mark_auth_profile_used,
    mark_auth_profile_failure,
)

def calculate_auth_profile_cooldown_ms(error_count: int) -> int: ...

def is_profile_in_cooldown(
    store: AuthProfileStore,
    profile_id: str,
) -> bool: ...

async def mark_auth_profile_used(
    store: AuthProfileStore,
    profile_id: str,
    agent_dir: str | None = None,
) -> None: ...

async def mark_auth_profile_failure(
    store: AuthProfileStore,
    profile_id: str,
    reason: AuthProfileFailureReason,
    cfg: OpenClawConfig | None = None,
    agent_dir: str | None = None,
) -> None: ...
```

---

## openclaw_py.agents.auth_profiles.paths
路径: openclaw_py/agents/auth_profiles/paths.py

```python
from openclaw_py.agents.auth_profiles.paths import (
    resolve_auth_store_path,
    resolve_legacy_auth_store_path,
    ensure_auth_store_file,
)

def resolve_auth_store_path(agent_dir: str | None = None) -> Path: ...

def resolve_legacy_auth_store_path(agent_dir: str | None = None) -> Path: ...

def ensure_auth_store_file(auth_path: Path) -> None: ...
```

---

## openclaw_py.agents.auth_profiles.oauth
路径: openclaw_py/agents/auth_profiles/oauth.py

```python
from openclaw_py.agents.auth_profiles.oauth import (
    is_oauth_token_near_expiry,
    should_refresh_oauth_token,
)

def is_oauth_token_near_expiry(
    credential: OAuthCredential,
    threshold_ms: int = 300000,  # 5 minutes
) -> bool: ...

def should_refresh_oauth_token(credential: OAuthCredential) -> bool: ...
```

---

## openclaw_py.agents.auth_profiles.external_cli_sync
路径: openclaw_py/agents/auth_profiles/external_cli_sync.py

```python
from openclaw_py.agents.auth_profiles.external_cli_sync import (
    sync_external_cli_credentials,
)

def sync_external_cli_credentials(store: AuthProfileStore) -> bool: ...
```

---

## openclaw_py.agents.auth_profiles.doctor
路径: openclaw_py/agents/auth_profiles/doctor.py

```python
from openclaw_py.agents.auth_profiles.doctor import (
    check_profile_valid,
    check_profile_expired,
    list_invalid_profiles,
    list_expired_profiles,
)

def check_profile_valid(credential: AuthProfileCredential) -> bool: ...

def check_profile_expired(credential: AuthProfileCredential) -> bool: ...

def list_invalid_profiles(store: AuthProfileStore) -> list[str]: ...

def list_expired_profiles(store: AuthProfileStore) -> list[str]: ...
```

---

## openclaw_py.agents.auth_profiles.repair
路径: openclaw_py/agents/auth_profiles/repair.py

```python
from openclaw_py.agents.auth_profiles.repair import (
    repair_profile_id,
    migrate_profile_store,
)

def repair_profile_id(old_id: str) -> str: ...

def migrate_profile_store(store: AuthProfileStore) -> AuthProfileStore: ...
```

---
