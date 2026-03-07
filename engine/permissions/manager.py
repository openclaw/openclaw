"""
Permission System

Role-based permission system for agent actions with user confirmation.
"""

from typing import Dict, Any, Optional, List
from enum import Enum
from datetime import datetime

from engine.core.models import RiskLevel, ActionType


class PermissionDecision(str, Enum):
    """Permission decision result"""
    ALLOWED = "allowed"
    DENIED = "denied"
    REQUIRES_APPROVAL = "requires_approval"


class PermissionManager:
    """
    Manages permissions and user approvals for agent actions.
    
    Permission Levels:
    - READ_ONLY: Can only read/analyze data
    - ANALYSIS: Can process and transform data
    - AUTOMATION: Can execute actions automatically
    - CRITICAL: Requires user approval
    """
    
    def __init__(self) -> None:
        self.approval_queue: List[Dict[str, Any]] = []
        self.approved_actions: Dict[str, bool] = {}
    
    def check_permission(
        self,
        agent_name: str,
        action_type: ActionType,
        risk_level: RiskLevel,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> PermissionDecision:
        """
        Check if an action is permitted.
        
        Args:
            agent_name: Name of the agent requesting permission
            action_type: Type of action to perform
            risk_level: Risk level of the agent
            action_data: Action configuration/payload
            context: Additional context
        
        Returns:
            Permission decision
        """
        # Generate action ID for tracking
        action_id = self._generate_action_id(agent_name, action_type, action_data)
        
        # Check if already approved
        if action_id in self.approved_actions:
            return PermissionDecision.ALLOWED if self.approved_actions[action_id] else PermissionDecision.DENIED
        
        # Apply permission rules based on risk level
        if risk_level == RiskLevel.READ_ONLY:
            # Read-only agents can only perform safe actions
            if action_type in [ActionType.HTTP]:
                # Check if HTTP action is safe (GET request)
                method = action_data.get("method", "GET").upper()
                if method == "GET":
                    return PermissionDecision.ALLOWED
                else:
                    return PermissionDecision.REQUIRES_APPROVAL
            return PermissionDecision.ALLOWED
        
        elif risk_level == RiskLevel.LOW:
            # Analysis agents can perform data processing
            if action_type in [ActionType.HTTP, ActionType.DATABASE]:
                return PermissionDecision.ALLOWED
            return PermissionDecision.REQUIRES_APPROVAL
        
        elif risk_level in [RiskLevel.MEDIUM, RiskLevel.HIGH]:
            # Automation agents can execute most actions
            if action_type in [ActionType.HTTP, ActionType.DATABASE, ActionType.SCRIPT]:
                return PermissionDecision.ALLOWED
            return PermissionDecision.REQUIRES_APPROVAL
        
        elif risk_level == RiskLevel.CRITICAL:
            # Critical risk level always requires approval
            return PermissionDecision.REQUIRES_APPROVAL
        
        # Default: deny unknown combinations
        return PermissionDecision.DENIED
    
    def request_approval(
        self,
        agent_name: str,
        action_type: ActionType,
        risk_level: RiskLevel,
        action_data: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Request user approval for an action.
        
        Returns:
            Approval request ID
        """
        action_id = self._generate_action_id(agent_name, action_type, action_data)
        
        approval_request = {
            "id": action_id,
            "agent_name": agent_name,
            "action_type": action_type.value,
            "risk_level": risk_level.value,
            "action_data": action_data,
            "context": context or {},
            "requested_at": datetime.now().isoformat(),
            "status": "pending",
        }
        
        self.approval_queue.append(approval_request)
        
        return action_id
    
    def approve_action(self, action_id: str) -> bool:
        """Approve an action"""
        self.approved_actions[action_id] = True
        self._update_queue_status(action_id, "approved")
        return True
    
    def deny_action(self, action_id: str) -> bool:
        """Deny an action"""
        self.approved_actions[action_id] = False
        self._update_queue_status(action_id, "denied")
        return True
    
    def get_pending_approvals(self) -> List[Dict[str, Any]]:
        """Get all pending approval requests"""
        return [req for req in self.approval_queue if req["status"] == "pending"]
    
    def _generate_action_id(
        self,
        agent_name: str,
        action_type: ActionType,
        action_data: Dict[str, Any],
    ) -> str:
        """Generate unique action ID"""
        # Simple hash-based ID (in production, use better method)
        data_str = f"{agent_name}:{action_type.value}:{str(action_data)}"
        return f"action_{hash(data_str) % 1000000:06d}"
    
    def _update_queue_status(self, action_id: str, status: str) -> None:
        """Update approval queue status"""
        for req in self.approval_queue:
            if req["id"] == action_id:
                req["status"] = status
                req["resolved_at"] = datetime.now().isoformat()
                break


# Global permission manager instance
permission_manager = PermissionManager()
