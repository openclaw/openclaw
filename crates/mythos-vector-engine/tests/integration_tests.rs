use mythos_vector_engine::{VectorIndex, SearchResult};

#[test]
fn test_vector_index_creation() {
    // Test creating a vector index with default parameters
    let index = VectorIndex::new(
        3,                                    // dimensions
        "cosine".to_string(),                 // metric
        1000,                                 // max_elements
        Some(200),                            // ef_construction
        Some(16),                             // m
    );

    assert!(index.is_ok());
    let index = index.unwrap();
    assert_eq!(index.size(), 0);
}

#[test]
fn test_vector_index_add_single() {
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    // Add a single vector
    let result = index.add(
        "vec1".to_string(),
        vec![1.0, 0.0, 0.0],
        "/path/to/file.md".to_string(),
        10,
        15,
    );

    assert!(result.is_ok());
    assert_eq!(index.size(), 1);
    assert!(index.contains("vec1".to_string()));
}

#[test]
fn test_vector_index_add_batch() {
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    // Add multiple vectors in batch
    let ids = vec!["v1".to_string(), "v2".to_string(), "v3".to_string()];
    let vectors = vec![
        vec![1.0, 0.0, 0.0],
        vec![0.0, 1.0, 0.0],
        vec![0.0, 0.0, 1.0],
    ];
    let paths = vec![
        "/file1.md".to_string(),
        "/file2.md".to_string(),
        "/file3.md".to_string(),
    ];
    let start_lines = vec![10, 20, 30];
    let end_lines = vec![15, 25, 35];

    let result = index.add_batch(ids, vectors, paths, start_lines, end_lines);

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), 3);
    assert_eq!(index.size(), 3);
}

#[tokio::test]
async fn test_vector_search_top_k() {
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    // Add vectors
    index.add("v1".to_string(), vec![1.0, 0.0, 0.0], "/f1.md".to_string(), 1, 5).unwrap();
    index.add("v2".to_string(), vec![0.0, 1.0, 0.0], "/f2.md".to_string(), 6, 10).unwrap();
    index.add("v3".to_string(), vec![1.0, 1.0, 0.0], "/f3.md".to_string(), 11, 15).unwrap();

    // Search for vectors similar to [1, 0, 0]
    let results = index.search(vec![1.0, 0.0, 0.0], 2).await.unwrap();

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].id, "v1"); // Exact match should be first
    assert!(results[0].score > 0.9); // High similarity
}

#[tokio::test]
async fn test_vector_search_with_min_score() {
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    index.add("v1".to_string(), vec![1.0, 0.0, 0.0], "/f1.md".to_string(), 1, 5).unwrap();
    index.add("v2".to_string(), vec![0.0, 1.0, 0.0], "/f2.md".to_string(), 6, 10).unwrap();

    // Search with minimum score threshold
    let results = index.search_with_min_score(vec![1.0, 0.0, 0.0], 10, 0.9).await.unwrap();

    assert_eq!(results.len(), 1); // Only v1 should match
    assert_eq!(results[0].id, "v1");
}

#[test]
fn test_vector_contains() {
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    assert!(!index.contains("v1".to_string()));

    index.add("v1".to_string(), vec![1.0, 0.0, 0.0], "/f.md".to_string(), 1, 5).unwrap();

    assert!(index.contains("v1".to_string()));
    assert!(!index.contains("v2".to_string()));
}

#[test]
fn test_vector_remove() {
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    index.add("v1".to_string(), vec![1.0, 0.0, 0.0], "/f.md".to_string(), 1, 5).unwrap();
    index.add("v2".to_string(), vec![0.0, 1.0, 0.0], "/f.md".to_string(), 6, 10).unwrap();

    assert_eq!(index.size(), 2);

    index.remove(vec!["v1".to_string()]).unwrap();

    assert_eq!(index.size(), 1);
    assert!(!index.contains("v1".to_string()));
    assert!(index.contains("v2".to_string()));
}

#[test]
fn test_vector_index_stats() {
    let index = VectorIndex::new(
        1536,
        "cosine".to_string(),
        100_000,
        Some(200),
        Some(16),
    ).unwrap();

    let stats = index.get_stats();

    assert_eq!(stats.dimensions, 1536);
    assert_eq!(stats.metric, "cosine");
    assert_eq!(stats.max_elements, 100_000);
    assert_eq!(stats.ef_construction, 200);
    assert_eq!(stats.m, 16);
    assert_eq!(stats.total_elements, 0);
}

#[test]
fn test_vector_index_persistence() {
    use tempfile::tempdir;

    let dir = tempdir().unwrap();
    let index_path = dir.path().join("test_index.bin");
    let meta_path = dir.path().join("test_index.json");

    // Create and populate index
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();
    index.add("v1".to_string(), vec![1.0, 0.0, 0.0], "/f.md".to_string(), 1, 5).unwrap();
    index.add("v2".to_string(), vec![0.0, 1.0, 0.0], "/f.md".to_string(), 6, 10).unwrap();

    // Save
    let save_result = index.save(index_path.to_str().unwrap(), meta_path.to_str().unwrap());
    assert!(save_result.is_ok());

    // Load
    let loaded = VectorIndex::load(index_path.to_str().unwrap(), meta_path.to_str().unwrap()).unwrap();

    assert_eq!(loaded.size(), 2);
    assert!(loaded.contains("v1".to_string()));
    assert!(loaded.contains("v2".to_string()));
}

#[test]
fn test_different_metrics() {
    // Test cosine
    let cosine_index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None);
    assert!(cosine_index.is_ok());

    // Test euclidean
    let euclidean_index = VectorIndex::new(3, "euclidean".to_string(), 1000, None, None);
    assert!(euclidean_index.is_ok());

    // Test inner_product
    let ip_index = VectorIndex::new(3, "inner_product".to_string(), 1000, None, None);
    assert!(ip_index.is_ok());

    // Test invalid metric
    let invalid_index = VectorIndex::new(3, "invalid_metric".to_string(), 1000, None, None);
    assert!(invalid_index.is_err());
}

#[test]
fn test_invalid_dimensions() {
    // Test mismatched dimensions
    let index = VectorIndex::new(3, "cosine".to_string(), 1000, None, None).unwrap();

    let result = index.add(
        "v1".to_string(),
        vec![1.0, 0.0], // Wrong dimension (2 instead of 3)
        "/f.md".to_string(),
        1,
        5,
    );

    assert!(result.is_err());
}
