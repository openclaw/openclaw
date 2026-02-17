use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{ActionRequest, Decision};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectFrame {
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub id: &'static str,
    pub method: &'static str,
    pub params: ConnectParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectParams {
    pub client: &'static str,
    pub role: &'static str,
    pub auth: ConnectAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectAuth {
    pub token: String,
}

impl ConnectFrame {
    pub fn new(token: Option<&str>) -> Self {
        Self {
            frame_type: "req",
            id: "connect-openclaw-agent-rs",
            method: "connect",
            params: ConnectParams {
                client: "openclaw-agent-rs",
                role: "client",
                auth: ConnectAuth {
                    token: token.unwrap_or_default().to_owned(),
                },
            },
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayEventFrame<T> {
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub event: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityDecisionPayload {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    pub decision: Decision,
}

pub fn decision_event_frame(
    event_name: &str,
    request: &ActionRequest,
    decision: &Decision,
) -> Value {
    let frame = GatewayEventFrame {
        frame_type: "event",
        event: event_name.to_owned(),
        payload: SecurityDecisionPayload {
            request_id: request.id.clone(),
            session_id: request.session_id.clone(),
            source: request.source.clone(),
            channel: request.channel.clone(),
            decision: decision.clone(),
        },
    };
    serde_json::to_value(frame).unwrap_or(Value::Null)
}

pub fn parse_frame_text(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str::<Value>(text)
}

pub fn frame_root(frame: &Value) -> &Value {
    frame
        .get("payload")
        .or_else(|| frame.get("params"))
        .unwrap_or(frame)
}

pub fn frame_source(frame: &Value) -> String {
    frame
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| frame.get("method").and_then(Value::as_str))
        .unwrap_or("gateway")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::types::{Decision, DecisionAction};

    use super::{decision_event_frame, frame_root, frame_source, ConnectFrame};

    #[test]
    fn serializes_connect_frame() {
        let frame = ConnectFrame::new(Some("tok-123")).to_value();
        assert_eq!(frame.get("type").and_then(|v| v.as_str()), Some("req"));
        assert_eq!(
            frame.get("method").and_then(|v| v.as_str()),
            Some("connect")
        );
        assert_eq!(
            frame.pointer("/params/auth/token").and_then(|v| v.as_str()),
            Some("tok-123")
        );
    }

    #[test]
    fn builds_decision_event_frame() {
        let request = crate::types::ActionRequest {
            id: "req-1".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("s-1".to_owned()),
            prompt: None,
            command: None,
            tool_name: Some("browser".to_owned()),
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: json!({}),
        };
        let decision = Decision {
            action: DecisionAction::Review,
            risk_score: 40,
            reasons: vec!["test".to_owned()],
            tags: vec!["tool_policy".to_owned()],
            source: "openclaw-agent-rs".to_owned(),
        };

        let frame = decision_event_frame("security.decision", &request, &decision);
        assert_eq!(frame.get("type").and_then(|v| v.as_str()), Some("event"));
        assert_eq!(
            frame.pointer("/payload/requestId").and_then(|v| v.as_str()),
            Some("req-1")
        );
        assert_eq!(
            frame.pointer("/payload/channel").and_then(|v| v.as_str()),
            Some("discord")
        );
    }

    #[test]
    fn frame_helpers_support_payload_and_params() {
        let payload_frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {"id": "p-1"}
        });
        let params_frame = json!({
            "type": "req",
            "method": "agent.exec",
            "params": {"id": "r-1"}
        });

        assert_eq!(
            frame_root(&payload_frame)
                .get("id")
                .and_then(|v| v.as_str()),
            Some("p-1")
        );
        assert_eq!(
            frame_root(&params_frame).get("id").and_then(|v| v.as_str()),
            Some("r-1")
        );
        assert_eq!(frame_source(&payload_frame), "agent");
        assert_eq!(frame_source(&params_frame), "agent.exec");
    }
}
