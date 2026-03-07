"""
Agent Registry

Manages agent loading, lifecycle, and discovery.
"""

import importlib.util
import json
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime

from engine.agents.base import BaseAgent
from engine.core.models import AgentMetadata, AgentStatus, AgentInfo, RiskLevel
from config.settings import settings


class AgentRegistry:
    """
    Central registry for all agents.
    
    Responsibilities:
    - Load agents from disk
    - Manage agent lifecycle
    - Track agent status and metadata
    - Provide agent discovery
    """
    
    def __init__(self, agent_dir: Optional[str] = None) -> None:
        """
        Initialize the registry.
        
        Args:
            agent_dir: Directory containing agents (default from settings)
        """
        self.agent_dir = Path(agent_dir or settings.agent.agent_dir)
        self._agents: Dict[str, BaseAgent] = {}
        self._metadata: Dict[str, AgentMetadata] = {}
        self._status: Dict[str, AgentStatus] = {}
        self._loaded_at: Dict[str, datetime] = {}
    
    # ========================================================================
    # Agent Loading
    # ========================================================================
    
    async def load_agent(self, agent_path: str, config: Optional[Dict] = None) -> BaseAgent:
        """
        Load an agent from a directory.
        
        Args:
            agent_path: Relative path to agent (e.g., "creative/content_generator")
            config: Optional configuration for the agent
            
        Returns:
            Loaded agent instance
            
        Raises:
            FileNotFoundError: If agent directory or files not found
            ValueError: If manifest is invalid
            RuntimeError: If agent fails to load
        """
        agent_full_path = self.agent_dir / agent_path
        
        if not agent_full_path.exists():
            raise FileNotFoundError(f"Agent not found: {agent_path}")
        
        # Load manifest
        manifest_path = agent_full_path / "manifest.json"
        if not manifest_path.exists():
            raise FileNotFoundError(f"Manifest not found: {manifest_path}")
        
        with open(manifest_path, "r") as f:
            manifest_data = json.load(f)
        
        metadata = AgentMetadata(**manifest_data)
        
        # Load agent module
        agent_module_path = agent_full_path / "agent.py"
        if not agent_module_path.exists():
            raise FileNotFoundError(f"Agent module not found: {agent_module_path}")
        
        # Import the module
        spec = importlib.util.spec_from_file_location(
            f"agents.{agent_path.replace('/', '.')}", 
            agent_module_path
        )
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Failed to load agent module: {agent_module_path}")
        
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        
        # Get agent instance
        if not hasattr(module, "agent"):
            raise RuntimeError(f"Agent module must export 'agent' instance: {agent_module_path}")
        
        agent = module.agent
        if not isinstance(agent, BaseAgent):
            raise RuntimeError(f"Agent must inherit from BaseAgent: {agent_module_path}")
        
        # Set metadata
        agent.metadata = metadata
        
        # Initialize agent
        self._status[metadata.name] = AgentStatus.LOADING
        try:
            await agent.initialize(config or {})
            self._status[metadata.name] = AgentStatus.LOADED
        except Exception as e:
            self._status[metadata.name] = AgentStatus.ERROR
            raise RuntimeError(f"Failed to initialize agent {metadata.name}: {e}")
        
        # Register agent
        self._agents[metadata.name] = agent
        self._metadata[metadata.name] = metadata
        self._loaded_at[metadata.name] = datetime.now()
        
        return agent
    
    async def unload_agent(self, agent_name: str) -> None:
        """
        Unload an agent.
        
        Args:
            agent_name: Name of the agent to unload
        """
        if agent_name not in self._agents:
            raise ValueError(f"Agent not loaded: {agent_name}")
        
        agent = self._agents[agent_name]
        await agent.cleanup()
        
        del self._agents[agent_name]
        del self._metadata[agent_name]
        del self._status[agent_name]
        del self._loaded_at[agent_name]
    
    # ========================================================================
    # Agent Discovery
    # ========================================================================
    
    def discover_agents(self) -> List[str]:
        """
        Discover all available agents in the agent directory.
        
        Returns:
            List of agent paths (e.g., ["creative/content_generator"])
        """
        agents = []
        
        if not self.agent_dir.exists():
            return agents
        
        # Walk through agent directory
        for domain_dir in self.agent_dir.iterdir():
            if not domain_dir.is_dir() or domain_dir.name.startswith("."):
                continue
            
            for agent_dir in domain_dir.iterdir():
                if not agent_dir.is_dir() or agent_dir.name.startswith("."):
                    continue
                
                # Check if manifest exists
                manifest_path = agent_dir / "manifest.json"
                if manifest_path.exists():
                    relative_path = f"{domain_dir.name}/{agent_dir.name}"
                    agents.append(relative_path)
        
        return agents
    
    def get_agent_metadata(self, agent_path: str) -> AgentMetadata:
        """
        Get metadata for an agent without loading it.
        
        Args:
            agent_path: Relative path to agent
            
        Returns:
            Agent metadata
        """
        manifest_path = self.agent_dir / agent_path / "manifest.json"
        
        if not manifest_path.exists():
            raise FileNotFoundError(f"Manifest not found: {manifest_path}")
        
        with open(manifest_path, "r") as f:
            manifest_data = json.load(f)
        
        return AgentMetadata(**manifest_data)
        
    async def get_agent_capabilities(self, agent_name: str) -> List[str]:
        """
        Get capabilities of an agent.
        
        Args:
            agent_name: Name of the agent
            
        Returns:
            List of capability names
        """
        if agent_name in self._agents:
            return self._agents[agent_name].get_capabilities()
        elif agent_name in self._metadata:
            return self._metadata[agent_name].capabilities
        else:
            raise ValueError(f"Agent {agent_name} not found or metadata not loaded")
    
    # ========================================================================
    # Agent Access
    # ========================================================================
    
    def get_agent(self, agent_name: str) -> BaseAgent:
        """
        Get a loaded agent by name.
        
        Args:
            agent_name: Name of the agent
            
        Returns:
            Agent instance
            
        Raises:
            ValueError: If agent not loaded
        """
        if agent_name not in self._agents:
            raise ValueError(f"Agent not loaded: {agent_name}")
        
        return self._agents[agent_name]
    
    def get_agent_info(self, agent_name: str) -> AgentInfo:
        """
        Get information about a loaded agent.
        
        Args:
            agent_name: Name of the agent
            
        Returns:
            Agent information
        """
        if agent_name not in self._agents:
            raise ValueError(f"Agent not loaded: {agent_name}")
        
        agent = self._agents[agent_name]
        metadata = self._metadata[agent_name]
        status = self._status[agent_name]
        loaded_at = self._loaded_at[agent_name]
        
        return AgentInfo(
            metadata=metadata,
            status=status,
            loaded_at=loaded_at,
            last_execution=agent.last_execution,
            execution_count=agent.execution_count,
            error_count=agent.error_count,
            trust_score=None,  # TODO: Implement trust scoring
        )
    
    def list_loaded_agents(self) -> List[str]:
        """
        List all loaded agent names.
        
        Returns:
            List of agent names
        """
        return list(self._agents.keys())
    
    def is_loaded(self, agent_name: str) -> bool:
        """
        Check if an agent is loaded.
        
        Args:
            agent_name: Name of the agent
            
        Returns:
            True if loaded
        """
        return agent_name in self._agents
    
    # ========================================================================
    # Agent Execution
    # ========================================================================
    
    async def execute_agent(
        self, 
        agent_name: str, 
        task: str, 
        context: Optional[Dict] = None
    ) -> Any:
        """
        Execute a task on an agent.
        
        Args:
            agent_name: Name of the agent
            task: Task to execute
            context: Optional context data
            
        Returns:
            Task result
        """
        agent = self.get_agent(agent_name)
        
        self._status[agent_name] = AgentStatus.RUNNING
        try:
            result = await agent.execute(task, context)
            self._status[agent_name] = AgentStatus.LOADED
            return result
        except Exception as e:
            self._status[agent_name] = AgentStatus.ERROR
            raise


# Global registry instance
registry = AgentRegistry()
