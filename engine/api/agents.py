"""
Agent API Routes

REST API endpoints for agent management.
"""

from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from engine.agents.registry import registry
from engine.core.models import (
    AgentInfo,
    AgentMetadata,
    AgentExecuteRequest,
    AgentExecuteResponse,
)


router = APIRouter(prefix="/agents", tags=["Agents"])


# ============================================================================
# Request/Response Models
# ============================================================================

class LoadAgentRequest(BaseModel):
    """Request to load an agent"""
    agent_path: str
    config: Optional[dict] = None


class LoadAgentResponse(BaseModel):
    """Response from loading an agent"""
    agent_name: str
    status: str
    loaded_at: datetime


class AgentListItem(BaseModel):
    """Agent list item"""
    name: str
    domain: str
    description: str
    risk_level: str
    loaded: bool


# ============================================================================
# Routes
# ============================================================================

@router.get("/", response_model=List[AgentListItem])
async def list_agents() -> List[AgentListItem]:
    """
    List all available agents.
    
    Returns both loaded and available agents.
    """
    available = registry.discover_agents()
    loaded = registry.list_loaded_agents()
    
    agents = []
    for agent_path in available:
        try:
            metadata = registry.get_agent_metadata(agent_path)
            agents.append(
                AgentListItem(
                    name=metadata.name,
                    domain=metadata.domain,
                    description=metadata.description,
                    risk_level=metadata.risk_level.value,
                    loaded=metadata.name in loaded,
                )
            )
        except Exception:
            # Skip agents with invalid manifests
            continue
    
    return agents


@router.get("/loaded", response_model=List[str])
async def list_loaded_agents() -> List[str]:
    """
    List all loaded agent names.
    """
    return registry.list_loaded_agents()


@router.get("/{agent_name}", response_model=AgentInfo)
async def get_agent_info(agent_name: str) -> AgentInfo:
    """
    Get information about a loaded agent.
    
    Args:
        agent_name: Name of the agent
        
    Returns:
        Agent information
    """
    try:
        return registry.get_agent_info(agent_name)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )


@router.post("/load", response_model=LoadAgentResponse)
async def load_agent(request: LoadAgentRequest) -> LoadAgentResponse:
    """
    Load an agent.
    
    Args:
        request: Load agent request
        
    Returns:
        Load response with agent name and status
    """
    try:
        agent = await registry.load_agent(request.agent_path, request.config)
        return LoadAgentResponse(
            agent_name=agent.name,
            status="loaded",
            loaded_at=datetime.now(),
        )
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except (ValueError, RuntimeError) as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post("/unload/{agent_name}")
async def unload_agent(agent_name: str) -> dict:
    """
    Unload an agent.
    
    Args:
        agent_name: Name of the agent to unload
        
    Returns:
        Success message
    """
    try:
        await registry.unload_agent(agent_name)
        return {"status": "unloaded", "agent_name": agent_name}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )


@router.post("/execute", response_model=AgentExecuteResponse)
async def execute_agent(request: AgentExecuteRequest) -> AgentExecuteResponse:
    """
    Execute a task on an agent.
    
    Args:
        request: Execute request with agent name and task
        
    Returns:
        Execution result
    """
    import time
    
    start_time = time.time()
    
    try:
        result = await registry.execute_agent(
            request.agent,
            request.task,
            request.context,
        )
        
        execution_time = time.time() - start_time
        
        return AgentExecuteResponse(
            agent=request.agent,
            task=request.task,
            result=result,
            execution_time=execution_time,
            actions_executed=0,  # TODO: Track from action executor
            timestamp=datetime.now(),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Execution failed: {str(e)}",
        )


@router.get("/{agent_name}/capabilities", response_model=List[str])
async def get_agent_capabilities(agent_name: str) -> List[str]:
    """
    Get agent capabilities.
    
    Args:
        agent_name: Name of the agent
        
    Returns:
        List of capabilities
    """
    try:
        agent = registry.get_agent(agent_name)
        return agent.get_capabilities()
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
