use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAction {
    Allow,
    Review,
    Block,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    pub action: DecisionAction,
    pub risk_score: u8,
    pub reasons: Vec<String>,
    pub tags: Vec<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRequest {
    pub id: String,
    pub source: String,
    pub session_id: Option<String>,
    pub prompt: Option<String>,
    pub command: Option<String>,
    pub tool_name: Option<String>,
    pub url: Option<String>,
    pub file_path: Option<String>,
    pub raw: Value,
}

impl ActionRequest {
    pub fn from_gateway_frame(frame: &Value) -> Option<Self> {
        let root = frame
            .get("payload")
            .or_else(|| frame.get("params"))
            .unwrap_or(frame);

        let prompt = find_first_string(root, &["prompt", "message", "text", "input"]);
        let command = find_first_string(root, &["command", "shell", "bash", "exec"]);
        let tool_name = find_first_string(root, &["tool", "tool_name", "toolName"]);
        let url = find_first_string(root, &["url", "artifact_url", "artifactUrl"]);
        let file_path = find_first_string(root, &["file_path", "filePath", "artifact_path", "artifactPath"]);

        if prompt.is_none() && command.is_none() && url.is_none() && file_path.is_none() {
            return None;
        }

        let id = find_first_string(root, &["id", "request_id", "requestId", "runId", "action_id", "actionId"])
            .unwrap_or_else(|| "unknown".to_owned());
        let session_id = find_first_string(root, &["session_id", "sessionId"]);
        let source = frame
            .get("event")
            .and_then(Value::as_str)
            .or_else(|| frame.get("method").and_then(Value::as_str))
            .unwrap_or("gateway")
            .to_owned();

        Some(Self {
            id,
            source,
            session_id,
            prompt,
            command,
            tool_name,
            url,
            file_path,
            raw: root.clone(),
        })
    }
}

pub fn decision_event_frame(event_name: &str, request: &ActionRequest, decision: &Decision) -> Value {
    let mut payload = Map::new();
    payload.insert("requestId".to_owned(), Value::String(request.id.clone()));
    payload.insert("sessionId".to_owned(), opt_str(&request.session_id));
    payload.insert("source".to_owned(), Value::String(request.source.clone()));
    payload.insert("decision".to_owned(), serde_json::to_value(decision).unwrap_or(Value::Null));

    let mut out = Map::new();
    out.insert("type".to_owned(), Value::String("event".to_owned()));
    out.insert("event".to_owned(), Value::String(event_name.to_owned()));
    out.insert("payload".to_owned(), Value::Object(payload));
    Value::Object(out)
}

fn opt_str(value: &Option<String>) -> Value {
    value
        .as_ref()
        .map(|v| Value::String(v.clone()))
        .unwrap_or(Value::Null)
}

fn find_first_string(root: &Value, keys: &[&str]) -> Option<String> {
    match root {
        Value::Object(map) => {
            if let Some(v) = find_map_string(map, keys) {
                return Some(v);
            }
            map.values().find_map(|child| find_first_string(child, keys))
        }
        Value::Array(items) => items.iter().find_map(|item| find_first_string(item, keys)),
        _ => None,
    }
}

fn find_map_string(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = map.get(*key) {
            match v {
                Value::String(s) => return Some(s.clone()),
                Value::Number(n) => return Some(n.to_string()),
                Value::Bool(b) => return Some(b.to_string()),
                _ => {}
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ActionRequest;

    #[test]
    fn extracts_action_from_nested_payload() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "id": "req-1",
                "sessionId": "s-123",
                "tool": "exec",
                "command": "git status",
                "input": "run a safe command"
            }
        });

        let req = ActionRequest::from_gateway_frame(&frame).expect("request");
        assert_eq!(req.id, "req-1");
        assert_eq!(req.session_id.as_deref(), Some("s-123"));
        assert_eq!(req.command.as_deref(), Some("git status"));
        assert_eq!(req.prompt.as_deref(), Some("run a safe command"));
        assert_eq!(req.tool_name.as_deref(), Some("exec"));
        assert_eq!(req.source, "agent");
    }

    #[test]
    fn ignores_non_action_frame() {
        let frame = json!({
            "type": "event",
            "event": "heartbeat",
            "payload": {"status": "ok"}
        });
        let req = ActionRequest::from_gateway_frame(&frame);
        assert!(req.is_none());
    }
}
