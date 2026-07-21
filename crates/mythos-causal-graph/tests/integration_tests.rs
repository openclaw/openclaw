use mythos_causal_graph::{CausalGraph, GraphNode, GraphEdge};

#[test]
fn test_graph_creation() {
    let graph = CausalGraph::new();
    assert!(graph.is_ok());
}

#[test]
fn test_add_single_node() {
    let graph = CausalGraph::new().unwrap();

    let node = GraphNode {
        id: "node1".to_string(),
        node_type: "concept".to_string(),
        content: "Test concept".to_string(),
        timestamp: 1234567890,
        confidence: 0.9,
        metadata: None,
    };

    let result = graph.add_node(node);
    assert!(result.is_ok());

    assert!(graph.contains("node1".to_string()));
}

#[test]
fn test_add_multiple_nodes() {
    let graph = CausalGraph::new().unwrap();

    let nodes = vec![
        GraphNode {
            id: "n1".to_string(),
            node_type: "fact".to_string(),
            content: "Fact 1".to_string(),
            timestamp: 1000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "n2".to_string(),
            node_type: "fact".to_string(),
            content: "Fact 2".to_string(),
            timestamp: 2000,
            confidence: 0.9,
            metadata: None,
        },
        GraphNode {
            id: "n3".to_string(),
            node_type: "concept".to_string(),
            content: "Concept 3".to_string(),
            timestamp: 3000,
            confidence: 0.7,
            metadata: None,
        },
    ];

    let result = graph.add_nodes(nodes);
    assert!(result.is_ok());

    assert_eq!(graph.node_count(), 3);
}

#[test]
fn test_add_edge() {
    let graph = CausalGraph::new().unwrap();

    // Add nodes first
    graph.add_node(GraphNode {
        id: "n1".to_string(),
        node_type: "fact".to_string(),
        content: "Fact 1".to_string(),
        timestamp: 1000,
        confidence: 0.8,
        metadata: None,
    }).unwrap();

    graph.add_node(GraphNode {
        id: "n2".to_string(),
        node_type: "fact".to_string(),
        content: "Fact 2".to_string(),
        timestamp: 2000,
        confidence: 0.9,
        metadata: None,
    }).unwrap();

    // Add edge
    let edge = GraphEdge {
        from: "n1".to_string(),
        to: "n2".to_string(),
        relation: "causes".to_string(),
        weight: 0.95,
        timestamp: 1500,
        source_session: Some("session1".to_string()),
    };

    let result = graph.add_edge(edge);
    assert!(result.is_ok());

    assert_eq!(graph.edge_count(), 1);
}

#[test]
fn test_find_causal_chains() {
    let graph = CausalGraph::new().unwrap();

    // Create a causal chain: A -> B -> C
    graph.add_node(GraphNode {
        id: "A".to_string(),
        node_type: "event".to_string(),
        content: "Event A".to_string(),
        timestamp: 1000,
        confidence: 0.9,
        metadata: None,
    }).unwrap();

    graph.add_node(GraphNode {
        id: "B".to_string(),
        node_type: "event".to_string(),
        content: "Event B".to_string(),
        timestamp: 2000,
        confidence: 0.85,
        metadata: None,
    }).unwrap();

    graph.add_node(GraphNode {
        id: "C".to_string(),
        node_type: "event".to_string(),
        content: "Event C".to_string(),
        timestamp: 3000,
        confidence: 0.8,
        metadata: None,
    }).unwrap();

    graph.add_edge(GraphEdge {
        from: "A".to_string(),
        to: "B".to_string(),
        relation: "causes".to_string(),
        weight: 0.9,
        timestamp: 1500,
        source_session: None,
    }).unwrap();

    graph.add_edge(GraphEdge {
        from: "B".to_string(),
        to: "C".to_string(),
        relation: "causes".to_string(),
        weight: 0.85,
        timestamp: 2500,
        source_session: None,
    }).unwrap();

    // Find causal chains from A
    let chains = graph.find_causal_chains("A".to_string(), 10);
    assert!(chains.is_ok());

    let chains = chains.unwrap();
    assert_eq!(chains.len(), 1);
    assert_eq!(chains[0].nodes.len(), 3);
    assert_eq!(chains[0].nodes[0].id, "A");
    assert_eq!(chains[0].nodes[1].id, "B");
    assert_eq!(chains[0].nodes[2].id, "C");
}

#[test]
fn test_find_causal_chains_with_branches() {
    let graph = CausalGraph::new().unwrap();

    // Create a branching causal structure:
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D

    graph.add_nodes(vec![
        GraphNode {
            id: "A".to_string(),
            node_type: "event".to_string(),
            content: "Event A".to_string(),
            timestamp: 1000,
            confidence: 0.9,
            metadata: None,
        },
        GraphNode {
            id: "B".to_string(),
            node_type: "event".to_string(),
            content: "Event B".to_string(),
            timestamp: 2000,
            confidence: 0.85,
            metadata: None,
        },
        GraphNode {
            id: "C".to_string(),
            node_type: "event".to_string(),
            content: "Event C".to_string(),
            timestamp: 2000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "D".to_string(),
            node_type: "event".to_string(),
            content: "Event D".to_string(),
            timestamp: 3000,
            confidence: 0.75,
            metadata: None,
        },
    ]).unwrap();

    graph.add_edges(vec![
        GraphEdge {
            from: "A".to_string(),
            to: "B".to_string(),
            relation: "causes".to_string(),
            weight: 0.9,
            timestamp: 1500,
            source_session: None,
        },
        GraphEdge {
            from: "A".to_string(),
            to: "C".to_string(),
            relation: "causes".to_string(),
            weight: 0.85,
            timestamp: 1500,
            source_session: None,
        },
        GraphEdge {
            from: "B".to_string(),
            to: "D".to_string(),
            relation: "causes".to_string(),
            weight: 0.8,
            timestamp: 2500,
            source_session: None,
        },
        GraphEdge {
            from: "C".to_string(),
            to: "D".to_string(),
            relation: "causes".to_string(),
            weight: 0.75,
            timestamp: 2500,
            source_session: None,
        },
    ]).unwrap();

    let chains = graph.find_causal_chains("A".to_string(), 10).unwrap();

    // Should find 2 chains: A->B->D and A->C->D
    assert_eq!(chains.len(), 2);
}

#[tokio::test]
async fn test_temporal_query() {
    let graph = CausalGraph::new().unwrap();

    // Add nodes with different timestamps
    let nodes = vec![
        GraphNode {
            id: "n1".to_string(),
            node_type: "fact".to_string(),
            content: "Old fact".to_string(),
            timestamp: 1000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "n2".to_string(),
            node_type: "fact".to_string(),
            content: "Middle fact".to_string(),
            timestamp: 2000,
            confidence: 0.9,
            metadata: None,
        },
        GraphNode {
            id: "n3".to_string(),
            node_type: "fact".to_string(),
            content: "Recent fact".to_string(),
            timestamp: 3000,
            confidence: 0.85,
            metadata: None,
        },
    ];

    graph.add_nodes(nodes).unwrap();

    // Query for nodes between timestamps 1500 and 2500
    let results = graph.temporal_query(1500, 2500).await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "n2");
}

#[tokio::test]
async fn test_temporal_query_with_type_filter() {
    let graph = CausalGraph::new().unwrap();

    let nodes = vec![
        GraphNode {
            id: "n1".to_string(),
            node_type: "fact".to_string(),
            content: "Fact".to_string(),
            timestamp: 1000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "n2".to_string(),
            node_type: "concept".to_string(),
            content: "Concept".to_string(),
            timestamp: 1500,
            confidence: 0.9,
            metadata: None,
        },
    ];

    graph.add_nodes(nodes).unwrap();

    // Query for concepts only
    let results = graph.temporal_query_with_type(0, 2000, Some("concept".to_string())).await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].node_type, "concept");
}

#[test]
fn test_node_confidence_update() {
    let graph = CausalGraph::new().unwrap();

    let node = GraphNode {
        id: "n1".to_string(),
        node_type: "fact".to_string(),
        content: "Fact".to_string(),
        timestamp: 1000,
        confidence: 0.8,
        metadata: None,
    };

    graph.add_node(node).unwrap();

    // Update confidence
    let result = graph.update_confidence("n1".to_string(), 0.95);
    assert!(result.is_ok());

    let updated = graph.get_node("n1".to_string()).unwrap();
    assert_eq!(updated.confidence, 0.95);
}

#[test]
fn test_remove_node() {
    let graph = CausalGraph::new().unwrap();

    graph.add_node(GraphNode {
        id: "n1".to_string(),
        node_type: "fact".to_string(),
        content: "Fact".to_string(),
        timestamp: 1000,
        confidence: 0.8,
        metadata: None,
    }).unwrap();

    assert!(graph.contains("n1".to_string()));

    graph.remove_node("n1".to_string()).unwrap();

    assert!(!graph.contains("n1".to_string()));
    assert_eq!(graph.node_count(), 0);
}

#[test]
fn test_remove_node_with_edges() {
    let graph = CausalGraph::new().unwrap();

    graph.add_nodes(vec![
        GraphNode {
            id: "n1".to_string(),
            node_type: "fact".to_string(),
            content: "Fact 1".to_string(),
            timestamp: 1000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "n2".to_string(),
            node_type: "fact".to_string(),
            content: "Fact 2".to_string(),
            timestamp: 2000,
            confidence: 0.9,
            metadata: None,
        },
    ]).unwrap();

    graph.add_edge(GraphEdge {
        from: "n1".to_string(),
        to: "n2".to_string(),
        relation: "causes".to_string(),
        weight: 0.9,
        timestamp: 1500,
        source_session: None,
    }).unwrap();

    assert_eq!(graph.edge_count(), 1);

    // Remove node should also remove associated edges
    graph.remove_node("n1".to_string()).unwrap();

    assert_eq!(graph.node_count(), 1);
    assert_eq!(graph.edge_count(), 0);
}

#[test]
fn test_get_node() {
    let graph = CausalGraph::new().unwrap();

    let node = GraphNode {
        id: "n1".to_string(),
        node_type: "fact".to_string(),
        content: "Test fact".to_string(),
        timestamp: 1000,
        confidence: 0.85,
        metadata: Some(r#"{"source": "test"}"#.to_string()),
    };

    graph.add_node(node.clone()).unwrap();

    let retrieved = graph.get_node("n1".to_string()).unwrap();
    assert_eq!(retrieved.id, "n1");
    assert_eq!(retrieved.content, "Test fact");
    assert_eq!(retrieved.confidence, 0.85);
}

#[test]
fn test_get_nonexistent_node() {
    let graph = CausalGraph::new().unwrap();

    let result = graph.get_node("nonexistent".to_string());
    assert!(result.is_err());
}

#[test]
fn test_graph_statistics() {
    let graph = CausalGraph::new().unwrap();

    graph.add_nodes(vec![
        GraphNode {
            id: "n1".to_string(),
            node_type: "fact".to_string(),
            content: "Fact".to_string(),
            timestamp: 1000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "n2".to_string(),
            node_type: "concept".to_string(),
            content: "Concept".to_string(),
            timestamp: 2000,
            confidence: 0.9,
            metadata: None,
        },
    ]).unwrap();

    graph.add_edges(vec![
        GraphEdge {
            from: "n1".to_string(),
            to: "n2".to_string(),
            relation: "related_to".to_string(),
            weight: 0.85,
            timestamp: 1500,
            source_session: None,
        },
    ]).unwrap();

    let stats = graph.get_statistics();

    assert_eq!(stats.node_count, 2);
    assert_eq!(stats.edge_count, 1);
    assert_eq!(stats.average_confidence, 0.85);
}

#[test]
fn test_persistence() {
    use tempfile::tempdir;

    let dir = tempdir().unwrap();
    let path = dir.path().join("test_graph.json");

    // Create and populate graph
    let graph = CausalGraph::new().unwrap();

    graph.add_node(GraphNode {
        id: "n1".to_string(),
        node_type: "fact".to_string(),
        content: "Test fact".to_string(),
        timestamp: 1000,
        confidence: 0.8,
        metadata: None,
    }).unwrap();

    graph.add_node(GraphNode {
        id: "n2".to_string(),
        node_type: "concept".to_string(),
        content: "Test concept".to_string(),
        timestamp: 2000,
        confidence: 0.9,
        metadata: None,
    }).unwrap();

    graph.add_edge(GraphEdge {
        from: "n1".to_string(),
        to: "n2".to_string(),
        relation: "related_to".to_string(),
        weight: 0.85,
        timestamp: 1500,
        source_session: None,
    }).unwrap();

    // Save
    let save_result = graph.save(path.to_str().unwrap());
    assert!(save_result.is_ok());

    // Load
    let loaded = CausalGraph::load(path.to_str().unwrap()).unwrap();

    assert_eq!(loaded.node_count(), 2);
    assert_eq!(loaded.edge_count(), 1);
    assert!(loaded.contains("n1".to_string()));
    assert!(loaded.contains("n2".to_string()));
}

#[test]
fn test_different_node_types() {
    let graph = CausalGraph::new().unwrap();

    let node_types = vec!["fact", "concept", "event", "entity", "skill", "memory"];

    for (i, node_type) in node_types.iter().enumerate() {
        graph.add_node(GraphNode {
            id: format!("n{}", i),
            node_type: node_type.to_string(),
            content: format!("Test {}", node_type),
            timestamp: (i as u64) * 1000,
            confidence: 0.8,
            metadata: None,
        }).unwrap();
    }

    assert_eq!(graph.node_count(), 6);
}

#[test]
fn test_different_relation_types() {
    let graph = CausalGraph::new().unwrap();

    graph.add_nodes(vec![
        GraphNode {
            id: "n1".to_string(),
            node_type: "fact".to_string(),
            content: "Fact 1".to_string(),
            timestamp: 1000,
            confidence: 0.8,
            metadata: None,
        },
        GraphNode {
            id: "n2".to_string(),
            node_type: "fact".to_string(),
            content: "Fact 2".to_string(),
            timestamp: 2000,
            confidence: 0.9,
            metadata: None,
        },
    ]).unwrap();

    let relations = vec!["causes", "correlates_with", "implies", "contradicts", "supports"];

    for (i, relation) in relations.iter().enumerate() {
        graph.add_edge(GraphEdge {
            from: "n1".to_string(),
            to: "n2".to_string(),
            relation: relation.to_string(),
            weight: 0.8 + (i as f64) * 0.02,
            timestamp: 1500,
            source_session: None,
        }).unwrap();
    }

    assert_eq!(graph.edge_count(), 5);
}
