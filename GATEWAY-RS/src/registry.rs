use std::collections::HashMap;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodeInfo {
    pub id: String,
    pub name: String,
    pub version: String,
}

pub struct NodeRegistry {
    nodes: Mutex<HashMap<String, NodeInfo>>,
}

impl NodeRegistry {
    pub fn new() -> Self {
        Self {
            nodes: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, node: NodeInfo) {
        let mut nodes = self.nodes.lock().unwrap();
        nodes.insert(node.id.clone(), node);
    }

    pub fn unregister(&self, id: &str) {
        let mut nodes = self.nodes.lock().unwrap();
        nodes.remove(id);
    }

    pub fn list(&self) -> Vec<NodeInfo> {
        let nodes = self.nodes.lock().unwrap();
        nodes.values().cloned().collect()
    }
}
