use crate::{
    gateway::composer_rpc::{CatalogScope, ChatSend},
    model::{
        attachments::Attachment,
        chat::{Message, RequestScope},
        commands::Command,
        composer::{Drafts, Recall},
    },
};
use gpui_kit::*;
use std::{collections::HashMap, sync::Arc};

pub(super) struct PendingSend {
    pub gateway: String,
    pub scope: RequestScope,
    pub request: ChatSend,
    pub optimistic: Message,
    pub in_flight: bool,
}

#[derive(Default)]
pub(super) struct ComposerUi {
    pub drafts: Drafts,
    pub restore_pending: bool,
    pub attachments: Vec<Attachment>,
    pub reply: Option<crate::model::chat::ReplyTarget>,
    pub previews: HashMap<String, Arc<Image>>,
    pub recall: Recall,
    pub commands: Vec<Command>,
    pub usage_open: bool,
    pub slash_dismissed: bool,
    pub slash_index: usize,
    pub error: Option<String>,
    pub catalog_generation: u64,
    pub attachment_generation: u64,
    pub reading: usize,
    pub pending: HashMap<String, PendingSend>,
    pub suppress_enter: bool,
    pub catalog_cache: HashMap<(u64, CatalogScope), Vec<Command>>,
}

impl ComposerUi {
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
        self.usage_open = false;
        self.slash_dismissed = true;
    }
}
