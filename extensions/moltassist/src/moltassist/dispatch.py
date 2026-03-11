"""
nox.pitcrew.dispatch â€” Cavity-resonance agent routing
No embeddings. No APIs. Pure ternary gene matching.
"""
import enum
from dataclasses import dataclass, field
from typing import List, Optional, Dict
from .task import Task, TaskState, text_to_gene, gene_similarity


class AgentType(enum.Enum):
    SCOUT = "scout"         # Explore, search, find, locate
    BUILDER = "builder"     # Write, create, build, implement
    TESTER = "tester"       # Test, verify, check, validate
    WASHER = "washer"       # Scrub, clean, purge, remove secrets
    DEPLOYER = "deployer"   # Deploy, install, configure, setup
    VERIFIER = "verifier"   # Confirm, endpoint, respond, status


# Cavity signatures â€” deterministic from role description
AGENT_SIGNATURES: Dict[AgentType, str] = {
    AgentType.SCOUT:    text_to_gene("explore search find locate discover scan index"),
    AgentType.BUILDER:  text_to_gene("write create build implement code generate"),
    AgentType.TESTER:   text_to_gene("test verify check validate assert run suite"),
    AgentType.WASHER:   text_to_gene("scrub clean purge remove secret key rotate"),
    AgentType.DEPLOYER: text_to_gene("deploy install configure setup scp push ship"),
    AgentType.VERIFIER: text_to_gene("confirm endpoint respond status health ping"),
}


@dataclass
class Agent:
    """A specialist agent with a cavity signature."""
    id: str
    agent_type: AgentType
    gene: str = ""
    busy: bool = False
    tasks_completed: int = 0
    current_task: Optional[str] = None

    def __post_init__(self):
        if not self.gene:
            self.gene = AGENT_SIGNATURES.get(self.agent_type, text_to_gene(self.id))


@dataclass
class Dispatcher:
    """Routes tasks to agents via cavity resonance matching."""
    agents: List[Agent] = field(default_factory=list)
    threshold: float = -1.0  # Accept any match (cavity always finds nearest)

    def __post_init__(self):
        if not self.agents:
            # Spawn default crew â€” one of each type
            for i, at in enumerate(AgentType):
                self.agents.append(Agent(id=f"{at.value}-{i}", agent_type=at))

    def match(self, task: Task) -> Optional[Agent]:
        """Find best available agent for task via gene similarity."""
        best_agent = None
        best_score = self.threshold

        for agent in self.agents:
            if agent.busy:
                continue
            score = gene_similarity(task.gene, agent.gene)
            if score > best_score:
                best_score = score
                best_agent = agent

        return best_agent

    def assign(self, task: Task) -> Optional[Agent]:
        """Match and assign task to best agent."""
        agent = self.match(task)
        if agent:
            agent.busy = True
            agent.current_task = task.id
            task.state = TaskState.ASSIGNED
            task.assigned_to = agent.id
        return agent

    def release(self, agent_id: str):
        """Free agent after task completion."""
        for agent in self.agents:
            if agent.id == agent_id:
                agent.busy = False
                agent.current_task = None
                agent.tasks_completed += 1
                break

    def assign_all(self, tasks: List[Task]) -> List[tuple]:
        """Assign all ready tasks. Returns [(task, agent)] pairs."""
        assignments = []
        ready = [t for t in tasks if t.is_ready]
        # Sort by priority (CRITICAL=0 first)
        ready.sort(key=lambda t: t.priority.value)
        for task in ready:
            agent = self.assign(task)
            if agent:
                assignments.append((task, agent))
        return assignments

    def status(self) -> dict:
        return {
            'total_agents': len(self.agents),
            'busy': sum(1 for a in self.agents if a.busy),
            'free': sum(1 for a in self.agents if not a.busy),
            'agents': [
                {
                    'id': a.id,
                    'type': a.agent_type.value,
                    'busy': a.busy,
                    'current_task': a.current_task,
                    'completed': a.tasks_completed,
                    'gene': a.gene[:12] + '...',
                }
                for a in self.agents
            ],
        }
