"""
Base Agent class - foundation for all business agents.
"""
import asyncio
import traceback
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional
import structlog

from api.models.models import Agent, AgentStatus, Task, TaskStatus, AgentLog
from core.config import settings
from integrations.ai_provider import AIProvider


logger = structlog.get_logger()


class BaseAgent(ABC):
    """
    Abstract base class for all agents in the system.
    
    Each agent represents a specific business function:
    - Finance Monitor
    - Recruitment Manager
    - Compliance Auditor
    - Operations Manager
    - Investor Relations
    - Content & Research
    """
    
    def __init__(
        self,
        name: str,
        agent_type: str,
        config: Optional[Dict[str, Any]] = None,
        db_session = None
    ):
        self.name = name
        self.agent_type = agent_type
        self.config = config or {}
        self.db = db_session
        self.status = AgentStatus.IDLE
        self.logger = logger.bind(agent=name, agent_type=agent_type)
        
        # AI provider for reasoning/analysis
        self.ai = AIProvider()

        # Runtime state
        self._running = False
        self._current_task: Optional[Task] = None
        self._start_time: Optional[datetime] = None
    
    @property
    def is_running(self) -> bool:
        """Check if agent is currently running."""
        return self._running
    
    @abstractmethod
    async def execute(self, task: Optional[Task] = None) -> Dict[str, Any]:
        """
        Main execution method - must be implemented by each agent.
        
        Args:
            task: Optional task to execute. If None, agent runs default behavior.
            
        Returns:
            Dictionary with execution results.
        """
        pass
    
    @abstractmethod
    async def health_check(self) -> Dict[str, Any]:
        """
        Check agent health and dependencies.
        
        Returns:
            Dictionary with health status and details.
        """
        pass
    
    @abstractmethod
    def get_capabilities(self) -> List[str]:
        """
        Return list of capabilities this agent supports.
        
        Returns:
            List of capability strings.
        """
        pass
    
    async def start(self, task: Optional[Task] = None) -> Dict[str, Any]:
        """
        Start agent execution with proper lifecycle management.
        """
        if self._running:
            self.logger.warning("Agent already running")
            return {"status": "already_running", "message": f"Agent {self.name} is already running"}
        
        self._running = True
        self._start_time = datetime.utcnow()
        self._current_task = task
        self.status = AgentStatus.RUNNING
        
        try:
            self.logger.info("Starting agent execution", task_id=task.id if task else None)
            await self._log("INFO", "Agent execution started")
            
            # Update agent status in database
            await self._update_db_status(AgentStatus.RUNNING)
            
            # Execute main logic
            result = await self.execute(task)
            
            # Update metrics
            execution_time = (datetime.utcnow() - self._start_time).total_seconds()
            await self._record_success(execution_time)
            
            self.logger.info(
                "Agent execution completed",
                execution_time=execution_time,
                result_keys=list(result.keys()) if result else []
            )
            await self._log("INFO", f"Agent execution completed in {execution_time:.2f}s")
            
            return {
                "status": "success",
                "execution_time": execution_time,
                "result": result
            }
            
        except Exception as e:
            error_msg = str(e)
            stack_trace = traceback.format_exc()
            
            self.logger.error(
                "Agent execution failed",
                error=error_msg,
                stack_trace=stack_trace
            )
            await self._log("ERROR", f"Agent execution failed: {error_msg}", {"stack_trace": stack_trace})
            await self._record_failure(error_msg)
            
            return {
                "status": "error",
                "error": error_msg,
                "stack_trace": stack_trace
            }
            
        finally:
            self._running = False
            self._current_task = None
            self.status = AgentStatus.IDLE
            await self._update_db_status(AgentStatus.IDLE)
    
    async def stop(self) -> bool:
        """
        Stop agent execution gracefully.
        """
        if not self._running:
            return True
        
        self.logger.info("Stopping agent")
        self._running = False
        self.status = AgentStatus.PAUSED
        await self._update_db_status(AgentStatus.PAUSED)
        await self._log("INFO", "Agent stopped by request")
        
        return True
    
    async def _log(
        self,
        level: str,
        message: str,
        details: Optional[Dict[str, Any]] = None
    ):
        """Log message to database."""
        if not self.db:
            return
        
        try:
            log_entry = AgentLog(
                agent_id=await self._get_agent_id(),
                task_id=self._current_task.id if self._current_task else None,
                level=level,
                message=message,
                details=details
            )
            self.db.add(log_entry)
            self.db.commit()
        except Exception as e:
            self.logger.warning("Failed to write log to database", error=str(e))
    
    async def _get_agent_id(self) -> Optional[int]:
        """Get agent ID from database."""
        if not self.db:
            return None
        
        agent = self.db.query(Agent).filter(Agent.name == self.name).first()
        return agent.id if agent else None
    
    async def _update_db_status(self, status: AgentStatus):
        """Update agent status in database."""
        if not self.db:
            return
        
        try:
            agent = self.db.query(Agent).filter(Agent.name == self.name).first()
            if agent:
                agent.status = status
                if status == AgentStatus.RUNNING:
                    agent.last_run_at = datetime.utcnow()
                self.db.commit()
        except Exception as e:
            self.logger.warning("Failed to update agent status", error=str(e))
    
    async def _record_success(self, execution_time: float):
        """Record successful execution in metrics."""
        if not self.db:
            return
        
        try:
            agent = self.db.query(Agent).filter(Agent.name == self.name).first()
            if agent:
                total = (agent.total_runs or 0) + 1
                agent.total_runs = total
                agent.successful_runs = (agent.successful_runs or 0) + 1
                # Cumulative moving average: avg = prev + (new - prev) / n
                prev_avg = agent.avg_execution_time or 0.0
                agent.avg_execution_time = prev_avg + (execution_time - prev_avg) / total
                agent.last_error = None
                self.db.commit()
        except Exception as e:
            self.logger.warning("Failed to record success", error=str(e))
    
    async def _record_failure(self, error_message: str):
        """Record failed execution in metrics."""
        if not self.db:
            return
        
        try:
            agent = self.db.query(Agent).filter(Agent.name == self.name).first()
            if agent:
                agent.total_runs = (agent.total_runs or 0) + 1
                agent.failed_runs = (agent.failed_runs or 0) + 1
                agent.last_error = error_message
                agent.status = AgentStatus.ERROR
                self.db.commit()
        except Exception as e:
            self.logger.warning("Failed to record failure", error=str(e))
    
    def to_dict(self) -> Dict[str, Any]:
        """Serialize agent state to dictionary."""
        return {
            "name": self.name,
            "agent_type": self.agent_type,
            "status": self.status.value,
            "is_running": self._running,
            "config": self.config,
            "capabilities": self.get_capabilities()
        }
