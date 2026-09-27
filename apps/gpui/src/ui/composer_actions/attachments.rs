use super::*;

impl AppView {
    pub(in crate::ui) fn attachment_limits(&self) -> Result<AttachmentLimits, String> {
        self.session
            .as_ref()
            .and_then(|session| session.hello().pointer("/policy/attachments"))
            .cloned()
            .ok_or_else(|| "Connect to a Gateway advertising attachment limits first".to_owned())
            .and_then(|value| {
                serde_json::from_value(value)
                    .map_err(|error| format!("Invalid attachment policy: {error}"))
            })
    }

    pub(in crate::ui) fn pick_attachments(&mut self, cx: &mut Context<Self>) {
        let scope = self.chat.scope();
        let draft_generation = self
            .new_session
            .active
            .then_some(self.new_session.generation);
        if scope.is_none() && draft_generation.is_none() {
            return;
        }
        let epoch = self.epoch;
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach files".into()),
        });
        cx.spawn(async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch || !this.composer_attachment_target(&scope, draft_generation)
                {
                    return;
                }
                match result {
                    Ok(Ok(Some(paths))) => this.attach_paths(paths, cx),
                    Ok(Err(error)) => this.composer_state.error = Some(error.to_string()),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(in crate::ui) fn attach_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let limits = match self.attachment_limits() {
            Ok(limits) => limits,
            Err(error) => {
                self.composer_state.error = Some(error);
                cx.notify();
                return;
            }
        };
        let scope = self.chat.scope();
        let draft_generation = self
            .new_session
            .active
            .then_some(self.new_session.generation);
        if scope.is_none() && draft_generation.is_none() {
            return;
        }
        let epoch = self.epoch;
        let generation = self.composer_state.attachment_generation;
        self.composer_state.reading += 1;
        let task = self.runtime.spawn_blocking(move || {
            paths
                .into_iter()
                .map(|path| Attachment::read(&path, limits))
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch
                    || !this.composer_attachment_target(&scope, draft_generation)
                    || this.composer_state.attachment_generation != generation
                {
                    return;
                }
                this.composer_state.reading = this.composer_state.reading.saturating_sub(1);
                match result {
                    Ok(results) => {
                        let mut errors = Vec::new();
                        for attachment in results {
                            match attachment {
                                Ok(attachment) => this.add_attachment(Ok(attachment), cx),
                                Err(error) => errors.push(error),
                            }
                        }
                        if !errors.is_empty() {
                            this.composer_state.error = Some(errors.join("\n"));
                        }
                    }
                    Err(error) => {
                        this.composer_state.error =
                            Some(format!("Could not read attachment: {error}"))
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(in crate::ui) fn composer_paste(
        &mut self,
        item: &ClipboardItem,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.new_session.active && self.new_session.locked() {
            return true;
        }
        let image = item.entries().iter().find_map(|entry| {
            if let ClipboardEntry::Image(image) = entry {
                Some(image)
            } else {
                None
            }
        });
        let text = item
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                ClipboardEntry::String(value) => Some(value.text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let text = large_paste(&text).then_some(text);
        if image.is_none() && text.is_none() {
            return false;
        }
        let limits = match self.attachment_limits() {
            Ok(limits) => limits,
            Err(error) => {
                self.composer_state.error = Some(error);
                cx.notify();
                return true;
            }
        };
        let attachment = if let Some(image) = image {
            Attachment::from_bytes(
                format!("Pasted image.{}", image.format().extension()),
                image.format().mime_type().into(),
                AttachmentOrigin::Paste,
                image.bytes().to_vec(),
                limits,
            )
        } else {
            Attachment::from_bytes(
                "Pasted text.txt".into(),
                "text/plain".into(),
                AttachmentOrigin::Paste,
                text.unwrap_or_default().into_bytes(),
                limits,
            )
        };
        self.add_attachment(attachment, cx);
        true
    }

    fn add_attachment(&mut self, result: Result<Attachment, String>, cx: &mut Context<Self>) {
        match result {
            Ok(attachment) => {
                let mut attachments = std::mem::take(&mut self.composer_state.attachments);
                attachments.push(attachment);
                self.composer_state.set_attachments(attachments);
                self.composer_state.error = None;
                self.composer_save_draft(cx);
            }
            Err(error) => self.composer_state.error = Some(error),
        }
        cx.notify();
    }

    pub(in crate::ui) fn remove_attachment(&mut self, id: &str, cx: &mut Context<Self>) {
        self.composer_state
            .attachments
            .retain(|attachment| attachment.id != id);
        self.composer_state.previews.remove(id);
        self.composer_save_draft(cx);
        cx.notify();
    }
}
