"""
SotyBot Base Agent Interface

Domain-agnostic base class for all agents.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional

from engine.core.models import AgentMetadata, ActionType, RiskLevel


class BaseAgent(ABC):
    """
    Base class for all SotyBot agents.
    
    All agents must inherit from this class and implement the required methods.
    Agents are domain-agnostic - the engine doesn't know about specific domains.
    """
    
    def __init__(self) -> None:
        """Initialize the agent"""
        self._metadata: Optional[AgentMetadata] = None
        self._initialized = False
        self._execution_count = 0
        self._error_count = 0
        self._last_execution: Optional[datetime] = None
    
    @abstractmethod
    async def initialize(self, config: Dict[str, Any]) -> None:
        """
        Initialize the agent with configuration.
        
        Args:
            config: Agent-specific configuration
        """
        pass
    
    @abstractmethod
    async def execute(self, task: str, context: Optional[Dict[str, Any]] = None) -> Any:
        """
        Execute a task.
        
        Args:
            task: The task description/command
            context: Optional context data
            
        Returns:
            Task result (can be any type)
        """
        pass
    
    @abstractmethod
    def get_capabilities(self) -> List[str]:
        """
        Get list of agent capabilities.
        
        Returns:
            List of capability descriptions
        """
        pass
    
    @abstractmethod
    async def cleanup(self) -> None:
        """
        Cleanup resources before agent unload.
        """
        pass
    
    # ========================================================================
    # Metadata Management
    # ========================================================================
    
    @property
    def metadata(self) -> AgentMetadata:
        """Get agent metadata"""
        if self._metadata is None:
            raise RuntimeError("Agent metadata not set")
        return self._metadata
    
    @metadata.setter
    def metadata(self, value: AgentMetadata) -> None:
        """Set agent metadata"""
        self._metadata = value
    
    @property
    def name(self) -> str:
        """Get agent name"""
        return self.metadata.name
    
    @property
    def domain(self) -> str:
        """Get agent domain"""
        return self.metadata.domain
    
    @property
    def risk_level(self) -> RiskLevel:
        """Get agent risk level"""
        return self.metadata.risk_level
    
    @property
    def required_actions(self) -> List[ActionType]:
        """Get required action types"""
        return self.metadata.required_actions
    
    # ========================================================================
    # Lifecycle Management
    # ========================================================================
    
    @property
    def initialized(self) -> bool:
        """Check if agent is initialized"""
        return self._initialized
    
    def mark_initialized(self) -> None:
        """Mark agent as initialized"""
        self._initialized = True
    
    def record_execution(self, success: bool = True) -> None:
        """Record an execution"""
        self._execution_count += 1
        if not success:
            self._error_count += 1
        self._last_execution = datetime.now()
    
    @property
    def execution_count(self) -> int:
        """Get execution count"""
        return self._execution_count
    
    @property
    def error_count(self) -> int:
        """Get error count"""
        return self._error_count
    
    @property
    def last_execution(self) -> Optional[datetime]:
        """Get last execution time"""
        return self._last_execution
    
    # ========================================================================
    # Helper Methods (can be overridden)
    # ========================================================================
    
    async def validate_task(self, task: str) -> bool:
        """
        Validate if the agent can handle this task.
        
        Args:
            task: Task description
            
        Returns:
            True if agent can handle the task
        """
        return True
    
    def get_config_schema(self) -> Dict[str, Any]:
        """
        Get configuration schema for this agent.
        
        Returns:
            JSON schema for agent configuration
        """
        return {}
