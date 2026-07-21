use mythos_search_engine::{SearchIndex, IndexDocument, SearchResult, SearchFilters};

#[test]
fn test_search_index_creation() {
    let index = SearchIndex::new("/tmp/test_index", "default");
    assert!(index.is_ok());
}

#[test]
fn test_index_single_document() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let doc = IndexDocument {
        id: "doc1".to_string(),
        path: "/path/to/file.md".to_string(),
        text: "This is a test document about vector search".to_string(),
        start_line: 10,
        end_line: 20,
        metadata: None,
    };

    let result = index.index_batch(vec![doc]);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), 1);
}

#[test]
fn test_index_multiple_documents() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/file1.md".to_string(),
            text: "OpenClaw is an AI agent framework".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
        IndexDocument {
            id: "doc2".to_string(),
            path: "/file2.md".to_string(),
            text: "Mythos-class capabilities with Rust engines".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
        IndexDocument {
            id: "doc3".to_string(),
            path: "/file3.md".to_string(),
            text: "Vector search using HNSW and Tantivy".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
    ];

    let result = index.index_batch(docs);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), 3);
}

#[tokio::test]
async fn test_search_by_query() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/file1.md".to_string(),
            text: "OpenClaw is an AI agent framework".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
        IndexDocument {
            id: "doc2".to_string(),
            path: "/file2.md".to_string(),
            text: "Mythos-class capabilities with Rust engines".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
    ];

    index.index_batch(docs).unwrap();

    // Search for "agent"
    let results = index.search("agent".to_string(), 10).await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "doc1");
    assert!(results[0].score > 0.0);
}

#[tokio::test]
async fn test_search_with_top_k() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/file1.md".to_string(),
            text: "Rust is a systems programming language".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
        IndexDocument {
            id: "doc2".to_string(),
            path: "/file2.md".to_string(),
            text: "Python is an interpreted programming language".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
        IndexDocument {
            id: "doc3".to_string(),
            path: "/file3.md".to_string(),
            text: "Rust provides memory safety without garbage collection".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
    ];

    index.index_batch(docs).unwrap();

    // Search for "Rust" with top 2 results
    let results = index.search("Rust".to_string(), 2).await.unwrap();

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].id, "doc1"); // First match
    assert_eq!(results[1].id, "doc3"); // Second match
}

#[tokio::test]
async fn test_search_with_filters() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/src/file1.rs".to_string(),
            text: "Rust implementation of HNSW".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: Some(r#"{"category": "code"}"#.to_string()),
        },
        IndexDocument {
            id: "doc2".to_string(),
            path: "/docs/file2.md".to_string(),
            text: "Rust documentation and examples".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: Some(r#"{"category": "docs"}"#.to_string()),
        },
    ];

    index.index_batch(docs).unwrap();

    let filters = SearchFilters {
        path_prefix: Some("/src/".to_string()),
        min_score: Some(0.5),
        date_after: None,
    };

    let results = index.search_with_filters("Rust".to_string(), 10, filters).await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "doc1");
    assert!(results[0].path.starts_with("/src/"));
}

#[tokio::test]
async fn test_search_no_results() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/file1.md".to_string(),
            text: "This document talks about Python".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
    ];

    index.index_batch(docs).unwrap();

    // Search for non-existent term
    let results = index.search("xyz123nonexistent".to_string(), 10).await.unwrap();

    assert_eq!(results.len(), 0);
}

#[test]
fn test_different_tokenizers() {
    // Test default tokenizer
    let default_index = SearchIndex::new("/tmp/test_default", "default");
    assert!(default_index.is_ok());

    // Test simple tokenizer
    let simple_index = SearchIndex::new("/tmp/test_simple", "simple");
    assert!(simple_index.is_ok());

    // Test cjk tokenizer
    let cjk_index = SearchIndex::new("/tmp/test_cjk", "cjk");
    assert!(cjk_index.is_ok());

    // Test invalid tokenizer
    let invalid_index = SearchIndex::new("/tmp/test_invalid", "invalid_tokenizer");
    assert!(invalid_index.is_err());
}

#[test]
fn test_index_with_metadata() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let doc = IndexDocument {
        id: "doc1".to_string(),
        path: "/file.md".to_string(),
        text: "Document with metadata".to_string(),
        start_line: 1,
        end_line: 10,
        metadata: Some(r#"{"author": "John", "tags": ["rust", "search"]}"#.to_string()),
    };

    let result = index.index_batch(vec![doc]);
    assert!(result.is_ok());
}

#[test]
fn test_index_stats() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    let stats = index.get_stats();

    assert_eq!(stats.num_documents, 0);
    assert_eq!(stats.num_segments, 0);
    assert!(!stats.indexed);

    // Index some documents
    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/file1.md".to_string(),
            text: "Test document 1".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
    ];

    index.index_batch(docs).unwrap();

    let stats = index.get_stats();
    assert_eq!(stats.num_documents, 1);
    assert!(stats.num_segments > 0);
}

#[test]
fn test_optimize_index() {
    let index = SearchIndex::new("/tmp/test_index", "default").unwrap();

    // Index documents
    let docs: Vec<IndexDocument> = (0..100)
        .map(|i| IndexDocument {
            id: format!("doc{}", i),
            path: format!("/file{}.md", i),
            text: format!("Document number {}", i),
            start_line: 1,
            end_line: 10,
            metadata: None,
        })
        .collect();

    index.index_batch(docs).unwrap();

    // Optimize index
    let result = index.optimize(4);
    assert!(result.is_ok());

    let stats = index.get_stats();
    assert!(stats.num_segments <= 4);
}

#[test]
fn test_persistence() {
    use tempfile::tempdir;

    let dir = tempdir().unwrap();
    let index_path = dir.path().to_str().unwrap();

    // Create and populate index
    let index = SearchIndex::new(index_path, "default").unwrap();

    let docs = vec![
        IndexDocument {
            id: "doc1".to_string(),
            path: "/file1.md".to_string(),
            text: "Test document".to_string(),
            start_line: 1,
            end_line: 10,
            metadata: None,
        },
    ];

    index.index_batch(docs).unwrap();

    // Save
    let save_result = index.save();
    assert!(save_result.is_ok());

    // Load
    let loaded = SearchIndex::load(index_path, "default").unwrap();
    let stats = loaded.get_stats();

    assert_eq!(stats.num_documents, 1);
}
