use crate::ui::theme::tokens::{conversation as t, radius, space, weight};
#[path = "transcript_markdown.rs"]
mod image_policy;
use super::{AppView, theme::Palette};
use crate::gateway::chat_rpc::{ForkParams, ForkResult, HistoryParams};
use crate::model::attachments::{Attachment, AttachmentOrigin};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_kit::{
    component::{
        IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::{MarkdownExtensions, MarkdownNode, TextView, TextViewState, TextViewStyle},
    },
    *,
};
use image_policy::unloaded_images;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

pub(super) fn transcript_text_style(p: Palette) -> TextViewStyle {
    TextViewStyle::default()
        .paragraph_gap(t::PARAGRAPH_GAP)
        .heading_font_size(|level, base| {
            // Chat headings inherit the browser's heading scale at a 14px base.
            base * t::heading_scale(level)
        })
        .table(
            StyleRefinement::default()
                .border(space::NONE)
                .rounded(space::NONE)
                .bg(transparent_black())
                .text_size(t::TABLE_TEXT_SIZE),
        )
        .table_head(
            StyleRefinement::default()
                .bg(transparent_black())
                .text_color(p.strong)
                .font_weight(weight::SEMIBOLD)
                .border_color(p.border_strong),
        )
        .table_cell(
            StyleRefinement::default()
                .border_r(space::NONE)
                .px(space::XL)
                .py(space::XL),
        )
}

pub(super) fn code_markdown_extensions() -> MarkdownExtensions {
    // Reuse one parser configuration so cached messages are not reparsed on each frame.
    static EXTENSIONS: OnceLock<MarkdownExtensions> = OnceLock::new();
    EXTENSIONS
        .get_or_init(|| {
            MarkdownExtensions::default()
                .block_parser(|node, _| code_block_node(node))
                .block_renderer("transcript-code", |node, _, cx| {
                    let p = Palette::get(cx);
                    let language = node
                        .data::<Option<String>>()
                        .and_then(Option::as_deref)
                        .unwrap_or("text")
                        .to_lowercase();
                    let code = node.as_text().to_owned();
                    let offset = node.source_range().map_or(0, |range| range.start);
                    div()
                        .id(("transcript-code", offset))
                        .w_full()
                        .min_w(space::NONE)
                        .rounded(radius::CONTROL)
                        .border(space::HAIRLINE)
                        .border_color(Hsla {
                            a: t::CODE_BORDER_ALPHA,
                            ..p.text
                        })
                        .overflow_hidden()
                        .child(
                            div()
                                .h_flex()
                                .justify_between()
                                .gap(space::REM_SM)
                                .min_h(t::CODE_HEADER_HEIGHT)
                                .pl(t::CODE_INSET)
                                .pr(space::MD)
                                .pt(space::MD)
                                .pb(space::XS)
                                .text_size(t::CODE_LABEL_SIZE)
                                .line_height(t::CODE_LABEL_SIZE)
                                .text_color(p.muted)
                                .child(div().font_family(t::CODE_FONT_FAMILY).child(language))
                                .child(
                                    Button::new("copy-code")
                                        .ghost()
                                        .small()
                                        .icon(IconName::Copy)
                                        .tooltip("Copy code")
                                        .on_click(move |_, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                code.clone(),
                                            ));
                                        }),
                                ),
                        )
                        .child(
                            TextView::markdown("code-body", node.as_markdown().to_owned())
                                .style(
                                    TextViewStyle::default().code_block(
                                        StyleRefinement::default()
                                            .bg(transparent_black())
                                            .rounded(space::NONE)
                                            .px(t::CODE_INSET)
                                            .pt(space::XS)
                                            .pb(t::CODE_INSET)
                                            .text_size(t::CODE_TEXT_SIZE)
                                            .line_height(t::CODE_LINE_HEIGHT),
                                    ),
                                )
                                .selectable(true)
                                .scrollable(false),
                        )
                })
        })
        .clone()
}

pub(super) fn fenced_code(language: &str, source: &str) -> String {
    let longest = source
        .split(|ch| ch != '~')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "~".repeat(3.max(longest + 1));
    format!("{fence}{language}\n{source}\n{fence}")
}

fn code_block_node(node: &markdown::mdast::Node) -> Option<MarkdownNode> {
    let markdown::mdast::Node::Code(code) = node else {
        return None;
    };
    // Parsed code excludes quote/list prefixes; keep literal embedded fences intact.
    let source = fenced_code(code.lang.as_deref().unwrap_or_default(), &code.value);
    Some(
        MarkdownNode::new("transcript-code", code.lang.clone())
            .text(code.value.clone())
            .markdown(source),
    )
}

#[cfg(test)]
mod tests {
    use super::{code_block_node, fenced_code};
    use markdown::{ParseOptions, mdast::Node};

    #[test]
    fn tool_output_keeps_embedded_markdown_fences_literal() {
        let output =
            "before\n```\n# not a heading\n![literal](https://example.invalid/image)\n~~~~~\nafter";
        let projected = fenced_code("text", output);
        let parsed = markdown::to_mdast(&projected, &ParseOptions::gfm()).unwrap();
        let blocks = parsed.children().unwrap();
        assert_eq!(blocks.len(), 1);
        let Node::Code(code) = &blocks[0] else {
            panic!("output stays literal code")
        };
        assert_eq!(code.value, output);
    }

    #[test]
    fn code_toolbar_preserves_nested_code_and_literal_fences() {
        fn visit(node: &Node) -> usize {
            if let Node::Code(original) = node {
                let projected = code_block_node(node).expect("code toolbar node");
                let parsed =
                    markdown::to_mdast(projected.as_markdown(), &ParseOptions::gfm()).unwrap();
                let children = parsed.children().unwrap();
                assert_eq!(children.len(), 1, "code stays one literal block");
                let Node::Code(rendered) = &children[0] else {
                    panic!("code must not become ordinary Markdown");
                };
                assert_eq!(rendered.value, original.value);
                assert_eq!(rendered.lang, original.lang);
                assert_eq!(projected.as_text(), original.value);
                return 1;
            }
            node.children().into_iter().flatten().map(visit).sum()
        }
        for source in [
            "> ```rust\n> let answer = 42;\n> ```",
            "- Example:\n\n  ```markdown\n  ~~~\n  ![literal](https://example.invalid/image.png)\n  ~~~\n  ```",
            "    plain indented code\n    with another line",
            "````markdown\n```\n~~~~~~~\n````",
            "```text\nline with a trailing blank line\n\n```",
        ] {
            let parsed = markdown::to_mdast(source, &ParseOptions::gfm()).unwrap();
            assert_eq!(visit(&parsed), 1, "fixture contains one code block");
        }
    }
}

#[derive(Default)]
pub(super) struct TranscriptUi {
    pub markdown: HashMap<String, CachedMarkdown>,
    pub images: HashMap<String, std::sync::Arc<Image>>,
    pub expanded: HashSet<String>,
    pub show_all: HashSet<String>,
    pub error_expanded: bool,
    pub fork_request: u64,
    pub scroll_installed: bool,
    pub owner: Option<crate::model::chat::RequestScope>,
}
pub(super) struct CachedMarkdown {
    pub source: String,
    pub state: Entity<TextViewState>,
}

impl AppView {
    pub(super) fn load_history(&mut self, cx: &mut Context<Self>) {
        self.load_history_page(false, cx);
    }
    pub(super) fn load_earlier(&mut self, cx: &mut Context<Self>) {
        self.load_history_page(true, cx);
    }
    fn load_history_page(&mut self, older: bool, cx: &mut Context<Self>) {
        let Some(request) = (if older {
            self.chat.begin_older()
        } else {
            self.chat.begin_history()
        }) else {
            return;
        };
        let params = HistoryParams {
            session_key: request.scope.session_key.clone(),
            agent_id: request.scope.agent_id.clone(),
            limit: 100,
            offset: request.offset,
        };
        self.request(
            "chat.history",
            serde_json::to_value(params).expect("history parameters"),
            cx,
            move |this, result, cx| {
                let old_count = this.chat.messages.len();
                let old_offset = this.transcript_list.logical_scroll_top();
                let changed = match result {
                    Ok(payload) => this.chat.apply_history(&request, &payload),
                    Err(error) => this.chat.history_failed(&request, error),
                };
                if changed {
                    if this.chat.history_error.is_none() {
                        log::debug!(
                            "history loaded messages={} offset={} has_more={}",
                            this.chat.messages.len(),
                            request.offset.unwrap_or(0),
                            this.chat.has_more
                        );
                    }
                    let added = this.chat.messages.len().saturating_sub(old_count);
                    if older && added > 0 {
                        this.transcript_list.splice(0..0, added);
                        this.transcript_list.scroll_to(ListOffset {
                            item_ix: old_offset.item_ix + added,
                            offset_in_item: old_offset.offset_in_item,
                        });
                    }
                    this.sync_transcript();
                    if !older {
                        this.transcript_list.remeasure();
                    }
                    this.composer_history_loaded(cx);
                    this.reveal_search_target(cx);
                    cx.notify();
                }
            },
        );
    }
    pub(super) fn reveal_search_target(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.sidebar_state.search_target.clone() else {
            return;
        };
        if let Some(index) = self.chat.messages.iter().position(|message| {
            message.id.as_deref() == Some(&target) || message.entry_id.as_deref() == Some(&target)
        }) {
            self.transcript_list.pause_following_tail();
            self.transcript_list.scroll_to_reveal_item(index);
            self.sidebar_state.search_target = None;
            cx.notify();
        } else if self.chat.has_more && !self.chat.loading && !self.chat.loading_older {
            self.load_earlier(cx);
        } else if !self.chat.loading && !self.chat.loading_older {
            self.sidebar_state.search_target = None;
        }
    }
    pub(super) fn sync_transcript(&mut self) {
        if self.transcript_state.owner != self.chat.scope() {
            self.transcript_state.markdown.clear();
            self.transcript_state.images.clear();
            self.transcript_state.expanded.clear();
            self.transcript_state.show_all.clear();
            self.transcript_state.owner = self.chat.scope();
            self.transcript_state.error_expanded = false;
        }
        let count = self.chat.messages.len()
            + usize::from(self.chat.active_run.is_some())
            + usize::from(self.chat.note.is_some());
        let old = self.transcript_list.item_count();
        if count != old {
            self.transcript_list
                .splice(old.min(count)..old, count.saturating_sub(old));
        }
        let changed = self
            .chat
            .dirty_from
            .take()
            .unwrap_or_else(|| old.saturating_sub(1));
        let changed = if self.chat.active_run.is_some() {
            changed.min(self.chat.messages.len())
        } else {
            changed
        };
        self.transcript_list
            .remeasure_items(changed.min(count)..count);
    }
    pub(super) fn install_transcript_scroll(&mut self, cx: &mut Context<Self>) {
        if self.transcript_state.scroll_installed {
            return;
        }
        self.transcript_state.scroll_installed = true;
        let weak = cx.entity().downgrade();
        self.transcript_list
            .set_scroll_handler(move |event, _, cx| {
                let _ = weak.update(cx, |this, cx| {
                    if event.visible_range.start == 0
                        && event.is_scrolled
                        && !event.is_following_tail
                        && this.chat.has_more
                        && !this.chat.loading_older
                    {
                        this.load_earlier(cx);
                    }
                    cx.notify();
                });
            });
    }
    pub(super) fn markdown_state(
        &mut self,
        key: String,
        source: &str,
        cx: &mut Context<Self>,
    ) -> Entity<TextViewState> {
        if let Some(cached) = self.transcript_state.markdown.get_mut(&key) {
            if cached.source != source {
                cached.source = source.to_owned();
                let safe = unloaded_images(source);
                cached
                    .state
                    .update(cx, |state, cx| state.set_text(&safe, cx));
            }
            return cached.state.clone();
        }
        let safe = unloaded_images(source);
        let state = cx.new(|cx| TextViewState::markdown(&safe, cx));
        self.transcript_state.markdown.insert(
            key,
            CachedMarkdown {
                source: source.to_owned(),
                state: state.clone(),
            },
        );
        state
    }
    pub(super) fn fork_message(
        &mut self,
        entry_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(scope), Some(session)) = (self.chat.scope(), self.session.clone()) else {
            return;
        };
        let params = ForkParams {
            session_key: scope.session_key.clone(),
            agent_id: scope.agent_id.clone(),
            entry_id,
        };
        let epoch = self.epoch;
        self.transcript_state.fork_request += 1;
        let generation = self.transcript_state.fork_request;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move {
            let result = session
                .request(
                    "sessions.fork",
                    serde_json::to_value(params).expect("fork parameters"),
                )
                .await
                .map_err(|error| error.to_string())
                .and_then(|value| {
                    serde_json::from_value::<ForkResult>(value).map_err(|error| error.to_string())
                });
            let _ = tx.send(result);
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(result) = rx.await {
                let _ = this.update_in(cx, |this, window, cx| {
                    if this.epoch != epoch || !this.chat.is_current(&scope) || this.transcript_state.fork_request!=generation {
                        return;
                    }
                    match result {
                        Ok(result) if !result.session_key.is_empty() => {
                            this.select_session(result.session_key, window, cx);
                            if let Some(text) = result.editor_text {
                                this.composer
                                    .update(cx, |state, cx| state.set_value(text, window, cx));
                            }
                            if !result.editor_attachments.is_empty(){
                                match this.attachment_limits(){
                                    Ok(mut limits)=>{
                                        // Editor restore follows the Control UI's inline-image admission cap.
                                        limits.max_image_bytes=limits.max_image_bytes.min(5*1024*1024);
                                        let restored:Vec<_>=result.editor_attachments.iter().enumerate().filter_map(|(index,image)|{
                                            if !image.mime_type.starts_with("image/") || image.data.len()>limits.max_image_bytes.min(limits.max_bytes).div_ceil(3)*4{return None;}
                                            let bytes=STANDARD.decode(&image.data).ok()?;
                                            Attachment::from_bytes(format!("Restored image {}",index+1),image.mime_type.clone(),AttachmentOrigin::File,bytes,limits).ok()
                                        }).collect();
                                        if restored.len()!=result.editor_attachments.len(){this.composer_state.error=Some("Some saved images could not be restored because they were invalid or exceeded the attachment limit.".into());}
                                        this.composer_state.set_attachments(restored);
                                    }
                                    Err(error)=>this.composer_state.error=Some(error),
                                }
                            }
                            this.composer_save_draft(cx);
                            this.refresh_sessions(cx);
                        }
                        Ok(_) => {
                            this.chat.note = Some(crate::model::chat::ChatNote {
                                text: "Gateway returned an empty fork key".into(),
                                error: true,
                            })
                        }
                        Err(error) => {
                            this.chat.note = Some(crate::model::chat::ChatNote {
                                text: format!("Could not fork: {error}"),
                                error: true,
                            })
                        }
                    }
                    this.sync_transcript();
                    cx.notify();
                });
            }
        })
        .detach();
    }
}
