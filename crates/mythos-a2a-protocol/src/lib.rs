//! Mythos A2A (Agent-to-Agent) Protocol
//!
//! High-performance communication protocol for multi-agent orchestration.
//! Supports pub/sub, direct messaging, blackboard pattern, and hierarchical coordination.
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────┐
//! │                   A2A Protocol Layer                    │
//! ├─────────────────────────────────────────────────────────┤
//! │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
//! │  │  Pub/Sub     │  │  Blackboard  │  │  Direct Msg  │ │
//! │  │  Channels    │  │  (Shared)    │  │  (P2P)       │ │
//! │  └──────────────┘  └──────────────┘  └──────────────┘ │
//! ├─────────────────────────────────────────────────────────┤
//! │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
//! │  │  Agent       │  │  Message     │  │  Task        │ │
//! │  │  Registry    │  │  Router      │  │  Coordinator │ │
//! │  └──────────────┘  └──────────────┘  └──────────────┘ │
//! └─────────────────────────────────────────────────────────┘
//! ```

use dashmap::DashMap;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use uuid::Uuid;

// ─── Core Types ──────────────────────────────────────────────────────────────

#[napi(string_enum)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageType {
    Request,
    Response,
    Event,
    Task,
    Heartbeat,
    Error,
}

#[napi(string_enum)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentStatus {
    Idle,
    Busy,
    Blocked,
    Error,
    Offline,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub capabilities: Vec<String>,
    pub registered_at: u64,
    pub last_heartbeat: u64,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2AMessage {
    pub id: String,
    pub from_agent: String,
    pub to_agent: String,
    pub message_type: String,
    pub topic: Option<String>,
    pub payload: String,
    pub timestamp: u64,
    pub correlation_id: Option<String>,
    pub priority: u8,
    pub ttl_ms: Option<u64>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub assigned_to: String,
    pub created_by: String,
    pub description: String,
    pub status: String,
    pub priority: u8,
    pub created_at: u64,
    pub updated_at: u64,
    pub result: Option<String>,
    pub dependencies: Vec<String>,
    pub metadata: Option<String>,
}

// ─── Agent Registry ──────────────────────────────────────────────────────────

/// Agent registry for managing agent discovery and routing
#[napi]
pub struct AgentRegistry {
    agents: Arc<DashMap<String, AgentInfo>>,
    topics: Arc<DashMap<String, Vec<String>>>,
    event_sender: broadcast::Sender<A2AMessage>,
}

#[napi]
impl AgentRegistry {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let (event_sender, _) = broadcast::channel(10000);
        Ok(Self {
            agents: Arc::new(DashMap::new()),
            topics: Arc::new(DashMap::new()),
            event_sender,
        })
    }

    /// Register a new agent
    #[napi]
    pub fn register_agent(&self, info: AgentInfo) -> Result<bool> {
        let agent_id = info.id.clone();
        self.agents.insert(agent_id.clone(), info.clone());
        
        // Register agent for its topics
        if let Some(caps) = info.capabilities.first() {
            let mut topic_agents = self.topics.entry(caps.clone()).or_insert_with(Vec::new);
            if !topic_agents.contains(&agent_id) {
                topic_agents.push(agent_id);
            }
        }
        
        tracing::info!("Agent registered: {}", agent_id);
        Ok(true)
    }

    /// Unregister an agent
    #[napi]
    pub fn unregister_agent(&self, agent_id: String) -> Result<bool> {
        let removed = self.agents.remove(&agent_id).is_some();
        
        // Remove from topics
        for mut entry in self.topics.iter_mut() {
            entry.value_mut().retain(|id| id != &agent_id);
        }
        
        tracing::info!("Agent unregistered: {}", agent_id);
        Ok(removed)
    }

    /// Get agent info
    #[napi]
    pub fn get_agent(&self, agent_id: String) -> Result<Option<AgentInfo>> {
        Ok(self.agents.get(&agent_id).map(|a| a.value().clone()))
    }

    /// List all agents
    #[napi]
    pub fn list_agents(&self) -> Result<Vec<AgentInfo>> {
        Ok(self.agents.iter().map(|e| e.value().clone()).collect())
    }

    /// Update agent status
    #[napi]
    pub fn update_agent_status(&self, agent_id: String, status: String) -> Result<bool> {
        if let Some(mut agent) = self.agents.get_mut(&agent_id) {
            agent.status = status;
            agent.last_heartbeat = chrono::Utc::now().timestamp_millis() as u64;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Get agents by capability
    #[napi]
    pub fn get_agents_by_capability(&self, capability: String) -> Result<Vec<AgentInfo>> {
        Ok(self
            .agents
            .iter()
            .filter(|a| a.value().capabilities.contains(&capability))
            .map(|a| a.value().clone())
            .collect())
    }

    /// Subscribe to topic
    #[napi]
    pub fn subscribe(&self, agent_id: String, topic: String) -> Result<bool> {
        let mut topic_agents = self.topics.entry(topic.clone()).or_insert_with(Vec::new);
        if !topic_agents.contains(&agent_id) {
            topic_agents.push(agent_id.clone());
            tracing::info!("Agent {} subscribed to topic {}", agent_id, topic);
        }
        Ok(true)
    }

    /// Unsubscribe from topic
    #[napi]
    pub fn unsubscribe(&self, agent_id: String, topic: String) -> Result<bool> {
        if let Some(mut topic_agents) = self.topics.get_mut(&topic) {
            topic_agents.retain(|id| id != &agent_id);
            tracing::info!("Agent {} unsubscribed from topic {}", agent_id, topic);
        }
        Ok(true)
    }

    /// Get subscribers for topic
    #[napi]
    pub fn get_subscribers(&self, topic: String) -> Result<Vec<String>> {
        Ok(self
            .topics
            .get(&topic)
            .map(|v| v.value().clone())
            .unwrap_or_default())
    }
}

// ─── Message Router ──────────────────────────────────────────────────────────

/// High-performance message router for A2A communication
#[napi]
pub struct MessageRouter {
    registry: Arc<AgentRegistry>,
    message_queue: Arc<DashMap<String, Vec<A2AMessage>>>,
    priority_queue: Arc<DashMap<u8, Vec<A2AMessage>>>,
}

#[napi]
impl MessageRouter {
    #[napi(constructor)]
    pub fn new(registry: napi::JsObject) -> Result<Self> {
        // In real implementation, would extract AgentRegistry from JS object
        // For now, create a new one
        let registry = Arc::new(AgentRegistry::new()?);
        Ok(Self {
            registry,
            message_queue: Arc::new(DashMap::new()),
            priority_queue: Arc::new(DashMap::new()),
        })
    }

    /// Send direct message to agent
    #[napi]
    pub fn send_direct(&self, message: A2AMessage) -> Result<bool> {
        let to_agent = message.to_agent.clone();
        
        // Validate recipient exists
        if self.registry.get_agent(to_agent.clone())?.is_none() {
            return Err(Error::from_reason(format!("Agent {} not found", to_agent)));
        }
        
        // Queue message
        let mut queue = self.message_queue.entry(to_agent).or_insert_with(Vec::new);
        queue.push(message);
        
        Ok(true)
    }

    /// Publish message to topic
    #[napi]
    pub fn publish(&self, message: A2AMessage) -> Result<u32> {
        let topic = message.topic.clone().ok_or_else(|| {
            Error::from_reason("Topic is required for publish")
        })?;
        
        let subscribers = self.registry.get_subscribers(topic)?;
        let mut delivered = 0;
        
        for subscriber in subscribers {
            let mut msg = message.clone();
            msg.to_agent = subscriber.clone();
            
            if self.send_direct(msg).is_ok() {
                delivered += 1;
            }
        }
        
        Ok(delivered)
    }

    /// Receive messages for agent
    #[napi]
    pub fn receive(&self, agent_id: String, limit: u32) -> Result<Vec<A2AMessage>> {
        let mut queue = self.message_queue.entry(agent_id).or_insert_with(Vec::new);
        let limit = limit as usize;
        let messages: Vec<A2AMessage> = queue.drain(..limit.min(queue.len())).collect();
        Ok(messages)
    }

    /// Get pending message count
    #[napi]
    pub fn pending_count(&self, agent_id: String) -> Result<u32> {
        Ok(self
            .message_queue
            .get(&agent_id)
            .map(|q| q.len() as u32)
            .unwrap_or(0))
    }

    /// Clear message queue for agent
    #[napi]
    pub fn clear_queue(&self, agent_id: String) -> Result<u32> {
        let removed = self.message_queue.remove(&agent_id).map(|(_, v)| v.len() as u32).unwrap_or(0);
        Ok(removed)
    }
}

// ─── Task Coordinator ────────────────────────────────────────────────────────

/// Task coordinator for managing multi-agent workflows
#[napi]
pub struct TaskCoordinator {
    tasks: Arc<DashMap<String, Task>>,
    dependencies: Arc<DashMap<String, Vec<String>>>,
}

#[napi]
impl TaskCoordinator {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            tasks: Arc::new(DashMap::new()),
            dependencies: Arc::new(DashMap::new()),
        })
    }

    /// Create a new task
    #[napi]
    pub fn create_task(&self, task: Task) -> Result<String> {
        let task_id = task.id.clone();
        
        // Register dependencies
        for dep in &task.dependencies {
            let mut dependents = self.dependencies.entry(dep.clone()).or_insert_with(Vec::new);
            if !dependents.contains(&task_id) {
                dependents.push(task_id.clone());
            }
        }
        
        self.tasks.insert(task_id.clone(), task);
        tracing::info!("Task created: {}", task_id);
        
        Ok(task_id)
    }

    /// Get task by ID
    #[napi]
    pub fn get_task(&self, task_id: String) -> Result<Option<Task>> {
        Ok(self.tasks.get(&task_id).map(|t| t.value().clone()))
    }

    /// Update task status
    #[napi]
    pub fn update_task_status(&self, task_id: String, status: String, result: Option<String>) -> Result<bool> {
        if let Some(mut task) = self.tasks.get_mut(&task_id) {
            task.status = status;
            task.result = result;
            task.updated_at = chrono::Utc::now().timestamp_millis() as u64;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Get tasks by status
    #[napi]
    pub fn get_tasks_by_status(&self, status: String) -> Result<Vec<Task>> {
        Ok(self
            .tasks
            .iter()
            .filter(|t| t.value().status == status)
            .map(|t| t.value().clone())
            .collect())
    }

    /// Get tasks assigned to agent
    #[napi]
    pub fn get_tasks_by_agent(&self, agent_id: String) -> Result<Vec<Task>> {
        Ok(self
            .tasks
            .iter()
            .filter(|t| t.value().assigned_to == agent_id)
            .map(|t| t.value().clone())
            .collect())
    }

    /// Check if task dependencies are met
    #[napi]
    pub fn are_dependencies_met(&self, task_id: String) -> Result<bool> {
        if let Some(task) = self.tasks.get(&task_id) {
            for dep_id in &task.dependencies {
                if let Some(dep_task) = self.tasks.get(dep_id) {
                    if dep_task.status != "completed" {
                        return Ok(false);
                    }
                } else {
                    return Ok(false);
                }
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Get tasks ready to execute (dependencies met)
    #[napi]
    pub fn get_ready_tasks(&self) -> Result<Vec<Task>> {
        let mut ready = Vec::new();
        for entry in self.tasks.iter() {
            let task = entry.value();
            if task.status == "pending" && self.are_dependencies_met(task.id.clone())? {
                ready.push(task.clone());
            }
        }
        Ok(ready)
    }

    /// Cancel a task
    #[napi]
    pub fn cancel_task(&self, task_id: String) -> Result<bool> {
        if let Some(mut task) = self.tasks.get_mut(&task_id) {
            task.status = "cancelled".to_string();
            task.updated_at = chrono::Utc::now().timestamp_millis() as u64;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Get task statistics
    #[napi]
    pub fn get_statistics(&self) -> Result<TaskStatistics> {
        let mut stats = TaskStatistics {
            total: 0,
            pending: 0,
            in_progress: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
        };
        
        for entry in self.tasks.iter() {
            stats.total += 1;
            match entry.value().status.as_str() {
                "pending" => stats.pending += 1,
                "in_progress" => stats.in_progress += 1,
                "completed" => stats.completed += 1,
                "failed" => stats.failed += 1,
                "cancelled" => stats.cancelled += 1,
                _ => {}
            }
        }
        
        Ok(stats)
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct TaskStatistics {
    pub total: u32,
    pub pending: u32,
    pub in_progress: u32,
    pub completed: u32,
    pub failed: u32,
    pub cancelled: u32,
}

// ─── Blackboard (Shared State) ───────────────────────────────────────────────

/// Blackboard pattern for shared state between agents
#[napi]
pub struct Blackboard {
    entries: Arc<DashMap<String, String>>,
    metadata: Arc<DashMap<String, String>>,
}

#[napi]
impl Blackboard {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            entries: Arc::new(DashMap::new()),
            metadata: Arc::new(DashMap::new()),
        })
    }

    /// Write to blackboard
    #[napi]
    pub fn write(&self, key: String, value: String, author: String) -> Result<bool> {
        self.entries.insert(key.clone(), value);
        self.metadata.insert(key, author);
        Ok(true)
    }

    /// Read from blackboard
    #[napi]
    pub fn read(&self, key: String) -> Result<Option<String>> {
        Ok(self.entries.get(&key).map(|v| v.value().clone()))
    }

    /// Check if key exists
    #[napi]
    pub fn exists(&self, key: String) -> Result<bool> {
        Ok(self.entries.contains_key(&key))
    }

    /// Delete from blackboard
    #[napi]
    pub fn delete(&self, key: String) -> Result<bool> {
        let removed = self.entries.remove(&key).is_some();
        self.metadata.remove(&key);
        Ok(removed)
    }

    /// List all keys
    #[napi]
    pub fn list_keys(&self) -> Result<Vec<String>> {
        Ok(self.entries.iter().map(|e| e.key().clone()).collect())
    }

    /// Get all entries
    #[napi]
    pub fn get_all(&self) -> Result<Vec<BlackboardEntry>> {
        Ok(self
            .entries
            .iter()
            .map(|e| BlackboardEntry {
                key: e.key().clone(),
                value: e.value().clone(),
                author: self
                    .metadata
                    .get(e.key())
                    .map(|m| m.value().clone())
                    .unwrap_or_default(),
            })
            .collect())
    }

    /// Clear blackboard
    #[napi]
    pub fn clear(&self) -> Result<u32> {
        let count = self.entries.len() as u32;
        self.entries.clear();
        self.metadata.clear();
        Ok(count)
    }

    /// Search by pattern
    #[napi]
    pub fn search(&self, pattern: String) -> Result<Vec<BlackboardEntry>> {
        Ok(self
            .entries
            .iter()
            .filter(|e| e.key().contains(&pattern) || e.value().contains(&pattern))
            .map(|e| BlackboardEntry {
                key: e.key().clone(),
                value: e.value().clone(),
                author: self
                    .metadata
                    .get(e.key())
                    .map(|m| m.value().clone())
                    .unwrap_or_default(),
            })
            .collect())
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BlackboardEntry {
    pub key: String,
    pub value: String,
    pub author: String,
}
