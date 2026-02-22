"""
SQLAlchemy models for the agent management system.
"""
import enum
from datetime import datetime
from typing import Optional
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Boolean, JSON, 
    ForeignKey, Enum as SQLEnum, Float, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .database import Base


class AgentStatus(str, enum.Enum):
    """Agent status enumeration."""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"
    DISABLED = "disabled"


class TaskStatus(str, enum.Enum):
    """Task status enumeration."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskPriority(str, enum.Enum):
    """Task priority levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class IntegrationStatus(str, enum.Enum):
    """Integration connection status."""
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    ERROR = "error"
    PENDING = "pending"


class Agent(Base):
    """AI Agent model - represents different business function agents."""
    __tablename__ = "agents"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False, index=True)
    slug = Column(String(100), unique=True, nullable=False, index=True)
    description = Column(Text)
    agent_type = Column(String(50), nullable=False)  # finance, recruitment, compliance, etc.
    status = Column(SQLEnum(AgentStatus), default=AgentStatus.IDLE, nullable=False)
    
    # Configuration
    config = Column(JSON, default=dict)  # Agent-specific configuration
    schedule = Column(String(100))  # Cron expression for scheduled runs
    is_enabled = Column(Boolean, default=True)
    
    # Metrics
    total_runs = Column(Integer, default=0)
    successful_runs = Column(Integer, default=0)
    failed_runs = Column(Integer, default=0)
    last_run_at = Column(DateTime(timezone=True))
    last_error = Column(Text)
    avg_execution_time = Column(Float)  # in seconds
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    tasks = relationship("Task", back_populates="agent", cascade="all, delete-orphan")
    logs = relationship("AgentLog", back_populates="agent", cascade="all, delete-orphan")
    progress = relationship("AgentProgress", back_populates="agent", cascade="all, delete-orphan")
    
    def __repr__(self):
        return f"<Agent {self.name} ({self.status})>"


class Task(Base):
    """Task model - represents work items for agents."""
    __tablename__ = "tasks"
    
    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=False, index=True)
    
    name = Column(String(200), nullable=False)
    description = Column(Text)
    task_type = Column(String(50), nullable=False)
    status = Column(SQLEnum(TaskStatus), default=TaskStatus.PENDING, nullable=False, index=True)
    priority = Column(SQLEnum(TaskPriority), default=TaskPriority.MEDIUM, nullable=False)
    
    # Task data
    input_data = Column(JSON, default=dict)
    output_data = Column(JSON, default=dict)
    error_message = Column(Text)
    
    # Execution info
    scheduled_at = Column(DateTime(timezone=True))
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    execution_time = Column(Float)  # in seconds
    retry_count = Column(Integer, default=0)
    max_retries = Column(Integer, default=3)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    agent = relationship("Agent", back_populates="tasks")
    
    __table_args__ = (
        Index("ix_tasks_status_priority", "status", "priority"),
    )
    
    def __repr__(self):
        return f"<Task {self.name} ({self.status})>"


class Integration(Base):
    """Integration model - represents external service connections."""
    __tablename__ = "integrations"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False, index=True)
    slug = Column(String(100), unique=True, nullable=False, index=True)
    service_type = Column(String(50), nullable=False)  # gmail, github, notion, stripe, etc.
    
    status = Column(SQLEnum(IntegrationStatus), default=IntegrationStatus.DISCONNECTED)
    is_enabled = Column(Boolean, default=True)
    
    # Configuration (encrypted sensitive fields should use separate storage)
    config = Column(JSON, default=dict)
    
    # Health check
    last_health_check = Column(DateTime(timezone=True))
    health_status = Column(String(50))
    error_message = Column(Text)
    
    # Metrics
    total_requests = Column(Integer, default=0)
    failed_requests = Column(Integer, default=0)
    avg_response_time = Column(Float)  # in milliseconds
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    def __repr__(self):
        return f"<Integration {self.name} ({self.status})>"


class AgentLog(Base):
    """Agent execution log model."""
    __tablename__ = "agent_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=False, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), index=True)
    
    level = Column(String(20), nullable=False, index=True)  # INFO, WARNING, ERROR, DEBUG
    message = Column(Text, nullable=False)
    details = Column(JSON)
    
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    
    # Relationships
    agent = relationship("Agent", back_populates="logs")
    
    __table_args__ = (
        Index("ix_agent_logs_agent_timestamp", "agent_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<AgentLog [{self.level}] {self.message[:50]}>"


class Notification(Base):
    """Notification model for alerts and messages."""
    __tablename__ = "notifications"
    
    id = Column(Integer, primary_key=True, index=True)
    
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)
    notification_type = Column(String(50), nullable=False)  # alert, info, warning, error
    source = Column(String(100))  # Which agent or integration sent it
    
    # Delivery
    channels = Column(JSON, default=list)  # ["telegram", "email", "desktop"]
    is_read = Column(Boolean, default=False, index=True)
    is_sent = Column(Boolean, default=False)
    sent_at = Column(DateTime(timezone=True))
    
    # Priority
    priority = Column(SQLEnum(TaskPriority), default=TaskPriority.MEDIUM)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    
    def __repr__(self):
        return f"<Notification {self.title}>"


class Metric(Base):
    """Time-series metrics for analytics."""
    __tablename__ = "metrics"
    
    id = Column(Integer, primary_key=True, index=True)
    
    metric_name = Column(String(100), nullable=False, index=True)
    metric_type = Column(String(50), nullable=False)  # counter, gauge, histogram
    value = Column(Float, nullable=False)
    
    # Dimensions
    agent_id = Column(Integer, ForeignKey("agents.id"), index=True)
    integration_id = Column(Integer, ForeignKey("integrations.id"), index=True)
    tags = Column(JSON, default=dict)
    
    # Timestamp
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    
    __table_args__ = (
        Index("ix_metrics_name_timestamp", "metric_name", "timestamp"),
    )
    
    def __repr__(self):
        return f"<Metric {self.metric_name}={self.value}>"


class Workflow(Base):
    """Automation workflow model."""
    __tablename__ = "workflows"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), unique=True, nullable=False, index=True)
    description = Column(Text)
    
    # Workflow definition
    trigger_type = Column(String(50), nullable=False)  # schedule, webhook, event
    trigger_config = Column(JSON, default=dict)
    steps = Column(JSON, default=list)  # Array of workflow steps
    
    is_enabled = Column(Boolean, default=True)
    
    # Execution stats
    total_runs = Column(Integer, default=0)
    successful_runs = Column(Integer, default=0)
    failed_runs = Column(Integer, default=0)
    last_run_at = Column(DateTime(timezone=True))
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    def __repr__(self):
        return f"<Workflow {self.name}>"


class AuditLog(Base):
    """Audit log for compliance and security."""
    __tablename__ = "audit_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    
    action = Column(String(100), nullable=False, index=True)
    resource_type = Column(String(50), nullable=False, index=True)
    resource_id = Column(String(100))
    
    user_id = Column(String(100), index=True)  # Who performed the action
    ip_address = Column(String(50))
    user_agent = Column(String(500))
    
    old_value = Column(JSON)
    new_value = Column(JSON)
    
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    
    __table_args__ = (
        Index("ix_audit_logs_action_timestamp", "action", "timestamp"),
    )
    
    def __repr__(self):
        return f"<AuditLog {self.action} on {self.resource_type}>"


class AgentProgress(Base):
    """
    Progress and checkpoint state for long-running agents.
    Enables multi-session continuity: each run reads progress, does one step, then updates.
    """
    __tablename__ = "agent_progress"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=False, index=True)
    workflow_or_run_id = Column(String(200), index=True)  # Optional: e.g. "feature-X" or run id

    # Progress state (JSON: feature list, last step, artifacts)
    state = Column(JSON, default=dict)
    # Human-readable summary for next session
    summary = Column(Text)
    # Optional feature list: [{"id": "...", "description": "...", "passes": false}, ...]
    feature_list = Column(JSON, default=list)

    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    agent = relationship("Agent", back_populates="progress")
    __table_args__ = (Index("ix_agent_progress_agent_updated", "agent_id", "updated_at"),)
