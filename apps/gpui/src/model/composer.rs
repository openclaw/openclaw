use super::attachments::Attachment;
use std::collections::HashMap;

pub fn context_usage(total: Option<f64>, capacity: Option<f64>) -> Option<(f64, f64, f64)> {
    let total = total.filter(|value| value.is_finite() && *value > 0.)?;
    let capacity = capacity.filter(|value| value.is_finite() && *value > 0.)?;
    Some((total, capacity, (total / capacity).clamp(0., 1.)))
}

#[derive(Clone, Debug, Default)]
pub struct Draft {
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub reply: Option<super::chat::ReplyTarget>,
}

#[derive(Default)]
pub struct Drafts {
    gateway: Option<String>,
    selected: Option<DraftKey>,
    values: HashMap<DraftKey, Draft>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct DraftKey {
    gateway: String,
    session: String,
    agent: Option<String>,
}

impl Drafts {
    pub fn bind_gateway(&mut self, gateway: &str) {
        self.gateway = Some(gateway.to_owned());
        self.selected = None;
    }

    pub fn gateway(&self) -> Option<&str> {
        self.gateway.as_deref()
    }

    pub fn select(&mut self, session: &str, agent: Option<&str>) -> Draft {
        self.selected = self.gateway.as_ref().map(|gateway| DraftKey {
            gateway: gateway.clone(),
            session: session.to_owned(),
            agent: agent.map(str::to_owned),
        });
        self.selected
            .as_ref()
            .and_then(|key| self.values.get(key))
            .cloned()
            .unwrap_or_default()
    }

    pub fn has_draft(&self, session: &str, agent: Option<&str>) -> bool {
        let Some(gateway) = &self.gateway else {
            return false;
        };
        self.values
            .get(&DraftKey {
                gateway: gateway.clone(),
                session: session.to_owned(),
                agent: agent.map(str::to_owned),
            })
            .is_some_and(|draft| {
                !draft.text.trim().is_empty()
                    || !draft.attachments.is_empty()
                    || draft.reply.is_some()
            })
    }

    pub fn save(&mut self, draft: Draft) {
        if let Some(key) = &self.selected {
            self.values.insert(key.clone(), draft);
        }
    }
}

#[derive(Default)]
pub struct Recall {
    entries: Vec<String>,
    index: Option<usize>,
    saved: String,
}

impl Recall {
    pub fn seed(&mut self, messages: impl Iterator<Item = String>) {
        self.entries.clear();
        for message in messages {
            self.record(message);
        }
        self.reset();
    }
    pub fn record(&mut self, message: String) {
        if message.trim().is_empty() {
            return;
        }
        self.entries.retain(|entry| entry != &message);
        self.entries.push(message);
    }
    pub fn reset(&mut self) {
        self.index = None;
        self.saved.clear();
    }
    pub fn active(&self) -> bool {
        self.index.is_some()
    }
    pub fn up(&mut self, draft: &str, caret_at_start: bool) -> Option<String> {
        if self.entries.is_empty() || (!caret_at_start && !self.active()) {
            return None;
        }
        let index = match self.index {
            Some(index) => index.saturating_sub(1),
            None => {
                self.saved = draft.to_owned();
                self.entries.len() - 1
            }
        };
        self.index = Some(index);
        Some(self.entries[index].clone())
    }
    pub fn down(&mut self) -> Option<String> {
        let next = self.index? + 1;
        if next == self.entries.len() {
            self.index = None;
            Some(std::mem::take(&mut self.saved))
        } else {
            self.index = Some(next);
            Some(self.entries[next].clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_usage_is_hidden_instead_of_a_zero_percent_placeholder() {
        for (total, limit) in [
            (None, None),
            (None, Some(200_000.)),
            (Some(0.), Some(200_000.)),
            (Some(42.), None),
        ] {
            assert_eq!(context_usage(total, limit), None);
        }
        assert_eq!(
            context_usage(Some(85_000.), Some(100_000.)),
            Some((85_000., 100_000., 0.85))
        );
    }
    #[test]
    fn recall_deduplicates_recency_obeys_caret_and_restores_unsent_draft() {
        let mut recall = Recall::default();
        recall.seed(["first", "second", "first"].into_iter().map(str::to_owned));
        assert_eq!(recall.up("draft", false), None);
        assert_eq!(recall.up("draft", true).as_deref(), Some("first"));
        assert_eq!(recall.up("first", false).as_deref(), Some("second"));
        assert_eq!(recall.down().as_deref(), Some("first"));
        assert_eq!(recall.down().as_deref(), Some("draft"));
        assert_eq!(recall.down(), None);
    }
    #[test]
    fn reconnect_clearing_cannot_write_old_attachments_under_a_new_gateway_or_agent() {
        use crate::model::attachments::{AttachmentLimits, AttachmentOrigin};
        let mut drafts = Drafts::default();
        drafts.bind_gateway("ws://one");
        drafts.select("main", Some("a"));
        let attachment = Attachment::from_bytes(
            "draft.txt".into(),
            "text/plain".into(),
            AttachmentOrigin::File,
            b"private".to_vec(),
            AttachmentLimits {
                max_bytes: 1024,
                max_image_bytes: 1024,
            },
        )
        .unwrap();
        drafts.save(Draft {
            text: "private draft".into(),
            attachments: vec![attachment.clone()],
            reply: Some(super::super::chat::ReplyTarget {
                id: Some("source-entry".into()),
                text: "Earlier question".into(),
                sender: "Assistant".into(),
            }),
        });
        assert!(drafts.has_draft("main", Some("a")));
        assert!(!drafts.has_draft("main", Some("b")));
        drafts.bind_gateway("ws://two");
        assert!(!drafts.has_draft("main", Some("a")));
        // Clearing the old editor emits Change before the replacement session is ready.
        drafts.save(Draft {
            text: String::new(),
            attachments: vec![attachment.clone()],
            reply: None,
        });
        assert!(drafts.select("main", Some("a")).attachments.is_empty());
        drafts.bind_gateway("ws://one");
        assert!(drafts.select("main", Some("b")).text.is_empty());
        let restored = drafts.select("main", Some("a"));
        assert_eq!(restored.text, "private draft");
        assert_eq!(restored.attachments, vec![attachment]);
        assert_eq!(restored.reply.unwrap().id.as_deref(), Some("source-entry"));
    }
}
