use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::session_key::{parse_session_key, SessionKind};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameKind {
    Req,
    Resp,
    Event,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MethodFamily {
    Connect,
    Agent,
    Session,
    Sessions,
    Node,
    Cron,
    Gateway,
    Message,
    Browser,
    Canvas,
    Pairing,
    Config,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequestFrame {
    pub id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponseFrame {
    pub id: String,
    pub ok: Option<bool>,
    pub result: Value,
    pub error: Option<RpcErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorPayload {
    pub code: Option<i64>,
    pub message: String,
    pub details: Option<Value>,
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
    #[serde(rename = "sessionKind", skip_serializing_if = "Option::is_none")]
    pub session_kind: Option<SessionKind>,
    #[serde(rename = "chatType", skip_serializing_if = "Option::is_none")]
    pub chat_type: Option<String>,
    #[serde(rename = "wasMentioned", skip_serializing_if = "Option::is_none")]
    pub was_mentioned: Option<bool>,
    #[serde(rename = "replyBack", skip_serializing_if = "Option::is_none")]
    pub reply_back: Option<bool>,
    #[serde(rename = "deliveryContext", skip_serializing_if = "Option::is_none")]
    pub delivery_context: Option<DeliveryContext>,
    pub decision: Decision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryContext {
    pub channel: Option<String>,
    pub to: Option<String>,
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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
            session_kind: request
                .session_id
                .as_deref()
                .map(|key| parse_session_key(key).kind),
            chat_type: raw_string(&request.raw, &["chatType", "chat_type"]),
            was_mentioned: raw_bool(&request.raw, &["wasMentioned", "WasMentioned"]),
            reply_back: raw_bool(&request.raw, &["replyBack", "reply_back"]),
            delivery_context: extract_delivery_context(
                &request.raw,
                request.channel.as_deref(),
                request.session_id.as_deref(),
            ),
            decision: decision.clone(),
        },
    };
    serde_json::to_value(frame).unwrap_or(Value::Null)
}

pub fn rpc_success_response_frame(id: &str, result: Value) -> Value {
    json!({
        "type": "resp",
        "id": id,
        "ok": true,
        "result": result
    })
}

pub fn rpc_error_response_frame(
    id: &str,
    code: i64,
    message: &str,
    details: Option<Value>,
) -> Value {
    json!({
        "type": "resp",
        "id": id,
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "details": details
        }
    })
}

fn extract_delivery_context(
    raw: &Value,
    fallback_channel: Option<&str>,
    fallback_session_key: Option<&str>,
) -> Option<DeliveryContext> {
    let channel = raw_string(raw, &["channel", "provider", "platform"])
        .or_else(|| fallback_channel.map(ToOwned::to_owned))
        .or_else(|| fallback_session_key.and_then(|k| parse_session_key(k).channel));
    let to = raw_string(raw, &["to", "recipient", "peer", "target"]);
    let account_id = raw_string(raw, &["accountId", "account_id"]);
    let thread_id = raw_string(raw, &["threadId", "thread_id", "topicId", "topic_id"]);
    let has_any = channel.is_some() || to.is_some() || account_id.is_some() || thread_id.is_some();
    if has_any {
        Some(DeliveryContext {
            channel,
            to,
            account_id,
            thread_id,
        })
    } else {
        None
    }
}

fn raw_string(raw: &Value, keys: &[&str]) -> Option<String> {
    let map = raw.as_object()?;
    keys.iter().find_map(|key| {
        map.get(*key).and_then(Value::as_str).and_then(|v| {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        })
    })
}

fn raw_bool(raw: &Value, keys: &[&str]) -> Option<bool> {
    let map = raw.as_object()?;
    keys.iter()
        .find_map(|key| map.get(*key))
        .and_then(value_as_bool)
}

fn value_as_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(v) => Some(*v),
        Value::Number(v) => v.as_i64().map(|n| n != 0),
        Value::String(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

pub fn parse_frame_text(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str::<Value>(text)
}

pub fn frame_kind(frame: &Value) -> FrameKind {
    match frame.get("type").and_then(Value::as_str) {
        Some("req") => FrameKind::Req,
        Some("resp") => FrameKind::Resp,
        Some("event") => FrameKind::Event,
        Some("error") => FrameKind::Error,
        _ => {
            if frame.get("error").is_some() {
                FrameKind::Error
            } else {
                FrameKind::Unknown
            }
        }
    }
}

pub fn method_name(frame: &Value) -> Option<&str> {
    frame.get("method").and_then(Value::as_str)
}

pub fn classify_method(method: &str) -> MethodFamily {
    let normalized = method.trim().to_ascii_lowercase();
    if normalized == "connect" {
        return MethodFamily::Connect;
    }
    if normalized == "health" || normalized == "status" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("agent.")
        || normalized == "agent"
        || normalized.starts_with("agents.")
        || normalized == "agents"
    {
        return MethodFamily::Agent;
    }
    if normalized.starts_with("sessions.") || normalized == "sessions" {
        return MethodFamily::Sessions;
    }
    if normalized.starts_with("session.") || normalized == "session" {
        return MethodFamily::Session;
    }
    if normalized.starts_with("node.") || normalized == "node" {
        return MethodFamily::Node;
    }
    if normalized.starts_with("cron.") || normalized == "cron" {
        return MethodFamily::Cron;
    }
    if normalized.starts_with("gateway.") || normalized == "gateway" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("usage.") || normalized == "usage" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("models.") || normalized == "models" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("skills.") || normalized == "skills" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("update.") || normalized == "update" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("web.") || normalized == "web" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("wizard.") || normalized == "wizard" {
        return MethodFamily::Gateway;
    }
    if normalized.starts_with("message.") || normalized == "message" {
        return MethodFamily::Message;
    }
    if normalized.starts_with("browser.") || normalized == "browser" {
        return MethodFamily::Browser;
    }
    if normalized.starts_with("canvas.") || normalized == "canvas" {
        return MethodFamily::Canvas;
    }
    if normalized.starts_with("pairing.") || normalized == "pairing" {
        return MethodFamily::Pairing;
    }
    if normalized.starts_with("config.") || normalized == "config" {
        return MethodFamily::Config;
    }
    MethodFamily::Unknown
}

pub fn parse_rpc_request(frame: &Value) -> Option<RpcRequestFrame> {
    if frame_kind(frame) != FrameKind::Req {
        return None;
    }
    let method = method_name(frame)?.to_owned();
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let params = frame.get("params").cloned().unwrap_or(Value::Null);
    Some(RpcRequestFrame { id, method, params })
}

pub fn parse_rpc_response(frame: &Value) -> Option<RpcResponseFrame> {
    if frame_kind(frame) != FrameKind::Resp {
        return None;
    }
    let id = frame
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let ok = frame.get("ok").and_then(Value::as_bool);
    let result = frame.get("result").cloned().unwrap_or(Value::Null);
    let error = parse_rpc_error(frame);
    Some(RpcResponseFrame {
        id,
        ok,
        result,
        error,
    })
}

pub fn parse_rpc_error(frame: &Value) -> Option<RpcErrorPayload> {
    let err_obj = frame.get("error").and_then(Value::as_object)?;
    let message = err_obj
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown error")
        .to_owned();
    let code = err_obj.get("code").and_then(Value::as_i64);
    let details = err_obj.get("details").cloned();
    Some(RpcErrorPayload {
        code,
        message,
        details,
    })
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
    use serde::Deserialize;
    use serde_json::{json, Value};

    use crate::types::{Decision, DecisionAction};

    use super::{
        classify_method, decision_event_frame, frame_kind, frame_root, frame_source, method_name,
        parse_rpc_error, parse_rpc_request, parse_rpc_response, ConnectFrame, FrameKind,
        MethodFamily,
    };

    #[derive(Debug, Clone, Deserialize)]
    struct ProtocolCorpus {
        cases: Vec<ProtocolCase>,
    }

    #[derive(Debug, Clone, Deserialize)]
    struct ProtocolCase {
        name: String,
        frame: Value,
        expect: ProtocolExpectation,
    }

    #[derive(Debug, Clone, Deserialize)]
    struct ProtocolExpectation {
        kind: FrameKind,
        method_family: Option<MethodFamily>,
        request_id: Option<String>,
        method: Option<String>,
        response_has_error: Option<bool>,
    }

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
    fn decision_event_includes_delivery_hints() {
        let request = crate::types::ActionRequest {
            id: "req-2".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("agent:main:discord:group:g1".to_owned()),
            prompt: Some("hi".to_owned()),
            command: None,
            tool_name: Some("message".to_owned()),
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: json!({
                "chatType": "group",
                "wasMentioned": true,
                "replyBack": true,
                "to": "group-123",
                "accountId": "acc-1",
                "threadId": "thread-42"
            }),
        };
        let decision = Decision {
            action: DecisionAction::Allow,
            risk_score: 5,
            reasons: vec![],
            tags: vec![],
            source: "openclaw-agent-rs".to_owned(),
        };

        let frame = decision_event_frame("security.decision", &request, &decision);
        assert_eq!(
            frame.pointer("/payload/chatType").and_then(|v| v.as_str()),
            Some("group")
        );
        assert_eq!(
            frame
                .pointer("/payload/sessionKind")
                .and_then(|v| v.as_str()),
            Some("group")
        );
        assert_eq!(
            frame
                .pointer("/payload/wasMentioned")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            frame
                .pointer("/payload/replyBack")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            frame
                .pointer("/payload/deliveryContext/channel")
                .and_then(|v| v.as_str()),
            Some("discord")
        );
        assert_eq!(
            frame
                .pointer("/payload/deliveryContext/to")
                .and_then(|v| v.as_str()),
            Some("group-123")
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

    #[test]
    fn classifies_method_families() {
        assert_eq!(classify_method("connect"), MethodFamily::Connect);
        assert_eq!(classify_method("health"), MethodFamily::Gateway);
        assert_eq!(classify_method("status"), MethodFamily::Gateway);
        assert_eq!(classify_method("usage.cost"), MethodFamily::Gateway);
        assert_eq!(classify_method("agent.exec"), MethodFamily::Agent);
        assert_eq!(classify_method("agents.list"), MethodFamily::Agent);
        assert_eq!(classify_method("models.list"), MethodFamily::Gateway);
        assert_eq!(classify_method("skills.status"), MethodFamily::Gateway);
        assert_eq!(classify_method("update.run"), MethodFamily::Gateway);
        assert_eq!(classify_method("web.login.start"), MethodFamily::Gateway);
        assert_eq!(classify_method("wizard.start"), MethodFamily::Gateway);
        assert_eq!(classify_method("sessions.patch"), MethodFamily::Sessions);
        assert_eq!(classify_method("node.invoke"), MethodFamily::Node);
        assert_eq!(classify_method("browser.open"), MethodFamily::Browser);
        assert_eq!(classify_method("unknown.method"), MethodFamily::Unknown);
    }

    #[test]
    fn parses_rpc_request_response_and_error() {
        let req = json!({
            "type": "req",
            "id": "r-1",
            "method": "agent.exec",
            "params": {"command": "git status"}
        });
        let req_meta = parse_rpc_request(&req).expect("req");
        assert_eq!(req_meta.id, "r-1");
        assert_eq!(req_meta.method, "agent.exec");

        let resp_ok = json!({
            "type": "resp",
            "id": "r-1",
            "ok": true,
            "result": {"status": "ok"}
        });
        let ok_meta = parse_rpc_response(&resp_ok).expect("resp");
        assert_eq!(ok_meta.id, "r-1");
        assert_eq!(ok_meta.ok, Some(true));
        assert!(ok_meta.error.is_none());

        let resp_err = json!({
            "type": "resp",
            "id": "r-2",
            "ok": false,
            "error": {"code": 403, "message": "denied", "details": {"policy":"tool_deny"}}
        });
        let err_meta = parse_rpc_response(&resp_err).expect("resp");
        assert_eq!(err_meta.ok, Some(false));
        let err = err_meta.error.expect("error");
        assert_eq!(err.code, Some(403));
        assert_eq!(err.message, "denied");
        assert!(parse_rpc_error(&resp_err).is_some());
    }

    #[test]
    fn protocol_corpus_snapshot_matches_expectations() {
        let corpus: ProtocolCorpus =
            serde_json::from_str(include_str!("../tests/protocol/frame-corpus.json"))
                .expect("corpus");

        for case in corpus.cases {
            assert_eq!(
                frame_kind(&case.frame),
                case.expect.kind,
                "case {} kind mismatch",
                case.name
            );

            if let Some(expected_family) = case.expect.method_family {
                let method = method_name(&case.frame).expect("method");
                assert_eq!(
                    classify_method(method),
                    expected_family,
                    "case {} method family mismatch",
                    case.name
                );
            }

            if let Some(expected_method) = case.expect.method {
                let method = method_name(&case.frame).unwrap_or_default().to_owned();
                assert_eq!(
                    method, expected_method,
                    "case {} method mismatch",
                    case.name
                );
            }

            if let Some(expected_request_id) = case.expect.request_id {
                match frame_kind(&case.frame) {
                    FrameKind::Req => {
                        let req = parse_rpc_request(&case.frame).expect("req");
                        assert_eq!(req.id, expected_request_id, "case {} req id", case.name);
                    }
                    FrameKind::Resp => {
                        let resp = parse_rpc_response(&case.frame).expect("resp");
                        assert_eq!(resp.id, expected_request_id, "case {} resp id", case.name);
                    }
                    _ => {}
                }
            }

            if let Some(expected_has_error) = case.expect.response_has_error {
                let has_error = parse_rpc_response(&case.frame)
                    .map(|r| r.error.is_some())
                    .unwrap_or(false);
                assert_eq!(
                    has_error, expected_has_error,
                    "case {} response error mismatch",
                    case.name
                );
            }
        }
    }
}
