"""
Base Integration class - foundation for all external service integrations.
"""
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, Optional
import httpx
import structlog

from core.config import settings


logger = structlog.get_logger()


class BaseIntegration(ABC):
    """
    Abstract base class for all external service integrations.
    
    Provides common functionality:
    - HTTP client management
    - Rate limiting
    - Error handling
    - Metrics tracking
    """
    
    def __init__(
        self,
        name: str,
        base_url: str,
        timeout: float = 30.0
    ):
        self.name = name
        self.base_url = base_url
        self.timeout = timeout
        self.logger = logger.bind(integration=name)
        
        # HTTP client
        self._client: Optional[httpx.AsyncClient] = None
        
        # Metrics
        self.total_requests = 0
        self.failed_requests = 0
        self.last_request_at: Optional[datetime] = None
        self.last_error: Optional[str] = None
    
    @property
    def client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                headers=self._get_default_headers()
            )
        return self._client
    
    @abstractmethod
    def _get_default_headers(self) -> Dict[str, str]:
        """Return default headers for requests."""
        pass
    
    @abstractmethod
    async def health_check(self) -> Dict[str, Any]:
        """Check integration health."""
        pass
    
    async def _request(
        self,
        method: str,
        endpoint: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Make an HTTP request with error handling and metrics.
        """
        self.total_requests += 1
        self.last_request_at = datetime.utcnow()
        
        try:
            response = await self.client.request(method, endpoint, **kwargs)
            response.raise_for_status()
            
            # Return JSON if available
            if response.headers.get("content-type", "").startswith("application/json"):
                return response.json()
            return {"status": "ok", "text": response.text}
            
        except httpx.HTTPStatusError as e:
            self.failed_requests += 1
            self.last_error = f"HTTP {e.response.status_code}: {e.response.text[:200]}"
            self.logger.error(
                "HTTP error",
                status_code=e.response.status_code,
                endpoint=endpoint
            )
            raise
            
        except Exception as e:
            self.failed_requests += 1
            self.last_error = str(e)
            self.logger.error("Request failed", endpoint=endpoint, error=str(e))
            raise
    
    async def get(self, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make GET request."""
        return await self._request("GET", endpoint, **kwargs)
    
    async def post(self, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make POST request."""
        return await self._request("POST", endpoint, **kwargs)
    
    async def put(self, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make PUT request."""
        return await self._request("PUT", endpoint, **kwargs)
    
    async def delete(self, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make DELETE request."""
        return await self._request("DELETE", endpoint, **kwargs)
    
    async def close(self):
        """Close HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None
    
    def get_metrics(self) -> Dict[str, Any]:
        """Return integration metrics."""
        success_rate = (
            (self.total_requests - self.failed_requests) / self.total_requests
            if self.total_requests > 0 else 1.0
        )
        
        return {
            "name": self.name,
            "total_requests": self.total_requests,
            "failed_requests": self.failed_requests,
            "success_rate": success_rate,
            "last_request_at": self.last_request_at.isoformat() if self.last_request_at else None,
            "last_error": self.last_error
        }
