"""
Audit Logger

Comprehensive audit logging for all agent and action activities.
"""

import json
import logging
from typing import Dict, Any, Optional
from datetime import datetime
from pathlib import Path

from config.settings import settings
from engine.core.models import AuditLog, EventType, RiskLevel


class AuditLogger:
    """
    Logs all agent and action activities for security and compliance.
    
    Logs include:
    - Agent lifecycle events (load, unload, initialize)
    - Action executions and results
    - Permission requests and decisions
    - Error and security events
    """
    
    def __init__(self) -> None:
        self.log_dir = Path(settings.audit.log_directory)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        # Configure file logger
        self.logger = logging.getLogger("sotybot.audit")
        self.logger.setLevel(logging.INFO)
        
        # File handler for audit logs
        log_file = self.log_dir / f"audit_{datetime.now().strftime('%Y%m%d')}.log"
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.INFO)
        
        # JSON formatter
        formatter = logging.Formatter(
            '{"timestamp": "%(asctime)s", "level": "%(levelname)s", "message": %(message)s}'
        )
        file_handler.setFormatter(formatter)
        
        self.logger.addHandler(file_handler)
    
    def log_event(
        self,
        event_type: EventType,
        agent_name: Optional[str],
        event_data: Dict[str, Any],
        risk_level: Optional[RiskLevel] = None,
        user_id: Optional[str] = None,
    ) -> None:
        """
        Log an audit event.
        
        Args:
            event_type: Type of event
            agent_name: Agent involved in the event
            event_data: Event details
            risk_level: Risk level if applicable
            user_id: User ID if applicable
        """
        audit_entry = {
            "event_type": event_type.value if isinstance(event_type, EventType) else event_type,
            "agent_name": agent_name,
            "event_data": event_data,
            "risk_level": risk_level.value if risk_level else None,
            "user_id": user_id,
            "timestamp": datetime.now().isoformat(),
        }
        
        # Log as JSON string
        self.logger.info(json.dumps(audit_entry))
        
        # Also store in database if enabled
        if settings.audit.enable_database_logging:
            self._store_in_database(audit_entry)
    
    def log_agent_lifecycle(
        self,
        event: str,
        agent_name: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Log agent lifecycle event"""
        self.log_event(
            event_type=EventType.AGENT_LOADED if event == "load" else EventType.AGENT_UNLOADED,
            agent_name=agent_name,
            event_data={"event": event, "details": details or {}},
        )
    
    def log_action_execution(
        self,
        agent_name: str,
        action_type: str,
        action_data: Dict[str, Any],
        result: Dict[str, Any],
        risk_level: RiskLevel,
    ) -> None:
        """Log action execution"""
        self.log_event(
            event_type=EventType.ACTION_EXECUTED,
            agent_name=agent_name,
            event_data={
                "action_type": action_type,
                "action_data": action_data,
                "result": result,
            },
            risk_level=risk_level,
        )
    
    def log_permission_check(
        self,
        agent_name: str,
        action_type: str,
        decision: str,
        risk_level: RiskLevel,
    ) -> None:
        """Log permission check"""
        self.log_event(
            event_type=EventType.PERMISSION_GRANTED if decision == "allowed" else EventType.PERMISSION_DENIED,
            agent_name=agent_name,
            event_data={
                "action_type": action_type,
                "decision": decision,
            },
            risk_level=risk_level,
        )
    
    def log_error(
        self,
        agent_name: Optional[str],
        error: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Log error event"""
        self.log_event(
            event_type=EventType.ERROR_OCCURRED,
            agent_name=agent_name,
            event_data={
                "error": error,
                "context": context or {},
            },
        )
    
    def _store_in_database(self, audit_entry: Dict[str, Any]) -> None:
        """Store audit log in database (stub for now)"""
        # TODO: Implement database storage
        pass
    
    def get_recent_logs(self, limit: int = 100) -> list:
        """Get recent audit logs"""
        # Read from current log file
        log_file = self.log_dir / f"audit_{datetime.now().strftime('%Y%m%d')}.log"
        
        if not log_file.exists():
            return []
        
        try:
            logs = []
            with open(log_file, 'r') as f:
                lines = f.readlines()
                for line in lines[-limit:]:
                    try:
                        log_entry = json.loads(line)
                        logs.append(log_entry)
                    except json.JSONDecodeError:
                        continue
            return logs
        except Exception as e:
            self.logger.error(f"Error reading logs: {e}")
            return []


# Global audit logger instance
audit_logger = AuditLogger()
