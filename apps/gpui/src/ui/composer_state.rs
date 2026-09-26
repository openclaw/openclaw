use super::AppView;
use crate::{
    gateway::composer_rpc::{ChatSend, ModelChoice, ModelSelectionPolicy, ModelsResult},
    model::{
        attachments::Attachment,
        chat::{Message, RequestScope},
        commands::Command,
        composer::{Drafts, Recall},
    },
};
use gpui_kit::{
    component::input::{InputEvent, InputState},
    *,
};
use std::{collections::HashMap, sync::Arc};

pub(super) struct PendingSend {
    pub gateway: String,
    pub scope: RequestScope,
    pub request: ChatSend,
    pub optimistic: Message,
    pub in_flight: bool,
}

#[derive(Default)]
pub(super) struct CatalogEntry {
    pub commands: Option<Vec<Command>>,
    pub models: Option<ModelsResult>,
}

pub(super) struct ComposerUi {
    pub drafts: Drafts,
    pub restore_pending: bool,
    pub attachments: Vec<Attachment>,
    pub previews: HashMap<String, Arc<Image>>,
    pub recall: Recall,
    pub commands: Vec<Command>,
    pub models: Vec<ModelChoice>,
    pub model_selection_policy: Option<ModelSelectionPolicy>,
    pub model_search: Entity<InputState>,
    pub model_open: bool,
    pub effort_open: bool,
    pub usage_open: bool,
    pub slash_dismissed: bool,
    pub slash_index: usize,
    pub error: Option<String>,
    pub catalog_generation: u64,
    pub attachment_generation: u64,
    pub reading: usize,
    pub catalogs_loading: bool,
    pub pending: HashMap<String, PendingSend>,
    pub suppress_enter: bool,
    pub catalog_cache: HashMap<(u64, Option<String>, String), CatalogEntry>,
    _search_subscription: Subscription,
}

impl ComposerUi {
    pub fn new(window: &mut Window, cx: &mut Context<AppView>) -> Self {
        let model_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search models…"));
        let subscription = cx.subscribe(&model_search, |_, _, _: &InputEvent, cx| cx.notify());
        Self {
            drafts: Drafts::default(),
            restore_pending: false,
            attachments: Vec::new(),
            previews: HashMap::new(),
            recall: Recall::default(),
            commands: Vec::new(),
            models: Vec::new(),
            model_selection_policy: None,
            model_search,
            model_open: false,
            effort_open: false,
            usage_open: false,
            slash_dismissed: false,
            slash_index: 0,
            error: None,
            catalog_generation: 0,
            attachment_generation: 0,
            reading: 0,
            catalogs_loading: false,
            pending: HashMap::new(),
            suppress_enter: false,
            catalog_cache: HashMap::new(),
            _search_subscription: subscription,
        }
    }

    pub fn set_attachments(&mut self, attachments: Vec<Attachment>) {
        self.attachments = attachments;
        self.previews.retain(|id, _| {
            self.attachments
                .iter()
                .any(|attachment| &attachment.id == id)
        });
        for attachment in &self.attachments {
            if !self.previews.contains_key(&attachment.id)
                && let Some(format) = ImageFormat::from_mime_type(&attachment.mime_type)
            {
                self.previews.insert(
                    attachment.id.clone(),
                    Arc::new(Image::from_bytes(format, attachment.bytes.to_vec())),
                );
            }
        }
    }

    pub fn close_popups(&mut self) {
        self.model_open = false;
        self.effort_open = false;
        self.usage_open = false;
        self.slash_dismissed = true;
    }
}
