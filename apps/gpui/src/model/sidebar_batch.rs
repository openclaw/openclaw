//! `sessions.patchMany` wire contract and identity-safe partial outcome projection.
use crate::{gateway::sessions_rpc::SessionIdentity, model::sessions::SessionRow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_TARGETS: usize = 100;

pub fn selected_visible_rows<'a>(
    rows: impl Iterator<Item = &'a SessionRow>,
    selected: &BTreeSet<String>,
    visible: &[String],
) -> Vec<SessionRow> {
    let visible: BTreeSet<_> = visible.iter().collect();
    let mut seen = BTreeSet::new();
    rows.filter(|row| {
        selected.contains(&row.key) && visible.contains(&row.key) && seen.insert(row.key.clone())
    })
    .cloned()
    .collect()
}

#[derive(Serialize)]
pub struct PatchMany {
    pub targets: Vec<SessionIdentity>,
    pub patch: Value,
}

impl PatchMany {
    pub fn new(rows: &[SessionRow], selected_agent: Option<&str>, patch: Value) -> Self {
        Self {
            targets: rows
                .iter()
                .map(|row| SessionIdentity::from_row(row, selected_agent))
                .collect(),
            patch,
        }
    }
}

#[derive(Deserialize)]
pub struct PatchManyResult {
    outcomes: Vec<Outcome>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    ok: bool,
    key: String,
    agent_id: Option<String>,
    error: Option<Error>,
}

#[derive(Deserialize)]
struct Error {
    message: String,
}

impl PatchManyResult {
    /// Never let a missing, duplicated, or differently owned receipt acknowledge a row.
    pub fn outcome(&self, target: &SessionIdentity) -> Result<(), String> {
        let mut matches = self
            .outcomes
            .iter()
            .filter(|outcome| outcome.key == target.key && outcome.agent_id == target.agent_id);
        let outcome = matches.next().ok_or_else(|| {
            "Gateway omitted this session's outcome; refresh to reconcile.".to_owned()
        })?;
        if matches.next().is_some() {
            return Err(
                "Gateway returned duplicate session outcomes; refresh to reconcile.".into(),
            );
        }
        if outcome.ok {
            Ok(())
        } else {
            Err(outcome
                .error
                .as_ref()
                .map(|error| error.message.clone())
                .unwrap_or_else(|| "Gateway rejected the session update.".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn batch_actions_include_only_the_visible_part_of_a_selection() {
        let rows: Vec<SessionRow> = serde_json::from_value(json!([
            {"key":"visible-selected"}, {"key":"collapsed-selected"}, {"key":"visible-unselected"}
        ]))
        .unwrap();
        let selected = BTreeSet::from(["visible-selected".into(), "collapsed-selected".into()]);
        let visible = vec!["visible-selected".into(), "visible-unselected".into()];
        let targets = selected_visible_rows(rows.iter(), &selected, &visible);
        assert_eq!(
            targets
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            ["visible-selected"]
        );
        assert!(selected_visible_rows(rows.iter(), &selected, &[]).is_empty());
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn batch_partial_receipts_cannot_acknowledge_another_agent_or_missing_target() {
        let rows: Vec<SessionRow> = serde_json::from_value(json!([
            {"key":"global", "agentId":"alpha", "sessionId":"first"},
            {"key":"global", "agentId":"beta", "sessionId":"second"},
            {"key":"missing", "agentId":"alpha", "sessionId":"third"}
        ]))
        .unwrap();
        let request = PatchMany::new(&rows, Some("wrong-selected-agent"), json!({"unread":true}));
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(
            wire["targets"][0],
            json!({"key":"global","agentId":"alpha","expectedSessionId":"first"})
        );
        let result: PatchManyResult = serde_json::from_value(json!({"outcomes":[
            {"ok":false,"key":"global","agentId":"beta","error":{"code":"INVALID_REQUEST","message":"Session was replaced"}},
            {"ok":true,"key":"global","agentId":"alpha"}
        ]})).unwrap();
        assert!(result.outcome(&request.targets[0]).is_ok());
        assert_eq!(
            result.outcome(&request.targets[1]).unwrap_err(),
            "Session was replaced"
        );
        assert!(
            result
                .outcome(&request.targets[2])
                .unwrap_err()
                .contains("omitted")
        );
        let duplicated: PatchManyResult = serde_json::from_value(json!({"outcomes":[
            {"ok":true,"key":"global","agentId":"alpha"},
            {"ok":true,"key":"global","agentId":"alpha"}
        ]}))
        .unwrap();
        assert!(
            duplicated
                .outcome(&request.targets[0])
                .unwrap_err()
                .contains("duplicate")
        );
    }
}
