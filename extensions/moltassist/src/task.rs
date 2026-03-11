// Task — atomic unit of work in the pit crew.

use serde::{Serialize, Deserialize};
use crate::gene::Gene;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskState {
    Queued,
    Assigned,
    Running,
    Verifying,
    Done,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Priority {
    Critical = 0,
    High = 1,
    Medium = 2,
    Low = 3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub description: String,
    pub project: String,
    pub priority: Priority,
    pub state: TaskState,
    pub assigned_to: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub verify_cmd: Option<String>,
    #[serde(skip)]
    pub gene: Option<Gene>,
    #[serde(skip)]
    pub started_at: Option<std::time::Instant>,
    #[serde(skip)]
    pub elapsed_secs: f64,
}

impl Task {
    pub fn new(id: &str, description: &str, project: &str) -> Self {
        let gene = Gene::from_text(description);
        let priority = infer_priority(description);
        Task {
            id: id.to_string(),
            description: description.to_string(),
            project: project.to_string(),
            priority,
            state: TaskState::Queued,
            assigned_to: None,
            result: None,
            error: None,
            verify_cmd: None,
            gene: Some(gene),
            started_at: None,
            elapsed_secs: 0.0,
        }
    }

    pub fn gene(&self) -> Gene {
        self.gene.clone().unwrap_or_else(|| Gene::from_text(&self.description))
    }
}

fn infer_priority(desc: &str) -> Priority {
    let d = desc.to_lowercase();
    if ["scrub", "key", "secret", "rotate", "security", "critical"]
        .iter().any(|w| d.contains(w)) {
        Priority::Critical
    } else if ["build", "create", "implement", "write", "deploy", "ship"]
        .iter().any(|w| d.contains(w)) {
        Priority::High
    } else if ["test", "verify", "check", "validate", "run"]
        .iter().any(|w| d.contains(w)) {
        Priority::Medium
    } else {
        Priority::Low
    }
}
