"""Auth profile types using Pydantic v2."""

from typing import Literal

from pydantic import BaseModel, Field


class ApiKeyCredential(BaseModel):
    """API key credential."""

    type: Literal["api_key"] = "api_key"
    provider: str
    key: str | None = None
    email: str | None = None
    metadata: dict[str, str] | None = None


class TokenCredential(BaseModel):
    """Static bearer token credential (not refreshable)."""

    type: Literal["token"] = "token"
    provider: str
    token: str
    expires: int | None = None  # ms since epoch
    email: str | None = None


class OAuthCredential(BaseModel):
    """OAuth credential with refresh capability."""

    type: Literal["oauth"] = "oauth"
    provider: str
    access: str  # access token
    refresh: str | None = None  # refresh token
    expires: int | None = None  # ms since epoch
    client_id: str | None = Field(None, alias="clientId")
    enterprise_url: str | None = Field(None, alias="enterpriseUrl")
    project_id: str | None = Field(None, alias="projectId")
    account_id: str | None = Field(None, alias="accountId")
    email: str | None = None

    class Config:
        populate_by_name = True


# Union type for all credential types
AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential

AuthProfileFailureReason = Literal[
    "auth",
    "format",
    "rate_limit",
    "billing",
    "timeout",
    "unknown",
]


class ProfileUsageStats(BaseModel):
    """Per-profile usage statistics for round-robin and cooldown tracking."""

    last_used: int | None = Field(None, alias="lastUsed")
    cooldown_until: int | None = Field(None, alias="cooldownUntil")
    disabled_until: int | None = Field(None, alias="disabledUntil")
    disabled_reason: AuthProfileFailureReason | None = Field(None, alias="disabledReason")
    error_count: int | None = Field(None, alias="errorCount")
    failure_counts: dict[AuthProfileFailureReason, int] | None = Field(
        None, alias="failureCounts"
    )
    last_failure_at: int | None = Field(None, alias="lastFailureAt")

    class Config:
        populate_by_name = True


class AuthProfileStore(BaseModel):
    """Auth profile store structure."""

    version: int = 1
    profiles: dict[str, ApiKeyCredential | TokenCredential | OAuthCredential] = Field(
        default_factory=dict
    )
    order: dict[str, list[str]] | None = None
    last_good: dict[str, str] | None = Field(None, alias="lastGood")
    usage_stats: dict[str, ProfileUsageStats] | None = Field(None, alias="usageStats")

    class Config:
        populate_by_name = True
