use mythos_protocol_codec::{ProtocolCodec, Frame};

#[test]
fn test_codec_creation() {
    let codec = ProtocolCodec::new(1024 * 1024); // 1MB max payload
    assert!(codec.is_ok());
}

#[test]
fn test_encode_request_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let frame = Frame::Request {
        id: "req1".to_string(),
        method: "search".to_string(),
        params: Some(r#"{"query": "test"}"#.to_string()),
    };

    let encoded = codec.encode(&frame);
    assert!(encoded.is_ok());

    let bytes = encoded.unwrap();
    assert!(!bytes.is_empty());
}

#[test]
fn test_encode_response_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let frame = Frame::Response {
        id: "req1".to_string(),
        result: Some(r#"{"results": []}"#.to_string()),
        error: None,
    };

    let encoded = codec.encode(&frame);
    assert!(encoded.is_ok());
}

#[test]
fn test_encode_event_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let frame = Frame::Event {
        event: "search.complete".to_string(),
        data: r#"{"duration_ms": 42}"#.to_string(),
    };

    let encoded = codec.encode(&frame);
    assert!(encoded.is_ok());
}

#[test]
fn test_decode_request_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let json = r#"{"type":"req","id":"req1","method":"search","params":{"query":"test"}}"#;
    let bytes = json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_ok());

    let frame = decoded.unwrap();
    match frame {
        Frame::Request { id, method, params } => {
            assert_eq!(id, "req1");
            assert_eq!(method, "search");
            assert!(params.is_some());
        }
        _ => panic!("Expected Request frame"),
    }
}

#[test]
fn test_decode_response_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let json = r#"{"type":"res","id":"req1","result":{"count":10}}"#;
    let bytes = json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_ok());

    let frame = decoded.unwrap();
    match frame {
        Frame::Response { id, result, error } => {
            assert_eq!(id, "req1");
            assert!(result.is_some());
            assert!(error.is_none());
        }
        _ => panic!("Expected Response frame"),
    }
}

#[test]
fn test_decode_event_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let json = r#"{"type":"evt","event":"agent.ready","data":{"agent_id":"agent1"}}"#;
    let bytes = json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_ok());

    let frame = decoded.unwrap();
    match frame {
        Frame::Event { event, data } => {
            assert_eq!(event, "agent.ready");
            assert!(!data.is_empty());
        }
        _ => panic!("Expected Event frame"),
    }
}

#[test]
fn test_roundtrip_encoding() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let original = Frame::Request {
        id: "req123".to_string(),
        method: "memory.search".to_string(),
        params: Some(r#"{"query":"rust","top_k":10}"#.to_string()),
    };

    let encoded = codec.encode(&original).unwrap();
    let decoded = codec.decode(&encoded).unwrap();

    match decoded {
        Frame::Request { id, method, params } => {
            assert_eq!(id, "req123");
            assert_eq!(method, "memory.search");
            assert!(params.is_some());
        }
        _ => panic!("Roundtrip failed: frame type mismatch"),
    }
}

#[test]
fn test_payload_too_large() {
    let codec = ProtocolCodec::new(100); // 100 bytes max

    // Create a payload larger than max
    let large_payload = "x".repeat(200);
    let json = format!(r#"{{"type":"req","id":"req1","method":"test","params":"{}"}}"#, large_payload);
    let bytes = json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_err());

    match decoded {
        Err(e) => {
            assert!(e.to_string().contains("payload too large") || e.to_string().contains("size"));
        }
        _ => panic!("Expected error for oversized payload"),
    }
}

#[test]
fn test_invalid_json() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let invalid_json = r#"{"type":"req","id":"req1","method":"search""#; // Missing closing brace
    let bytes = invalid_json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_err());
}

#[test]
fn test_missing_type_field() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let json = r#"{"id":"req1","method":"search"}"#; // No "type" field
    let bytes = json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_err());
}

#[test]
fn test_unknown_frame_type() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let json = r#"{"type":"unknown","id":"req1"}"#;
    let bytes = json.as_bytes().to_vec();

    let decoded = codec.decode(&bytes);
    assert!(decoded.is_err());
}

#[test]
fn test_empty_payload() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let bytes = vec![];
    let decoded = codec.decode(&bytes);
    assert!(decoded.is_err());
}

#[test]
fn test_error_response_frame() {
    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let frame = Frame::Response {
        id: "req1".to_string(),
        result: None,
        error: Some(r#"{"code":"NOT_FOUND","message":"Resource not found"}"#.to_string()),
    };

    let encoded = codec.encode(&frame).unwrap();
    let decoded = codec.decode(&encoded).unwrap();

    match decoded {
        Frame::Response { id, result, error } => {
            assert_eq!(id, "req1");
            assert!(result.is_none());
            assert!(error.is_some());
        }
        _ => panic!("Expected Response frame with error"),
    }
}

#[test]
fn test_zero_copy_parsing() {
    use mythos_protocol_codec::zero_copy_parse;

    let json = r#"{"type":"req","id":"req1","method":"test"}"#;

    // Zero-copy parsing should work with borrowed data
    let result = zero_copy_parse(json.as_bytes());
    assert!(result.is_ok());

    let frame = result.unwrap();
    match frame {
        Frame::Request { id, method, .. } => {
            assert_eq!(id, "req1");
            assert_eq!(method, "test");
        }
        _ => panic!("Expected Request frame"),
    }
}

#[test]
fn test_codec_performance() {
    use std::time::Instant;

    let codec = ProtocolCodec::new(1024 * 1024).unwrap();

    let json = r#"{"type":"req","id":"req1","method":"search","params":{"query":"test"}}"#;
    let bytes = json.as_bytes().to_vec();

    let iterations = 10000;
    let start = Instant::now();

    for _ in 0..iterations {
        let _ = codec.decode(&bytes).unwrap();
    }

    let elapsed = start.elapsed();
    let per_iteration = elapsed / iterations;

    // Should be able to decode at least 100,000 frames per second
    // (10 microseconds per frame)
    assert!(per_iteration.as_micros() < 10, "Decoding too slow: {:?}", per_iteration);
}
