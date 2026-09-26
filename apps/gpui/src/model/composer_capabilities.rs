use serde::Deserialize;
use serde_json::{Map, Value};

pub fn has_operator_scope(hello: &Value, requested: &str) -> bool {
    let Some(auth) = hello.get("auth") else {
        return false;
    };
    if auth["role"].as_str().unwrap_or("operator") != "operator" {
        return false;
    }
    auth.get("scopes")
        .and_then(Value::as_array)
        .is_some_and(|scopes| {
            scopes.iter().any(|scope| {
                scope.as_str() == Some(requested)
                    || scope.as_str() == Some("operator.admin")
                    || (requested == "operator.sessions.write"
                        && scope.as_str() == Some("operator.write"))
            })
        })
}

pub fn method_available(hello: &Value, method: &str) -> bool {
    hello
        .pointer("/features/methods")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|value| value.as_str() == Some(method)))
}

pub fn draft_visibility_available(hello: &Value) -> bool {
    hello
        .pointer("/policy/hasMultipleSessionSharingIdentities")
        .and_then(Value::as_bool)
        == Some(true)
        && hello
            .pointer("/policy/allowedSessionVisibilities")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("draft")))
}

pub fn permission_label(mode: Option<&str>, default: Option<&str>) -> String {
    match mode {
        Some("read-only") => "Read Only".into(),
        Some("guarded") => "Guarded".into(),
        Some("workspace") => "Workspace".into(),
        Some("full") => "Full Access".into(),
        _ => default
            .map(|mode| format!("Default ({})", permission_label(Some(mode), None)))
            .unwrap_or_else(|| "Default".into()),
    }
}

pub fn permission_description(mode: Option<&str>) -> &'static str {
    match mode {
        Some("read-only") => {
            "Agent tools can read within the session root, but cannot write or run commands."
        }
        Some("guarded") => "A human reviews requests beyond the session root.",
        Some("workspace") => "An AI reviewer checks requests beyond the session root.",
        Some("full") => "No reviewer; files and commands are unrestricted.",
        _ => "Follow the agent's configured execution permissions.",
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Skill {
    pub skill_key: String,
    pub name: String,
    pub disabled: bool,
    pub blocked_by_allowlist: bool,
    pub blocked_by_agent_filter: bool,
    pub missing: Map<String, Value>,
}

impl Skill {
    pub fn blocked_reason(&self) -> Option<&'static str> {
        if self
            .missing
            .values()
            .any(|value| value.as_array().is_some_and(|v| !v.is_empty()))
        {
            Some("Missing dependencies")
        } else if self.blocked_by_allowlist || self.blocked_by_agent_filter {
            Some("Blocked by agent settings")
        } else {
            None
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct SkillCatalog {
    pub skills: Vec<Skill>,
}

#[derive(Clone)]
pub struct Connector {
    pub name: String,
    pub enabled: bool,
}

pub fn connectors(config: &Value) -> Vec<Connector> {
    let mut rows: Vec<_> = config
        .pointer("/mcp/servers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, server)| Connector {
            name: name.clone(),
            enabled: server.get("enabled").and_then(Value::as_bool) != Some(false),
        })
        .collect();
    rows.sort_by_key(|a| a.name.to_lowercase());
    rows
}

pub fn web_search_base_enabled(config: &Value) -> bool {
    config
        .pointer("/tools/web/search/enabled")
        .and_then(Value::as_bool)
        != Some(false)
}

pub fn enabled(overrides: Option<&Value>, group: &str, name: &str, base: bool) -> bool {
    overrides
        .and_then(|v| v.get(group))
        .and_then(|v| v.get(name))
        .and_then(Value::as_bool)
        .unwrap_or(base)
}

pub fn override_count(overrides: Option<&Value>) -> usize {
    let Some(value) = overrides else {
        return 0;
    };
    ["skills", "mcpServers", "mcpToolsDeny"]
        .into_iter()
        .map(|group| {
            value
                .get(group)
                .and_then(Value::as_object)
                .map_or(0, Map::len)
        })
        .sum::<usize>()
        + usize::from(value.get("webSearch").is_some())
}

pub fn next_boolean(
    current: Option<&Value>,
    group: &str,
    name: &str,
    next: bool,
    base: bool,
) -> Value {
    let mut values = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut group_values = values
        .get(group)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if next == base {
        group_values.remove(name);
    } else {
        group_values.insert(name.into(), next.into());
    }
    if group_values.is_empty() {
        values.remove(group);
    } else {
        values.insert(group.into(), group_values.into());
    }
    values.into()
}

pub fn next_web_search(current: Option<&Value>, next: bool, base: bool) -> Value {
    let mut values = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if base {
        if next {
            values.remove("webSearch");
        } else {
            values.insert("webSearch".into(), false.into());
        }
    } else if values.get("webSearch").and_then(Value::as_bool) == Some(true) {
        values.remove("webSearch");
    }
    values.into()
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EffectiveTool {
    pub source: String,
    pub label: String,
    pub mcp_server: Option<String>,
    pub mcp_tool_name: Option<String>,
    pub denied_by_session: bool,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct ToolGroup {
    pub tools: Vec<EffectiveTool>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct ToolNotice {
    pub id: String,
    pub message: String,
    pub servers: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct EffectiveTools {
    pub groups: Vec<ToolGroup>,
    pub notices: Vec<ToolNotice>,
}

pub fn tool_denied(current: Option<&Value>, tool: &EffectiveTool) -> bool {
    let Some(current) = current else {
        return tool.denied_by_session;
    };
    tool.mcp_server
        .as_ref()
        .zip(tool.mcp_tool_name.as_ref())
        .is_some_and(|(server, name)| {
            current
                .get("mcpToolsDeny")
                .and_then(|v| v.get(server))
                .and_then(Value::as_array)
                .is_some_and(|denied| denied.iter().any(|v| v.as_str() == Some(name)))
        })
}

pub fn next_tool_denied(current: Option<&Value>, server: &str, name: &str, denied: bool) -> Value {
    let mut values = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut groups = values
        .get("mcpToolsDeny")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut names: Vec<String> = groups
        .get(server)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|value| *value != name)
        .map(str::to_owned)
        .collect();
    if denied {
        names.push(name.into());
    }
    names.sort();
    names.dedup();
    if names.is_empty() {
        groups.remove(server);
    } else {
        groups.insert(server.into(), names.into());
    }
    if groups.is_empty() {
        values.remove("mcpToolsDeny");
    } else {
        values.insert("mcpToolsDeny".into(), groups.into());
    }
    values.into()
}

pub fn connector_config(name: &str, transport: &str, target: &str) -> Result<Value, String> {
    if name.is_empty()
        || !name.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(
            "Use a server name containing letters, numbers, periods, underscores, or hyphens."
                .into(),
        );
    }
    if transport != "stdio" {
        let url = url::Url::parse(target).map_err(|_| "Enter an HTTP or HTTPS URL.")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Enter an HTTP or HTTPS URL.".into());
        }
        return Ok(serde_json::json!({"url":target,"transport":transport}));
    }
    if target.starts_with("http://") || target.starts_with("https://") {
        return Err("Enter a command for the stdio transport.".into());
    }
    let mut parts = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = target.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && quote == Some('"') {
            let mut count = 1;
            while chars.peek() == Some(&'\\') {
                chars.next();
                count += 1;
            }
            if chars.peek() == Some(&'"') {
                chars.next();
                token.push_str(&"\\".repeat(count / 2));
                if count % 2 == 0 {
                    quote = None;
                } else {
                    token.push('"');
                }
            } else {
                token.push_str(&"\\".repeat(count));
            }
            started = true;
            continue;
        }
        if c == '\\'
            && quote.is_none()
            && let Some(next) = chars.peek().copied()
            && (next == '"' || next == '\'' || next.is_whitespace())
        {
            token.push(chars.next().unwrap());
            started = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                token.push(c);
            }
            started = true;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            started = true;
            continue;
        }
        if c.is_whitespace() {
            if started {
                parts.push(std::mem::take(&mut token));
                started = false;
            }
        } else {
            token.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return Err("Close the quoted command argument.".into());
    }
    if started {
        parts.push(token);
    }
    if parts.first().is_none_or(String::is_empty) {
        return Err("Enter a command for the stdio transport.".into());
    }
    let command = parts.remove(0);
    Ok(if parts.is_empty() {
        serde_json::json!({"command":command})
    } else {
        serde_json::json!({"command":command,"args":parts})
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skill_status_wire_identity_and_filters_drive_session_overrides() {
        let catalog: SkillCatalog = serde_json::from_value(json!({"skills":[
            {"skillKey":"workspace/release-notes","name":"Release notes","disabled":false,
                "blockedByAllowlist":false,"blockedByAgentFilter":false,"missing":{"bins":[]}},
            {"skillKey":"restricted","name":"Restricted","blockedByAllowlist":true},
            {"skillKey":"other-agent","name":"Other agent","blockedByAgentFilter":true}
        ]}))
        .unwrap();
        let available = &catalog.skills[0];
        assert_eq!(available.blocked_reason(), None);
        let patch = next_boolean(
            None,
            "skills",
            &available.skill_key,
            false,
            !available.disabled,
        );
        assert_eq!(patch, json!({"skills":{"workspace/release-notes":false}}));
        assert!(!enabled(Some(&patch), "skills", &available.skill_key, true));
        assert_eq!(
            next_boolean(Some(&patch), "skills", &available.skill_key, true, true),
            json!({})
        );
        assert_eq!(
            catalog.skills[1].blocked_reason(),
            Some("Blocked by agent settings")
        );
        assert_eq!(
            catalog.skills[2].blocked_reason(),
            Some("Blocked by agent settings")
        );
    }

    #[test]
    fn connector_input_preserves_quoted_arguments_and_rejects_invalid_targets() {
        assert_eq!(
            connector_config(
                "docs",
                "stdio",
                r#"npx server --path "C:\work\docs" 'two words'"#
            )
            .unwrap(),
            json!({"command":"npx","args":["server","--path",r"C:\work\docs","two words"]})
        );
        assert_eq!(
            connector_config("docs", "stdio", r#"server "say \"hi\"" """#).unwrap(),
            json!({"command":"server","args":["say \"hi\"",""]})
        );
        assert!(connector_config("bad/name", "stdio", "server").is_err());
        assert!(connector_config("docs", "stdio", "server \"open").is_err());
        assert!(connector_config("docs", "sse", "file:///private/path").is_err());
        assert_eq!(
            connector_config("docs", "streamable-http", "https://example.com/mcp").unwrap(),
            json!({"url":"https://example.com/mcp","transport":"streamable-http"})
        );
    }

    #[test]
    fn session_overrides_clear_back_to_runtime_defaults_and_preserve_other_capabilities() {
        let initial =
            json!({"skills":{"read/code":false},"mcpServers":{"docs":true},"webSearch":false});
        let next = next_boolean(Some(&initial), "skills", "read/code", true, true);
        assert_eq!(next, json!({"mcpServers":{"docs":true},"webSearch":false}));
        assert_eq!(
            next_web_search(Some(&next), true, true),
            json!({"mcpServers":{"docs":true}})
        );
        assert_eq!(
            next_web_search(Some(&json!({"webSearch":true})), true, false),
            json!({})
        );
        assert_eq!(next_web_search(Some(&initial), true, false), initial);
        let denied = next_tool_denied(Some(&initial), "docs", "write/file", true);
        assert_eq!(denied["mcpToolsDeny"], json!({"docs":["write/file"]}));
        assert_eq!(
            next_tool_denied(Some(&denied), "docs", "write/file", false),
            initial
        );
    }
}
