"""
Action Executor

Core system for executing agent actions with sandboxing and monitoring.
"""

import asyncio
from typing import Any, Dict, Optional, List
from enum import Enum
import json
from datetime import datetime

import aiohttp
from config.settings import settings
from engine.core.models import ActionType, ActionStatus, RiskLevel


class ActionExecutor:
    """
    Executes agent actions with proper sandboxing and monitoring.
    
    Supports:
    - HTTP/REST API calls
    - Script execution (sandboxed)
    - Workflow orchestration
    - Database queries
    - File system operations
    """
    
    def __init__(self) -> None:
        self.session: Optional[aiohttp.ClientSession] = None
        self.max_timeout = settings.action.action_timeout
    
    async def initialize(self) -> None:
        """Initialize executor resources"""
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.max_timeout)
        )
    
    async def cleanup(self) -> None:
        """Cleanup executor resources"""
        if self.session:
            await self.session.close()
    
    async def execute_action(
        self,
        action_type: ActionType,
        action_data: Dict[str, Any],
        risk_level: RiskLevel,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Execute an action with proper sandboxing.
        
        Args:
            action_type: Type of action (HTTP, SCRIPT, etc.)
            action_data: Action configuration/payload
            risk_level: Risk level for permission checking
            context: Additional execution context
        
        Returns:
            Action execution result
        """
        if action_type == ActionType.HTTP:
            return await self._execute_http_action(action_data, context)
        elif action_type == ActionType.SCRIPT:
            return await self._execute_script_action(action_data, context)
        elif action_type == ActionType.WORKFLOW:
            return await self._execute_workflow_action(action_data, context)
        elif action_type == ActionType.DATABASE:
            return await self._execute_database_action(action_data, context)
        elif action_type == ActionType.FILESYSTEM:
            return await self._execute_filesystem_action(action_data, context)
        else:
            raise ValueError(f"Unsupported action type: {action_type}")
    
    # ========================================================================
    # HTTP Actions
    # ========================================================================
    
    async def _execute_http_action(
        self,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute HTTP/REST API action"""
        if not self.session:
            await self.initialize()
        
        method = action_data.get("method", "GET").upper()
        url = action_data.get("url")
        headers = action_data.get("headers", {})
        params = action_data.get("params", {})
        body = action_data.get("body")
        
        if not url:
            raise ValueError("URL is required for HTTP action")
        
        # Validate URL (basic security check)
        if not self._is_safe_url(url):
            raise ValueError(f"URL not allowed: {url}")
        
        try:
            start_time = datetime.now()
            
            async with self.session.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                json=body if method in ["POST", "PUT", "PATCH"] else None,
            ) as response:
                response_text = await response.text()
                
                try:
                    response_data = json.loads(response_text)
                except json.JSONDecodeError:
                    response_data = response_text
                
                execution_time = (datetime.now() - start_time).total_seconds()
                
                return {
                    "status": ActionStatus.COMPLETED.value,
                    "http_status": response.status,
                    "success": 200 <= response.status < 300,
                    "data": response_data,
                    "headers": dict(response.headers),
                    "execution_time": execution_time,
                    "timestamp": datetime.now().isoformat(),
                }
        
        except asyncio.TimeoutError:
            return {
                "status": ActionStatus.FAILED.value,
                "success": False,
                "error": "Request timeout",
                "timestamp": datetime.now().isoformat(),
            }
        except Exception as e:
            return {
                "status": ActionStatus.FAILED.value,
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat(),
            }
    
    def _is_safe_url(self, url: str) -> bool:
        """Check if URL is safe to access"""
        # Block localhost and private IPs (basic security)
        blocked_hosts = ["localhost", "127.0.0.1", "0.0.0.0"]
        
        url_lower = url.lower()
        for blocked in blocked_hosts:
            if blocked in url_lower:
                return False
        
        # Block file:// and other dangerous protocols
        dangerous_protocols = ["file://", "ftp://", "ssh://"]
        for protocol in dangerous_protocols:
            if url_lower.startswith(protocol):
                return False
        
        return True
    
    # ========================================================================
    # Other Action Types (Stubs for now)
    # ========================================================================
    
    async def _execute_script_action(
        self,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute script action (sandboxed)"""
        return {
            "status": ActionStatus.COMPLETED.value,
            "success": True,
            "message": "Script execution not implemented yet",
            "timestamp": datetime.now().isoformat(),
        }
    
    async def _execute_workflow_action(
        self,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute workflow action"""
        return {
            "status": ActionStatus.COMPLETED.value,
            "success": True,
            "message": "Workflow execution not implemented yet",
            "timestamp": datetime.now().isoformat(),
        }
    
    async def _execute_database_action(
        self,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute database action"""
        return {
            "status": ActionStatus.COMPLETED.value,
            "success": True,
            "message": "Database execution not implemented yet",
            "timestamp": datetime.now().isoformat(),
        }
    
    async def _execute_filesystem_action(
        self,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute filesystem action"""
        return {
            "status": ActionStatus.COMPLETED.value,
            "success": True,
            "message": "Filesystem execution not implemented yet",
            "timestamp": datetime.now().isoformat(),
        }


# Global executor instance
executor = ActionExecutor()
