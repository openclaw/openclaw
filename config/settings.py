"""
SotyBot Configuration System

Pydantic-based settings management with environment variable loading.
"""

from typing import List, Optional, Any
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class APISettings(BaseSettings):
    """API server settings"""
    
    host: str = Field(default="0.0.0.0", alias="SOTYBOT_HOST")
    port: int = Field(default=8000, alias="SOTYBOT_PORT")
    debug: bool = Field(default=False, alias="SOTYBOT_DEBUG")
    reload: bool = Field(default=False, alias="SOTYBOT_RELOAD")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class SecuritySettings(BaseSettings):
    """Security and authentication settings"""
    
    secret_key: str = Field(default="change-this-in-production", alias="SOTYBOT_SECRET_KEY")
    allowed_origins: List[str] = Field(
        default=["http://localhost:3000", "http://localhost:8000"],
        alias="SOTYBOT_ALLOWED_ORIGINS"
    )
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    
    @field_validator("allowed_origins", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: Any) -> List[str]:
        if isinstance(v, str) and not v.startswith("["):
            return [i.strip() for i in v.split(",")]
        return v


class AgentSettings(BaseSettings):
    """Agent runtime settings"""
    
    agent_dir: str = Field(default="./agents", alias="SOTYBOT_AGENT_DIR")
    agent_timeout: int = Field(default=300, alias="SOTYBOT_AGENT_TIMEOUT")
    max_concurrent_agents: int = Field(default=10, alias="SOTYBOT_MAX_CONCURRENT_AGENTS")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class ActionSettings(BaseSettings):
    """Action executor settings"""
    
    action_timeout: int = Field(default=60, alias="SOTYBOT_ACTION_TIMEOUT")
    max_concurrent_actions: int = Field(default=20, alias="SOTYBOT_MAX_CONCURRENT_ACTIONS")
    enable_script_actions: bool = Field(default=True, alias="SOTYBOT_ENABLE_SCRIPT_ACTIONS")
    enable_http_actions: bool = Field(default=True, alias="SOTYBOT_ENABLE_HTTP_ACTIONS")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class DatabaseSettings(BaseSettings):
    """Database connection settings"""
    
    database_url: str = Field(
        default="sqlite:///./sotybot.db",
        alias="SOTYBOT_DATABASE_URL"
    )
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class RedisSettings(BaseSettings):
    """Redis connection settings"""
    
    redis_url: str = Field(default="redis://localhost:6379/0", alias="SOTYBOT_REDIS_URL")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class MarketplaceSettings(BaseSettings):
    """Agent marketplace settings"""
    
    enabled: bool = Field(default=True, alias="SOTYBOT_MARKETPLACE_ENABLED")
    auto_update: bool = Field(default=True, alias="SOTYBOT_MARKETPLACE_AUTO_UPDATE")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class PermissionSettings(BaseSettings):
    """Permission and trust settings"""
    
    require_approval_for_critical: bool = Field(
        default=True,
        alias="SOTYBOT_REQUIRE_APPROVAL_FOR_CRITICAL"
    )
    require_approval_for_automation: bool = Field(
        default=False,
        alias="SOTYBOT_REQUIRE_APPROVAL_FOR_AUTOMATION"
    )
    enable_trust_scoring: bool = Field(default=True, alias="SOTYBOT_ENABLE_TRUST_SCORING")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class AuditSettings(BaseSettings):
    """Audit logging settings"""
    
    enabled: bool = Field(default=True, alias="SOTYBOT_AUDIT_ENABLED")
    log_file: str = Field(default="./logs/audit.log", alias="SOTYBOT_AUDIT_LOG_FILE")
    log_directory: str = Field(default="./logs", alias="SOTYBOT_AUDIT_LOG_DIR")
    enable_database_logging: bool = Field(default=False, alias="SOTYBOT_AUDIT_DB_LOGGING")
    retention_days: int = Field(default=90, alias="SOTYBOT_AUDIT_RETENTION_DAYS")
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


class Settings(BaseSettings):
    """Main settings aggregator"""
    
    api: APISettings = Field(default_factory=APISettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)
    agent: AgentSettings = Field(default_factory=AgentSettings)
    action: ActionSettings = Field(default_factory=ActionSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    marketplace: MarketplaceSettings = Field(default_factory=MarketplaceSettings)
    permission: PermissionSettings = Field(default_factory=PermissionSettings)
    audit: AuditSettings = Field(default_factory=AuditSettings)
    
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


# Global settings instance
settings = Settings()
