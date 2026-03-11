// Dispatch — cavity-resonance agent routing.
// No embeddings. No APIs. Gene similarity in trit space.

use crate::gene::Gene;
use crate::task::{Task, TaskState, Priority};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentType {
    Scout,    // explore, search, find, locate
    Builder,  // write, create, build, implement
    Tester,   // test, verify, check, validate
    Washer,   // scrub, clean, purge, remove secrets
    Deployer, // deploy, install, configure, setup
    Verifier, // confirm, endpoint, respond, status
}

impl std::fmt::Display for AgentType {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

const AGENT_SIGNATURES: &[(AgentType, &str)] = &[
    (AgentType::Scout,    "explore search find locate discover scan index"),
    (AgentType::Builder,  "write create build implement code generate"),
    (AgentType::Tester,   "test verify check validate assert run suite"),
    (AgentType::Washer,   "scrub clean purge remove secret key rotate"),
    (AgentType::Deployer, "deploy install configure setup scp push ship"),
    (AgentType::Verifier, "confirm endpoint respond status health ping"),
];

/// Match a task to the best agent type by gene similarity.
pub fn match_agent(task: &Task) -> AgentType {
    let task_gene = task.gene();
    let mut best_type = AgentType::Builder;
    let mut best_score = f64::NEG_INFINITY;

    for (agent_type, signature) in AGENT_SIGNATURES {
        let agent_gene = Gene::from_text(signature);
        let score = task_gene.similarity(&agent_gene);
        if score > best_score {
            best_score = score;
            best_type = *agent_type;
        }
    }
    best_type
}

/// Triage: sort by priority, unblock ready tasks.
pub fn triage(tasks: &mut [Task]) {
    // Skip already-done tasks
    for task in tasks.iter_mut() {
        if task.state == TaskState::Queued {
            // Could resolve dependencies here; for now all queued are ready
        }
    }
}

/// Assign all queued tasks to agents. Returns (task_index, agent_type) pairs.
pub fn assign(tasks: &mut [Task]) -> Vec<(usize, AgentType)> {
    let mut assignments = Vec::new();

    // Collect indices sorted by priority
    let mut indices: Vec<usize> = tasks.iter()
        .enumerate()
        .filter(|(_, t)| t.state == TaskState::Queued)
        .map(|(i, _)| i)
        .collect();

    indices.sort_by_key(|&i| tasks[i].priority);

    for idx in indices {
        let agent = match_agent(&tasks[idx]);
        tasks[idx].state = TaskState::Assigned;
        tasks[idx].assigned_to = Some(format!("{:?}", agent));
        assignments.push((idx, agent));
    }

    assignments
}

/// Count unique agent types in assignments.
pub fn unique_agents(assignments: &[(usize, AgentType)]) -> usize {
    let mut seen = std::collections::HashSet::new();
    for (_, agent) in assignments {
        seen.insert(*agent);
    }
    seen.len()
}
