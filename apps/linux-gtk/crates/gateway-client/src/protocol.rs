use serde::{Deserialize, Serialize};

// --- Outbound frames ---

#[derive(Debug, Serialize)]
pub struct RequestFrame {
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
}

impl RequestFrame {
    pub fn new(id: String, method: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            frame_type: "req",
            id,
            method: method.into(),
            params,
        }
    }
}

// --- Inbound frames ---

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum InboundFrame {
    #[serde(rename = "res")]
    Response(ResponseFrame),
    #[serde(rename = "event")]
    Event(EventFrame),
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub error: Option<ErrorShape>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ErrorShape {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: serde_json::Value,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, rename = "retryAfterMs")]
    pub retry_after_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventFrame {
    pub event: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub seq: Option<u64>,
}

// --- Connect types ---

#[derive(Debug, Serialize)]
pub struct ConnectParams {
    #[serde(rename = "minProtocol")]
    pub min_protocol: u32,
    #[serde(rename = "maxProtocol")]
    pub max_protocol: u32,
    pub client: ClientInfo,
    pub role: String,
    pub scopes: Vec<String>,
    pub device: DeviceAuth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthToken>,
    pub locale: String,
}

#[derive(Debug, Serialize)]
pub struct ClientInfo {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub version: String,
    pub platform: String,
    pub mode: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceAuth {
    pub id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub signature: String,
    #[serde(rename = "signedAt")]
    pub signed_at: u64,
    pub nonce: String,
}

#[derive(Debug, Serialize)]
pub struct AuthToken {
    pub token: String,
}

// --- Hello OK payload ---

#[derive(Debug, Clone, Deserialize)]
pub struct HelloOk {
    pub protocol: u32,
    #[serde(default)]
    pub server: ServerInfo,
    #[serde(default)]
    pub features: Features,
    #[serde(default)]
    pub snapshot: Snapshot,
    #[serde(default)]
    pub auth: Option<HelloAuth>,
    #[serde(default)]
    pub policy: Option<Policy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ServerInfo {
    #[serde(default)]
    pub version: String,
    #[serde(default, rename = "connId")]
    pub conn_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Features {
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub agents: Vec<serde_json::Value>,
    #[serde(default)]
    pub channels: Vec<serde_json::Value>,
    #[serde(default)]
    pub sessions: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelloAuth {
    #[serde(default, rename = "deviceToken")]
    pub device_token: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Policy {
    #[serde(default, rename = "maxPayload")]
    pub max_payload: usize,
    #[serde(default, rename = "maxBufferedBytes")]
    pub max_buffered_bytes: usize,
    #[serde(default, rename = "tickIntervalMs")]
    pub tick_interval_ms: u64,
}

// --- Chat types ---

#[derive(Debug, Clone, Serialize)]
pub struct ChatSendParams {
    #[serde(rename = "sessionKey")]
    pub session_key: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliver: Option<bool>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatEvent {
    #[serde(default, rename = "runId")]
    pub run_id: String,
    #[serde(default, rename = "sessionKey")]
    pub session_key: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub message: serde_json::Value,
    #[serde(default, rename = "errorMessage")]
    pub error_message: Option<String>,
    #[serde(default)]
    pub usage: Option<serde_json::Value>,
    #[serde(default, rename = "stopReason")]
    pub stop_reason: Option<String>,
}

// --- Challenge ---

#[derive(Debug, Clone, Deserialize)]
pub struct ChallengePayload {
    pub nonce: String,
    pub ts: u64,
}

pub const PROTOCOL_VERSION: u32 = 3;
// TODO: change to "openclaw-linux"/"ui" once src/gateway/protocol/client-info.ts
// adds LINUX_APP to GATEWAY_CLIENT_IDS and the gateway image is rebuilt.
pub const CLIENT_ID: &str = "cli";
pub const CLIENT_MODE: &str = "cli";
pub const CLIENT_ROLE: &str = "operator";
pub const CLIENT_SCOPES: &[&str] = &[
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_frame_serializes_with_type_tag() {
        let f = RequestFrame::new("id-1".into(), "ping", json!({"x": 1}));
        let s = serde_json::to_value(&f).unwrap();
        assert_eq!(s["type"], "req");
        assert_eq!(s["id"], "id-1");
        assert_eq!(s["method"], "ping");
        assert_eq!(s["params"]["x"], 1);
    }

    #[test]
    fn request_frame_wire_format_matches_gateway() {
        let f = RequestFrame::new("abc".into(), "connect", json!({}));
        let wire = serde_json::to_string(&f).unwrap();
        assert!(wire.contains(r#""type":"req""#));
        assert!(wire.contains(r#""id":"abc""#));
        assert!(wire.contains(r#""method":"connect""#));
    }

    #[test]
    fn inbound_frame_parses_response() {
        let raw =
            r#"{"type":"res","id":"r1","ok":true,"payload":{"protocol":3}}"#;
        let frame: InboundFrame = serde_json::from_str(raw).unwrap();
        match frame {
            InboundFrame::Response(r) => {
                assert_eq!(r.id, "r1");
                assert!(r.ok);
                assert_eq!(r.payload["protocol"], 3);
                assert!(r.error.is_none());
            }
            _ => panic!("expected Response"),
        }
    }

    #[test]
    fn inbound_frame_parses_response_error() {
        let raw = r#"{
          "type":"res","id":"r2","ok":false,
          "error":{"code":"E_BAD","message":"boom","retryable":true,"retryAfterMs":1500}
        }"#;
        let frame: InboundFrame = serde_json::from_str(raw).unwrap();
        match frame {
            InboundFrame::Response(r) => {
                assert!(!r.ok);
                let e = r.error.expect("error");
                assert_eq!(e.code, "E_BAD");
                assert_eq!(e.message, "boom");
                assert!(e.retryable);
                assert_eq!(e.retry_after_ms, 1500);
            }
            _ => panic!("expected Response"),
        }
    }

    #[test]
    fn inbound_frame_parses_event() {
        let raw = r#"{"type":"event","event":"chat.delta","payload":{"text":"hi"},"seq":42}"#;
        let frame: InboundFrame = serde_json::from_str(raw).unwrap();
        match frame {
            InboundFrame::Event(e) => {
                assert_eq!(e.event, "chat.delta");
                assert_eq!(e.payload["text"], "hi");
                assert_eq!(e.seq, Some(42));
            }
            _ => panic!("expected Event"),
        }
    }

    #[test]
    fn event_missing_seq_is_none() {
        let raw = r#"{"type":"event","event":"ping"}"#;
        let frame: InboundFrame = serde_json::from_str(raw).unwrap();
        match frame {
            InboundFrame::Event(e) => {
                assert_eq!(e.event, "ping");
                assert!(e.seq.is_none());
            }
            _ => panic!("expected Event"),
        }
    }

    #[test]
    fn unknown_frame_type_fails_to_parse() {
        let raw = r#"{"type":"garbage","id":"x"}"#;
        assert!(serde_json::from_str::<InboundFrame>(raw).is_err());
    }

    #[test]
    fn connect_params_use_camelcase_keys() {
        let p = ConnectParams {
            min_protocol: 3,
            max_protocol: 3,
            client: ClientInfo {
                id: "cli".into(),
                display_name: "Test".into(),
                version: "0.1.0".into(),
                platform: "linux".into(),
                mode: "cli".into(),
                instance_id: "i1".into(),
            },
            role: "operator".into(),
            scopes: vec!["operator.admin".into()],
            device: DeviceAuth {
                id: "d1".into(),
                public_key: "pk".into(),
                signature: "sig".into(),
                signed_at: 1234,
                nonce: "n".into(),
            },
            auth: None,
            locale: "en-US".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["minProtocol"], 3);
        assert_eq!(v["maxProtocol"], 3);
        assert_eq!(v["client"]["displayName"], "Test");
        assert_eq!(v["client"]["instanceId"], "i1");
        assert_eq!(v["device"]["publicKey"], "pk");
        assert_eq!(v["device"]["signedAt"], 1234);
        assert!(v.get("auth").is_none(), "auth should be omitted when None");
    }

    #[test]
    fn hello_ok_parses_with_missing_optional_fields() {
        let raw = r#"{"protocol":3}"#;
        let h: HelloOk = serde_json::from_str(raw).unwrap();
        assert_eq!(h.protocol, 3);
        assert_eq!(h.server.version, "");
        assert!(h.auth.is_none());
    }

    #[test]
    fn hello_ok_parses_server_info() {
        let raw = r#"{
          "protocol":3,
          "server":{"version":"2026.4.3","connId":"c1"},
          "features":{"methods":["ping"],"events":["chat.delta"]},
          "snapshot":{"agents":[],"channels":[],"sessions":[]},
          "policy":{"maxPayload":65536,"maxBufferedBytes":131072,"tickIntervalMs":5000}
        }"#;
        let h: HelloOk = serde_json::from_str(raw).unwrap();
        assert_eq!(h.server.version, "2026.4.3");
        assert_eq!(h.server.conn_id, "c1");
        assert_eq!(h.features.methods, vec!["ping"]);
        let policy = h.policy.expect("policy");
        assert_eq!(policy.max_payload, 65536);
        assert_eq!(policy.tick_interval_ms, 5000);
    }

    #[test]
    fn challenge_payload_parses() {
        let raw = r#"{"nonce":"abc-123","ts":1700000000}"#;
        let c: ChallengePayload = serde_json::from_str(raw).unwrap();
        assert_eq!(c.nonce, "abc-123");
        assert_eq!(c.ts, 1700000000);
    }

    #[test]
    fn chat_send_params_serializes_correctly() {
        let p = ChatSendParams {
            session_key: "default".into(),
            message: "hi".into(),
            thinking: Some("low".into()),
            deliver: Some(true),
            idempotency_key: "idem-1".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["sessionKey"], "default");
        assert_eq!(v["message"], "hi");
        assert_eq!(v["thinking"], "low");
        assert_eq!(v["deliver"], true);
        assert_eq!(v["idempotencyKey"], "idem-1");
    }

    #[test]
    fn chat_send_params_omits_none_optionals() {
        let p = ChatSendParams {
            session_key: "s".into(),
            message: "m".into(),
            thinking: None,
            deliver: None,
            idempotency_key: "k".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("thinking").is_none());
        assert!(v.get("deliver").is_none());
    }

    #[test]
    fn chat_event_parses_partial_payload() {
        let raw = r#"{"runId":"r1","sessionKey":"default","seq":3,"state":"running"}"#;
        let e: ChatEvent = serde_json::from_str(raw).unwrap();
        assert_eq!(e.run_id, "r1");
        assert_eq!(e.session_key, "default");
        assert_eq!(e.seq, 3);
        assert_eq!(e.state, "running");
        assert!(e.error_message.is_none());
    }

    #[test]
    fn protocol_constants_are_stable() {
        assert_eq!(PROTOCOL_VERSION, 3);
        assert_eq!(CLIENT_ROLE, "operator");
        assert!(CLIENT_SCOPES.contains(&"operator.admin"));
    }
}
