"""
Core Engine Models

Shared data models for the SotyBot Engine.
"""

from typing import Dict, List, Optional, Any
from datetime import datetime
from enum import Enum
from pydantic import BaseModel


class RiskLevel(Enum):
    READ_ONLY = "read_only"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ActionType(Enum):
    HTTP = "http"
    SCRIPT = "script"
    WORKFLOW = "workflow"
    DATABASE = "database"
    FILESYSTEM = "filesystem"


class ActionStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class EventType(Enum):
    AGENT_LOADED = "agent_loaded"
    AGENT_UNLOADED = "agent_unloaded"
    ACTION_EXECUTED = "action_executed"
    PERMISSION_GRANTED = "permission_granted"
    PERMISSION_DENIED = "permission_denied"
    ERROR_OCCURRED = "error_occurred"


class AgentStatus(Enum):
    LOADING = "loading"
    LOADED = "loaded"
    ERROR = "error"
    RUNNING = "running"
    IDLE = "idle"


class AuditLog(BaseModel):
    event_type: str
    agent_name: Optional[str] = None
    event_data: Dict[str, Any]
    risk_level: Optional[str] = None
    user_id: Optional[str] = None
    timestamp: str


class AgentMetadata(BaseModel):
    name: str
    version: str
    author: str
    domain: str
    description: str
    capabilities: List[str]
    risk_level: RiskLevel


class AgentInfo(BaseModel):
    metadata: AgentMetadata
    status: AgentStatus
    loaded_at: datetime
    last_execution: Optional[datetime] = None
    execution_count: int = 0
    error_count: int = 0
    trust_score: Optional[float] = None
