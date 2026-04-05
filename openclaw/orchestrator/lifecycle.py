"""Agent Lifecycle Manager for OpenClaw orchestrator.

Provides process management for agent instances with persistent state.
"""

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Optional


@dataclass
class AgentState:
    """Represents the state of a managed agent."""

    agent_id: str
    command: str
    cwd: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    pid: Optional[int] = None
    status: str = "stopped"  # running, stopped, error
    started_at: Optional[float] = None
    stopped_at: Optional[float] = None
    exit_code: Optional[int] = None

    def to_dict(self) -> Dict:
        """Convert to dictionary, handling None and Omitting None values."""
        data = asdict(self)
        # Remove None values for compact JSON
        return {k: v for k, v in data.items() if v is not None}

    @classmethod
    def from_dict(cls, data: Dict) -> "AgentState":
        return cls(**data)


class AgentLifecycleManager:
    """Manages lifecycle of agent processes."""

    def __init__(self, state_file: str = "/var/lib/openclaw/orchestrator/agent_state.json"):
        """Initialize manager.

        Args:
            state_file: Path to persistent state file.
        """
        self.state_file = Path(state_file)
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.agents: Dict[str, AgentState] = {}
        self._process_handles: Dict[str, subprocess.Popen] = {}
        self._load_state()

    def _load_state(self) -> None:
        """Load persisted agent state from disk."""
        if not self.state_file.exists():
            return
        try:
            with open(self.state_file, "r") as f:
                data = json.load(f)
            for agent_id, agent_data in data.items():
                state = AgentState.from_dict(agent_data)
                self.agents[agent_id] = state
                # If the process was marked running, try to check if it's still alive.
                if state.status == "running" and state.pid:
                    if not self._is_process_alive(state.pid):
                        # Process died; mark as stopped with exit code unknown
                        state.status = "stopped"
                        state.stopped_at = time.time()
        except Exception as e:
            # Log error but continue; corrupted state file could be replaced
            pass

    def _save_state(self) -> None:
        """Persist current agent state to disk."""
        data = {aid: state.to_dict() for aid, state in self.agents.items()}
        try:
            with open(self.state_file, "w") as f:
                json.dump(data, f, indent=2)
        except Exception:
            pass

    def _is_process_alive(self, pid: int) -> bool:
        """Check if a process with given PID exists."""
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def _spawn_process(self, state: AgentState) -> subprocess.Popen:
        """Spawn a new subprocess for the agent."""
        env = os.environ.copy()
        if state.env:
            env.update(state.env)
        cwd = state.cwd or os.getcwd()
        # Use preexec_fn to set process group for easier termination
        proc = subprocess.Popen(
            state.command,
            shell=True,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,  # creates new process group
        )
        return proc

    def start_agent(self, agent_id: str, command: str, cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> AgentState:
        """Start a new agent process.

        Args:
            agent_id: Unique identifier for the agent.
            command: Command to execute (shell string).
            cwd: Working directory (optional).
            env: Additional environment variables (optional).

        Returns:
            The AgentState after starting.
        """
        if agent_id in self.agents:
            existing = self.agents[agent_id]
            if existing.status == "running":
                # Already running; could restart or error
                raise RuntimeError(f"Agent {agent_id} is already running")
            # If exists but stopped, we'll reuse the same command? But we need to update command? We'll allow overriding? For simplicity, if exists we start anew.
        state = AgentState(
            agent_id=agent_id,
            command=command,
            cwd=cwd,
            env=env,
            status="starting",
            started_at=time.time(),
        )
        self.agents[agent_id] = state
        try:
            proc = self._spawn_process(state)
            state.pid = proc.pid
            state.status = "running"
            self._process_handles[agent_id] = proc
        except Exception as e:
            state.status = "error"
            state.stopped_at = time.time()
            raise
        self._save_state()
        return state

    def stop_agent(self, agent_id: str, graceful_timeout: int = 10) -> AgentState:
        """Stop a running agent.

        Args:
            agent_id: Identifier of the agent to stop.
            graceful_timeout: Seconds to wait for graceful termination before SIGKILL.

        Returns:
            The final AgentState.
        """
        if agent_id not in self.agents:
            raise KeyError(f"Agent {agent_id} not found")
        state = self.agents[agent_id]
        if state.status != "running" or state.pid is None:
            # Already stopped; nothing to do
            return state
        # Send SIGTERM to the process group
        try:
            os.killpg(state.pid, signal.SIGTERM)  # because start_new_session created process group leader with same pid as proc? Actually Popen's pid is the group leader if start_new_session=True.
        except OSError:
            pass
        # Wait for process to terminate
        proc = self._process_handles.get(agent_id)
        if proc:
            try:
                proc.wait(timeout=graceful_timeout)
            except subprocess.TimeoutExpired:
                # Force kill
                try:
                    os.killpg(state.pid, signal.SIGKILL)
                except OSError:
                    pass
                proc.wait()
            state.exit_code = proc.returncode
        else:
            # Process handle missing; maybe orphaned; check if process still alive
            if self._is_process_alive(state.pid):
                try:
                    os.killpg(state.pid, signal.SIGKILL)
                except OSError:
                    pass
        state.status = "stopped"
        state.stopped_at = time.time()
        self._process_handles.pop(agent_id, None)
        self._save_state()
        return state

    def restart_agent(self, agent_id: str) -> AgentState:
        """Restart an agent by stopping and starting it again with the same configuration."""
        if agent_id not in self.agents:
            raise KeyError(f"Agent {agent_id} not found")
        state = self.agents[agent_id]
        # Stop current if running
        if state.status == "running":
            self.stop_agent(agent_id)
        # Start anew using stored command/cwd/env
        command = state.command
        cwd = state.cwd
        env = state.env
        # Reset timing fields
        state.started_at = time.time()
        state.stopped_at = None
        state.status = "starting"
        # Actually start
        try:
            proc = self._spawn_process(state)
            state.pid = proc.pid
            state.status = "running"
            state.exit_code = None
            self._process_handles[agent_id] = proc
        except Exception as e:
            state.status = "error"
            state.stopped_at = time.time()
            raise
        self._save_state()
        return state

    def health_check(self, agent_id: str) -> Dict:
        """Return health status of an agent."""
        if agent_id not in self.agents:
            return {"error": f"Agent {agent_id} not found"}
        state = self.agents[agent_id]
        if state.status == "running" and state.pid:
            # Verify process still alive
            if not self._is_process_alive(state.pid):
                # Process died unexpectedly
                state.status = "stopped"
                state.stopped_at = time.time()
                # Try to get exit code? Could use waitpid with WNOHANG, but we don't have proc handle if it died without us noticing? We'll just mark stopped.
        return {
            "agent_id": agent_id,
            "status": state.status,
            "pid": state.pid,
            "uptime": (time.time() - state.started_at) if state.started_at else None,
            "exit_code": state.exit_code,
        }

    def list_agents(self) -> Dict[str, Dict]:
        """Return a summary of all managed agents."""
        return {aid: self.health_check(aid) for aid in self.agents}

    def shutdown(self) -> None:
        """Stop all agents gracefully (e.g., at pod termination)."""
        for agent_id in list(self.agents.keys()):
            state = self.agents[agent_id]
            if state.status == "running":
                try:
                    self.stop_agent(agent_id)
                except Exception:
                    pass
