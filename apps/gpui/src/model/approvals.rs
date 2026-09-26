use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowAlways,
    Deny,
}

impl ApprovalDecision {
    pub fn label(self) -> &'static str {
        match self {
            Self::AllowOnce => "Allow once",
            Self::AllowAlways => "Always allow",
            Self::Deny => "Deny",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ApprovalPresentation {
    pub kind: String,
    pub command_text: String,
    pub command_preview: Option<String>,
    pub title: String,
    pub description: String,
    pub detail: Option<String>,
    pub agent_id: Option<String>,
    pub allowed_decisions: Vec<ApprovalDecision>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub status: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub presentation: ApprovalPresentation,
}

impl Approval {
    pub fn title(&self) -> &str {
        if self.presentation.title.is_empty() {
            "Approval required"
        } else {
            &self.presentation.title
        }
    }
    pub fn preview(&self) -> &str {
        self.presentation
            .detail
            .as_deref()
            .or(self.presentation.command_preview.as_deref())
            .unwrap_or(&self.presentation.command_text)
    }
    pub fn method(&self) -> Option<&'static str> {
        match self.presentation.kind.as_str() {
            "exec" => Some("exec.approval.resolve"),
            "plugin" => Some("plugin.approval.resolve"),
            "system-agent" => Some("approval.resolve"),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ApprovalEvent {
    pub session_key: String,
    pub phase: String,
    pub updated_at_ms: u64,
    pub approval: Approval,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ApprovalReplay {
    pub session_key: String,
    pub updated_at_ms: u64,
    pub approvals: Vec<Approval>,
}

#[derive(Default)]
pub struct Approvals {
    pub pending: BTreeMap<String, Approval>,
    revisions: BTreeMap<String, u64>,
    terminal: BTreeSet<String>,
}

impl Approvals {
    pub fn apply(&mut self, event: ApprovalEvent) {
        if event.approval.id.is_empty()
            || self.terminal.contains(&event.approval.id)
            || self
                .revisions
                .get(&event.approval.id)
                .is_some_and(|r| *r > event.updated_at_ms)
        {
            return;
        }
        self.revisions
            .insert(event.approval.id.clone(), event.updated_at_ms);
        if event.phase == "pending" && event.approval.status == "pending" {
            self.pending
                .insert(event.approval.id.clone(), event.approval);
        } else {
            self.pending.remove(&event.approval.id);
            self.terminal.insert(event.approval.id);
        }
    }
    pub fn replay(&mut self, replay: ApprovalReplay) {
        self.pending.retain(|id, _| {
            self.revisions
                .get(id)
                .is_some_and(|r| *r > replay.updated_at_ms)
        });
        for approval in replay.approvals {
            self.apply(ApprovalEvent {
                approval,
                phase: "pending".into(),
                updated_at_ms: replay.updated_at_ms,
                ..ApprovalEvent::default()
            });
        }
    }
    pub fn resolve(&mut self, id: &str, now: u64) {
        self.pending.remove(id);
        self.revisions.insert(id.into(), now);
        self.terminal.insert(id.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_event_wins_over_delayed_subscription_replay() {
        let approval = Approval {
            id: "a".into(),
            status: "pending".into(),
            ..Approval::default()
        };
        let mut approvals = Approvals::default();
        approvals.apply(ApprovalEvent {
            phase: "terminal".into(),
            approval: approval.clone(),
            updated_at_ms: 20,
            ..ApprovalEvent::default()
        });
        approvals.replay(ApprovalReplay {
            approvals: vec![approval],
            updated_at_ms: 20,
            ..ApprovalReplay::default()
        });
        assert!(approvals.pending.is_empty());
    }
}
