use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Question {
    pub question_id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub is_other: bool,
    pub is_secret: bool,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuestionRecord {
    pub id: String,
    pub questions: Vec<Question>,
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub status: String,
}

impl QuestionRecord {
    pub fn targets(&self, key: &str, agent: Option<&str>) -> bool {
        self.session_key.as_deref() == Some(key)
            && self
                .agent_id
                .as_deref()
                .zip(agent)
                .is_none_or(|(a, b)| a == b)
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct QuestionAnswers {
    pub answers: BTreeMap<String, Vec<String>>,
}

#[derive(Default)]
pub struct Questions {
    pub records: BTreeMap<String, QuestionRecord>,
    revision: u64,
    changed: BTreeMap<String, u64>,
}

impl Questions {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn upsert(&mut self, record: QuestionRecord) {
        if record.id.is_empty() {
            return;
        }
        self.revision += 1;
        self.changed.insert(record.id.clone(), self.revision);
        if record.status == "pending" && !record.questions.is_empty() {
            self.records.insert(record.id.clone(), record);
        } else {
            self.records.remove(&record.id);
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.revision += 1;
        self.changed.insert(id.to_owned(), self.revision);
        self.records.remove(id);
    }

    /// Events received after the list began own those IDs, including removals.
    pub fn replace_snapshot(&mut self, started: u64, records: Vec<QuestionRecord>) {
        let ids: BTreeSet<_> = records.iter().map(|r| r.id.clone()).collect();
        self.records
            .retain(|id, _| ids.contains(id) || self.changed.get(id).is_some_and(|r| *r > started));
        for record in records {
            if self.changed.get(&record.id).is_none_or(|r| *r <= started) {
                self.upsert(record);
            }
        }
    }

    pub fn selected(&self, key: &str, agent: Option<&str>, now: u64) -> Option<&QuestionRecord> {
        self.records
            .values()
            .filter(|q| q.targets(key, agent) && q.expires_at_ms > now)
            .min_by_key(|q| q.created_at_ms)
    }
}

#[derive(Clone, Default)]
pub struct AnswerDraft {
    pub selected: BTreeSet<String>,
    pub other: String,
}

impl AnswerDraft {
    pub fn toggle(&mut self, question: &Question, label: &str) {
        if self.selected.remove(label) {
            return;
        }
        if !question.multi_select {
            self.selected.clear();
        }
        self.selected.insert(label.to_owned());
    }

    pub fn values(&self, question: &Question) -> Vec<String> {
        let mut values: Vec<_> = question
            .options
            .iter()
            .filter(|o| self.selected.contains(&o.label))
            .map(|o| o.label.clone())
            .collect();
        if (question.is_other || question.is_secret || question.options.is_empty())
            && !self.other.trim().is_empty()
        {
            if !question.multi_select {
                values.clear();
            }
            values.push(self.other.clone());
        }
        values
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answer_encoding_preserves_option_order_and_secret_text() {
        let question: Question = serde_json::from_value(json!({"questionId":"choice","options":[{"label":"B"},{"label":"A"}],"multiSelect":true,"isOther":true})).unwrap();
        let mut draft = AnswerDraft::default();
        draft.toggle(&question, "A");
        draft.toggle(&question, "B");
        draft.other = "custom".into();
        assert_eq!(draft.values(&question), ["B", "A", "custom"]);
        let secret = Question {
            is_secret: true,
            ..Question::default()
        };
        draft.other = "  exact secret  ".into();
        assert_eq!(draft.values(&secret), ["  exact secret  "]);
    }

    #[test]
    fn late_question_list_cannot_resurrect_resolved_or_overwrite_new_events() {
        let record = |id: &str| QuestionRecord {
            id: id.into(),
            status: "pending".into(),
            questions: vec![Question::default()],
            ..QuestionRecord::default()
        };
        let mut questions = Questions::default();
        let started = questions.revision();
        questions.remove("resolved");
        questions.upsert(record("new"));
        questions.replace_snapshot(started, vec![record("resolved"), record("listed")]);
        assert_eq!(
            questions
                .records
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["listed", "new"]
        );
    }
}
