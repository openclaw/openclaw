use crate::model::{
    approvals::{Approval, ApprovalDecision, ApprovalReplay},
    questions::{QuestionAnswers, QuestionRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSubscription<'a> {
    pub key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_approvals: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubscriptionResult {
    pub subscribed: bool,
    pub approval_replay: Option<ApprovalReplay>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct QuestionList {
    pub questions: Vec<QuestionRecord>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct QuestionResolutionResult {
    pub status: String,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum QuestionResolution<'a> {
    Answers {
        id: &'a str,
        answers: QuestionAnswers,
    },
    Cancel {
        id: &'a str,
        cancel: bool,
    },
}

#[derive(Serialize)]
struct ApprovalResolution<'a> {
    id: &'a str,
    decision: ApprovalDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
}

pub fn resolve_approval(
    approval: &Approval,
    decision: ApprovalDecision,
) -> Option<(&'static str, Value)> {
    if !approval.presentation.allowed_decisions.contains(&decision) {
        return None;
    }
    Some((
        approval.method()?,
        serde_json::to_value(ApprovalResolution {
            id: &approval.id,
            decision,
            kind: (approval.presentation.kind == "system-agent").then_some("system-agent"),
        })
        .expect("approval fields serialize"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    #[test]
    fn question_resolution_has_gateway_required_double_answers_envelope() {
        let params = QuestionResolution::Answers {
            id: "request",
            answers: QuestionAnswers {
                answers: BTreeMap::from([("choice".into(), vec!["A".into()])]),
            },
        };
        assert_eq!(
            serde_json::to_value(params).unwrap(),
            json!({"id":"request","answers":{"answers":{"choice":["A"]}}})
        );
        assert_eq!(
            serde_json::to_value(QuestionResolution::Cancel {
                id: "request",
                cancel: true
            })
            .unwrap(),
            json!({"id":"request","cancel":true})
        );
    }
}
