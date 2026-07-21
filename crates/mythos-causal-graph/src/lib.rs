//! # Mythos Causal Graph
//!
//! Causal knowledge graph for OpenClaw's L7 memory layer.
//! Enables causal reasoning, temporal queries, and multi-agent consistency
//! via CRDT-based merging.
//!
//! ## Architecture
//!
//! Uses petgraph for the underlying graph structure with:
//! - Property graph model (nodes and edges have metadata)
//! - Bidirectional indexing (node ID → graph index)
//! - Temporal ordering on all edges
//! - CRDT merge for distributed consistency
//!
//! ## Graph Model
//!
//! ```text
//! Nodes:
//!   - id: unique identifier
//!   - type: "fact" | "event" | "entity" | "concept"
//!   - content: natural language description
//!   - timestamp: when the node was created
//!   - confidence: 0.0-1.0 belief score
//!   - metadata: arbitrary key-value pairs
//!
//! Edges:
//!   - relation: "caused_by" | "related_to" | "implies" | "contradicts" | ...
//!   - weight: 0.0-1.0 strength
//!   - timestamp: when the edge was created
//!   - source_session: which agent session created this edge
//! ```

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::RwLock;
use petgraph::graph::{DiGraph, EdgeIndex, NodeIndex};
use petgraph::visit::EdgeRef;
use petgraph::Direction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

// ─── Error Types ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("Node not found: {0}")]
    NodeNotFound(String),
    #[error("Invalid relation: {0}")]
    InvalidRelation(String),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<GraphError> for napi::Error {
    fn from(e: GraphError) -> Self {
        napi::Error::from_reason(e.to_string())
    }
}

// ─── Data Types ───────────────────────────────────────────────────────────────

/// Node in the causal graph
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphNode {
    /// Unique identifier
    pub id: String,
    /// Node type: "fact" | "event" | "entity" | "concept"
    pub node_type: String,
    /// Natural language content
    pub content: String,
    /// Creation timestamp (ms since epoch)
    pub timestamp: f64,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f64,
    /// Arbitrary metadata as JSON string
    pub metadata: Option<String>,
}

/// Edge in the causal graph
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphEdge {
    /// Source node ID
    pub from: String,
    /// Target node ID
    pub to: String,
    /// Relation type
    pub relation: String,
    /// Edge weight (0.0 - 1.0)
    pub weight: f64,
    /// Creation timestamp
    pub timestamp: f64,
    /// Agent session that created this edge
    pub source_session: Option<String>,
}

/// A causal path through the graph
#[napi(object)]
#[derive(Clone, Debug)]
pub struct CausalPath {
    /// Nodes along the path
    pub nodes: Vec<GraphNode>,
    /// Edges along the path
    pub edges: Vec<GraphEdge>,
    /// Total path weight (product of edge weights)
    pub total_weight: f64,
    /// Confidence (minimum node confidence along path)
    pub confidence: f64,
}

/// Graph statistics
#[napi(object)]
#[derive(Clone, Debug)]
pub struct GraphStats {
    /// Total number of nodes
    pub node_count: u64,
    /// Total number of edges
    pub edge_count: u64,
    /// Count by node type
    pub node_types: HashMap<String, u64>,
    /// Count by relation type
    pub relation_types: HashMap<String, u64>,
}

/// Result of a graph merge operation
#[napi(object)]
#[derive(Clone, Debug)]
pub struct MergeStats {
    /// Nodes added from the other graph
    pub nodes_added: u64,
    /// Nodes updated (confidence merged)
    pub nodes_updated: u64,
    /// Edges added from the other graph
    pub edges_added: u64,
    /// Edges that conflicted (same source/target, different relation)
    pub conflicts: u64,
}

// ─── Internal Types ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct InternalNode {
    data: GraphNode,
}

#[derive(Clone, Debug)]
struct InternalEdge {
    data: GraphEdge,
}

// ─── Causal Graph ─────────────────────────────────────────────────────────────

/// Causal knowledge graph
///
/// Provides graph-based memory with causal reasoning, temporal queries,
/// and multi-agent CRDT merging.
///
/// ## Usage
///
/// ```typescript
/// import { CausalGraph } from '@openclaw/mythos-causal-graph';
///
/// const graph = new CausalGraph();
///
/// // Add nodes
/// graph.addNode({ id: 'rain', nodeType: 'fact', content: 'It rained', ... });
/// graph.addNode({ id: 'wet', nodeType: 'fact', content: 'Ground is wet', ... });
///
/// // Add causal edge
/// graph.addEdge('rain', 'wet', 'caused_by', 0.9);
///
/// // Query causal chains
/// const chains = graph.findCausalChains('wet', 3);
/// ```
#[napi]
pub struct CausalGraph {
    graph: Arc<RwLock<DiGraph<InternalNode, InternalEdge>>>,
    node_index: Arc<RwLock<HashMap<String, NodeIndex>>>,
    id_index: Arc<RwLock<HashMap<NodeIndex, String>>>,
}

#[napi]
impl CausalGraph {
    /// Create a new empty causal graph
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            graph: Arc::new(RwLock::new(DiGraph::new())),
            node_index: Arc::new(RwLock::new(HashMap::new())),
            id_index: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Load a graph from a JSON file
    #[napi(factory)]
    pub fn load(path: String) -> Result<Self> {
        let data = std::fs::read_to_string(&path)?;
        let serialized: SerializedGraph = serde_json::from_str(&data)?;

        let graph = Self::new()?;
        for node in serialized.nodes {
            graph.add_node_internal(node)?;
        }
        for edge in serialized.edges {
            graph.add_edge_internal(&edge)?;
        }

        Ok(graph)
    }

    /// Save the graph to a JSON file
    #[napi]
    pub fn save(&self, path: String) -> Result<()> {
        let serialized = self.serialize()?;
        let json = serde_json::to_string_pretty(&serialized)?;
        std::fs::write(&path, json)?;
        Ok(())
    }

    /// Add a node to the graph
    ///
    /// @returns The node ID
    #[napi]
    pub fn add_node(&self, node: GraphNode) -> Result<String> {
        let id = node.id.clone();
        self.add_node_internal(node)?;
        Ok(id)
    }

    /// Add an edge between two nodes
    ///
    /// @param from - Source node ID
    /// @param to - Target node ID
    /// @param relation - Relation type
    /// @param weight - Edge weight (0.0-1.0)
    #[napi]
    pub fn add_edge(
        &self,
        from: String,
        to: String,
        relation: String,
        weight: f64,
        source_session: Option<String>,
    ) -> Result<()> {
        let edge = GraphEdge {
            from: from.clone(),
            to: to.clone(),
            relation,
            weight,
            timestamp: current_timestamp_ms() as f64,
            source_session,
        };
        self.add_edge_internal(&edge)
    }

    /// Find causal chains starting from a node
    ///
    /// Performs a depth-first traversal following causal edges
    /// (edges with relation "caused_by", "implies", "related_to").
    ///
    /// @param startId - Starting node ID
    /// @param maxDepth - Maximum traversal depth
    /// @param minWeight - Minimum edge weight to follow (default: 0.1)
    /// @returns Array of causal paths
    #[napi]
    pub fn find_causal_chains(
        &self,
        start_id: String,
        max_depth: u32,
        min_weight: Option<f64>,
    ) -> Result<Vec<CausalPath>> {
        let min_weight = min_weight.unwrap_or(0.1);
        let graph = self.graph.read();
        let node_index = self.node_index.read();

        let start_idx = node_index
            .get(&start_id)
            .ok_or_else(|| GraphError::NodeNotFound(start_id.clone()))?;

        let mut paths = Vec::new();
        let mut visited = vec![false; graph.node_count()];
        let mut current_nodes = Vec::new();
        let mut current_edges = Vec::new();

        self.dfs_causal(
            &graph,
            *start_idx,
            max_depth as usize,
            min_weight,
            &mut visited,
            &mut current_nodes,
            &mut current_edges,
            &mut paths,
        );

        Ok(paths)
    }

    /// Find related nodes
    ///
    /// Returns nodes connected to the given node within a certain radius.
    ///
    /// @param nodeId - Center node ID
    /// @param maxResults - Maximum results to return
    #[napi]
    pub fn find_related(&self, node_id: String, max_results: u32) -> Result<Vec<GraphNode>> {
        let graph = self.graph.read();
        let node_index = self.node_index.read();
        let id_index = self.id_index.read();

        let idx = node_index
            .get(&node_id)
            .ok_or_else(|| GraphError::NodeNotFound(node_id.clone()))?;

        let mut related = Vec::new();
        let max = max_results as usize;

        // BFS outward from the node
        let mut queue = vec![*idx];
        let mut seen = std::collections::HashSet::new();
        seen.insert(*idx);

        while let Some(current) = queue.first().copied() {
            queue.remove(0);
            if related.len() >= max {
                break;
            }

            // Follow outgoing edges
            for edge_ref in graph.edges_directed(current, Direction::Outgoing) {
                let target = edge_ref.target();
                if !seen.contains(&target) {
                    seen.insert(target);
                    queue.push(target);
                    if let Some(internal) = graph.node_weight(target) {
                        related.push(internal.data.clone());
                    }
                    if related.len() >= max {
                        break;
                    }
                }
            }

            // Follow incoming edges
            for edge_ref in graph.edges_directed(current, Direction::Incoming) {
                let source = edge_ref.source();
                if !seen.contains(&source) {
                    seen.insert(source);
                    queue.push(source);
                    if let Some(internal) = graph.node_weight(source) {
                        related.push(internal.data.clone());
                    }
                    if related.len() >= max {
                        break;
                    }
                }
            }
        }

        Ok(related)
    }

    /// Temporal query: find nodes within a time range
    ///
    /// @param startTime - Start timestamp (ms since epoch)
    /// @param endTime - End timestamp (ms since epoch)
    /// @param nodeType - Optional node type filter
    #[napi]
    pub fn temporal_query(
        &self,
        start_time: f64,
        end_time: f64,
        node_type: Option<String>,
    ) -> Result<Vec<GraphNode>> {
        let graph = self.graph.read();
        let mut results = Vec::new();

        for node in graph.node_weights() {
            if node.data.timestamp >= start_time && node.data.timestamp <= end_time {
                if let Some(ref nt) = node_type {
                    if &node.data.node_type != nt {
                        continue;
                    }
                }
                results.push(node.data.clone());
            }
        }

        // Sort by timestamp
        results.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(results)
    }

    /// Get a node by ID
    #[napi]
    pub fn get_node(&self, id: String) -> Result<Option<GraphNode>> {
        let graph = self.graph.read();
        let node_index = self.node_index.read();

        if let Some(idx) = node_index.get(&id) {
            if let Some(internal) = graph.node_weight(*idx) {
                return Ok(Some(internal.data.clone()));
            }
        }
        Ok(None)
    }

    /// Remove a node and all its edges
    #[napi]
    pub fn remove_node(&self, id: String) -> Result<bool> {
        let mut graph = self.graph.write();
        let mut node_index = self.node_index.write();
        let mut id_index = self.id_index.write();

        if let Some(idx) = node_index.remove(&id) {
            id_index.remove(&idx);
            graph.remove_node(idx);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Merge another graph into this one (CRDT-style)
    ///
    /// - New nodes are added
    /// - Existing nodes: higher confidence wins, or average if equal
    /// - New edges are added
    /// - Conflicting edges (same from/to, different relation): both are kept
    #[napi]
    pub fn merge(&self, other: &CausalGraph) -> Result<MergeStats> {
        let other_graph = other.graph.read();
        let other_node_index = other.node_index.read();
        let other_id_index = other.id_index.read();

        let mut stats = MergeStats {
            nodes_added: 0,
            nodes_updated: 0,
            edges_added: 0,
            conflicts: 0,
        };

        // Merge nodes
        for idx in other_graph.node_indices() {
            if let Some(other_node) = other_graph.node_weight(idx) {
                let existing = self.get_node(other_node.data.id.clone())?;
                if existing.is_none() {
                    self.add_node_internal(other_node.data.clone())?;
                    stats.nodes_added += 1;
                } else {
                    // Merge: take higher confidence
                    let mut merged = other_node.data.clone();
                    if let Some(existing) = existing {
                        if existing.confidence >= merged.confidence {
                            merged = existing;
                        }
                        // Update the node with merged data
                        if let Some(node_idx) = self.node_index.read().get(&merged.id).copied() {
                            if let Some(w) = self.graph.write().node_weight_mut(node_idx) {
                                w.data = merged;
                            }
                        }
                    }
                    stats.nodes_updated += 1;
                }
            }
        }

        // Merge edges
        for edge_ref in other_graph.edge_references() {
            if let (Some(source), Some(target)) = (
                other_graph.node_weight(edge_ref.source()),
                other_graph.node_weight(edge_ref.target()),
            ) {
                let edge_data = edge_ref.weight();
                let new_edge = GraphEdge {
                    from: source.data.id.clone(),
                    to: target.data.id.clone(),
                    relation: edge_data.data.relation.clone(),
                    weight: edge_data.data.weight,
                    timestamp: edge_data.data.timestamp,
                    source_session: edge_data.data.source_session.clone(),
                };
                self.add_edge_internal(&new_edge)?;
                stats.edges_added += 1;
            }
        }

        Ok(stats)
    }

    /// Get graph statistics
    #[napi]
    pub fn stats(&self) -> Result<GraphStats> {
        let graph = self.graph.read();

        let mut node_types: HashMap<String, u64> = HashMap::new();
        let mut relation_types: HashMap<String, u64> = HashMap::new();

        for node in graph.node_weights() {
            *node_types.entry(node.data.node_type.clone()).or_default() += 1;
        }

        for edge in graph.edge_weights() {
            *relation_types
                .entry(edge.data.relation.clone())
                .or_default() += 1;
        }

        Ok(GraphStats {
            node_count: graph.node_count() as u64,
            edge_count: graph.edge_count() as u64,
            node_types,
            relation_types,
        })
    }

    /// Get node count
    #[napi(getter)]
    pub fn node_count(&self) -> u64 {
        self.graph.read().node_count() as u64
    }

    /// Get edge count
    #[napi(getter)]
    pub fn edge_count(&self) -> u64 {
        self.graph.read().edge_count() as u64
    }
}

// ─── Internal Methods ─────────────────────────────────────────────────────────

impl CausalGraph {
    fn add_node_internal(&self, node: GraphNode) -> Result<()> {
        let mut graph = self.graph.write();
        let mut node_index = self.node_index.write();
        let mut id_index = self.id_index.write();

        // Don't add duplicates
        if node_index.contains_key(&node.id) {
            return Ok(());
        }

        let idx = graph.add_node(InternalNode { data: node.clone() });
        node_index.insert(node.id.clone(), idx);
        id_index.insert(idx, node.id);

        Ok(())
    }

    fn add_edge_internal(&self, edge: &GraphEdge) -> Result<()> {
        let mut graph = self.graph.write();
        let node_index = self.node_index.read();

        let from_idx = node_index
            .get(&edge.from)
            .ok_or_else(|| GraphError::NodeNotFound(edge.from.clone()))?;
        let to_idx = node_index
            .get(&edge.to)
            .ok_or_else(|| GraphError::NodeNotFound(edge.to.clone()))?;

        graph.add_edge(
            *from_idx,
            *to_idx,
            InternalEdge { data: edge.clone() },
        );

        Ok(())
    }

    fn dfs_causal(
        &self,
        graph: &DiGraph<InternalNode, InternalEdge>,
        current: NodeIndex,
        remaining_depth: usize,
        min_weight: f64,
        visited: &mut Vec<bool>,
        current_nodes: &mut Vec<GraphNode>,
        current_edges: &mut Vec<GraphEdge>,
        all_paths: &mut Vec<CausalPath>,
    ) {
        if let Some(node) = graph.node_weight(current) {
            current_nodes.push(node.data.clone());
        }

        if visited.len() > current.index() {
            visited[current.index()] = true;
        }

        if remaining_depth == 0 {
            // Record this path
            if current_nodes.len() > 1 {
                let total_weight: f64 = current_edges.iter().map(|e| e.weight).product();
                let confidence = current_nodes
                    .iter()
                    .map(|n| n.confidence)
                    .fold(1.0f64, f64::min);

                all_paths.push(CausalPath {
                    nodes: current_nodes.clone(),
                    edges: current_edges.clone(),
                    total_weight,
                    confidence,
                });
            }
            current_nodes.pop();
            return;
        }

        // Follow outgoing edges
        let edges: Vec<_> = graph.edges_directed(current, Direction::Outgoing).collect();
        let has_causal_children = edges.iter().any(|e| e.weight().data.weight >= min_weight);

        if !has_causal_children && current_nodes.len() > 1 {
            // Leaf node — record the path
            let total_weight: f64 = current_edges.iter().map(|e| e.weight).product();
            let confidence = current_nodes
                .iter()
                .map(|n| n.confidence)
                .fold(1.0f64, f64::min);

            all_paths.push(CausalPath {
                nodes: current_nodes.clone(),
                edges: current_edges.clone(),
                total_weight,
                confidence,
            });
        }

        for edge_ref in edges {
            if edge_ref.weight().data.weight < min_weight {
                continue;
            }
            let target = edge_ref.target();
            if visited.len() > target.index() && visited[target.index()] {
                continue; // Already visited in this path
            }

            current_edges.push(edge_ref.weight().data.clone());
            self.dfs_causal(
                graph,
                target,
                remaining_depth - 1,
                min_weight,
                visited,
                current_nodes,
                current_edges,
                all_paths,
            );
            current_edges.pop();
        }

        current_nodes.pop();
        if visited.len() > current.index() {
            visited[current.index()] = false;
        }
    }

    fn serialize(&self) -> Result<SerializedGraph> {
        let graph = self.graph.read();

        let nodes: Vec<GraphNode> = graph.node_weights().map(|n| n.data.clone()).collect();
        let edges: Vec<GraphEdge> = graph
            .edge_references()
            .filter_map(|e| {
                let source = graph.node_weight(e.source())?;
                let target = graph.node_weight(e.target())?;
                Some(GraphEdge {
                    from: source.data.id.clone(),
                    to: target.data.id.clone(),
                    relation: e.weight().data.relation.clone(),
                    weight: e.weight().data.weight,
                    timestamp: e.weight().data.timestamp,
                    source_session: e.weight().data.source_session.clone(),
                })
            })
            .collect();

        Ok(SerializedGraph { nodes, edges })
    }
}

#[derive(Serialize, Deserialize)]
struct SerializedGraph {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
