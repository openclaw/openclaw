# OpenClaw Python 接口契约

> 每个批次完成后由 /done 命令自动更新。
> 新批次开始时由 /start 命令自动读取。
> 最后更新：批次 4（2026-02-13）

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
