use crate::model::questions::AnswerDraft;
use gpui_kit::{Entity, Subscription, Task, component::input::InputState};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
pub(super) struct QuestionDraft {
    pub page: usize,
    pub answers: BTreeMap<String, AnswerDraft>,
    pub inputs: HashMap<String, Entity<InputState>>,
    pub subscriptions: Vec<Subscription>,
}

#[derive(Default)]
pub(super) struct AttentionUi {
    pub drafts: HashMap<String, QuestionDraft>,
    pub busy: BTreeMap<String, u64>,
    pub errors: BTreeMap<String, String>,
    pub request: u64,
    pub ticker: Option<Task<()>>,
}
