use super::*;
use crate::model::composer_library::{LibraryEntry, LibraryList, LibraryRead};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_kit::component::{
    WindowExt,
    input::{Input, InputState, Textarea, TextareaState},
};

#[derive(Default)]
pub(super) struct LibraryUi {
    result: Option<LibraryList>,
    loading: bool,
    pub(super) busy: bool,
    error: Option<String>,
    notice: Option<String>,
    generation: u64,
}

impl AppView {
    pub(super) fn load_composer_library(&mut self, cx: &mut Context<Self>) {
        let scope = self.capability_scope();
        let Some(session) = &scope.session else {
            return;
        };
        if !self.composer_method_available("skills.library.list") {
            return;
        }
        let generation = self.composer_capabilities.generation;
        self.composer_capabilities.library.loading = true;
        self.composer_capabilities.library.error = None;
        self.composer_capabilities.library.generation += 1;
        let request = self.composer_capabilities.library.generation;
        self.request(
            "skills.library.list",
            json!({"sessionKey":session}),
            cx,
            move |this, result, _| {
                if !this.capability_is_current(&scope, generation)
                    || this.composer_capabilities.library.generation != request
                {
                    return;
                }
                let library = &mut this.composer_capabilities.library;
                library.loading = false;
                match result.and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string())) {
                    Ok(result) => library.result = Some(result),
                    Err(error) => library.error = Some(error),
                }
            },
        );
    }

    fn activate_composer_library(
        &mut self,
        action: &'static str,
        entry: LibraryEntry,
        cx: &mut Context<Self>,
    ) {
        let scope = self.capability_scope();
        let Some(session) = &scope.session else {
            return;
        };
        if !self.composer_has_scope("operator.write") || self.composer_capabilities.library.busy {
            return;
        }
        let generation = self.composer_capabilities.generation;
        self.composer_capabilities.library.busy = true;
        self.composer_capabilities.library.error = None;
        let mut params = json!({"sessionKey":session,"action":action,"skillId":entry.skill_id});
        if action == "attach" {
            params["revision"] = entry.revision.into();
        }
        self.request("skills.library.activate",params,cx,move|this,result,cx| {
            if !this.capability_is_current(&scope,generation) {return;}
            this.composer_capabilities.library.busy=false;
            match result {
                Ok(_)=> {
                    this.composer_capabilities.library.notice=Some("Skill selections updated for the next turn. An active turn keeps its current revision.".into());
                    this.composer_state.catalog_cache.clear();
                    this.load_composer_catalogs(cx);
                    this.load_composer_library(cx);
                }
                Err(error)=>this.composer_capabilities.library.error=Some(error),
            }
        });
    }

    fn read_composer_library(
        &mut self,
        entry: LibraryEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let scope = self.capability_scope();
        let Some(session) = &scope.session else {
            return;
        };
        let generation = self.composer_capabilities.generation;
        self.composer_capabilities.library.busy = true;
        self.composer_capabilities.library.error = None;
        let window = window.window_handle();
        self.request(
            "skills.library.read",
            json!({"sessionKey":session,"skillId":entry.skill_id,"revision":entry.revision}),
            cx,
            move |this, result, cx| {
                if !this.capability_is_current(&scope, generation) {
                    return;
                }
                this.composer_capabilities.library.busy = false;
                match result.and_then(|v| {
                    serde_json::from_value::<LibraryRead>(v).map_err(|e| e.to_string())
                }) {
                    Ok(read) => {
                        let _ = window.update(cx, move |_, window, cx| {
                            let title = read.entry.slug.clone();
                            let viewer = cx.new(|cx| LibraryReader::new(read, window, cx));
                            window.open_dialog(cx, move |dialog, _, _| {
                                dialog
                                    .title(title.clone())
                                    .w(px(tokens::LIBRARY_DIALOG_WIDTH))
                                    .child(viewer.clone())
                            });
                        });
                    }
                    Err(error) => this.composer_capabilities.library.error = Some(error),
                }
            },
        );
    }

    pub(super) fn composer_library_menu(
        &self,
        id: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        if self.new_session.active || !self.composer_method_available("skills.library.list") {
            return Vec::new();
        }
        let library = &self.composer_capabilities.library;
        let p = Palette::get(cx);
        let session = library.result.as_ref().and_then(|r| r.session.as_ref());
        if id.is_none()
            && library
                .result
                .as_ref()
                .is_some_and(|r| r.default_target == "workspace")
            && session.is_none_or(|s| s.selections.is_empty() && s.attachable.is_empty())
        {
            return Vec::new();
        }
        let busy = library.loading || library.busy;
        let can_write = self.composer_has_scope("operator.write");
        let mut rows = Vec::new();
        if id.is_none() {
            rows.push(menu_note("Selected for this session", cx).into_any_element());
        }
        if busy {
            rows.push(menu_note("Loading…", cx).into_any_element());
        }
        if let Some(error) = &library.error {
            rows.push(menu_note(error, cx).text_color(p.danger).into_any_element());
            rows.push(
                menu_row("library-reload", "Retry", None, None, None, false, cx)
                    .on_click(cx.listener(|this, _, _, cx| this.load_composer_library(cx)))
                    .into_any_element(),
            );
        }
        if let Some(notice) = &library.notice {
            rows.push(menu_note(notice, cx).into_any_element());
        }
        if let Some(id) = id {
            if let Some(pin) = session.and_then(|s| s.selections.iter().find(|p| p.skill_id == id))
            {
                rows.push(
                    menu_note(
                        &format!(
                            "{} · {}\nSelected revision {}",
                            pin.slug,
                            pin.owner_label,
                            pin.revision.chars().take(8).collect::<String>()
                        ),
                        cx,
                    )
                    .into_any_element(),
                );
                let entry = pin.clone();
                rows.push(
                    menu_row(
                        "library-read",
                        "Read selected revision",
                        None,
                        None,
                        None,
                        busy,
                        cx,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.read_composer_library(entry.clone(), window, cx)
                    }))
                    .into_any_element(),
                );
                if can_write {
                    for (action, label) in [("refresh", "Refresh revision"), ("detach", "Detach")] {
                        let entry = pin.clone();
                        rows.push(
                            menu_row(
                                format!("library-{action}"),
                                label,
                                None,
                                None,
                                None,
                                busy,
                                cx,
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if action == "detach" {
                                    this.composer_capabilities.view = PlusView::Skills;
                                }
                                this.activate_composer_library(action, entry.clone(), cx);
                            }))
                            .into_any_element(),
                        );
                    }
                }
            }
            return rows;
        }
        if let Some(session) = session {
            if session.selections.is_empty() {
                rows.push(menu_note("No managed skills selected.", cx).into_any_element());
            }
            for pin in &session.selections {
                let id = pin.skill_id.clone();
                rows.push(
                    menu_row(
                        format!("library-selected-{id}"),
                        &format!("{} · {}", pin.slug, pin.owner_label),
                        None,
                        Some(&format!(
                            "Selected revision {}",
                            pin.revision.chars().take(8).collect::<String>()
                        )),
                        None,
                        busy,
                        cx,
                    )
                    .child(Icon::new(IconName::ChevronRight).size(px(tokens::ICON_SIZE)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.composer_capabilities.view = PlusView::Library(id.clone());
                        cx.notify();
                    }))
                    .into_any_element(),
                );
            }
            if !session.attachable.is_empty() {
                rows.push(menu_divider(cx).into_any_element());
                rows.push(menu_note("Add from your libraries", cx).into_any_element());
            }
            for entry in &session.attachable {
                let selected = entry.clone();
                rows.push(
                    menu_row(
                        format!("library-attach-{}", entry.skill_id),
                        &format!("Attach {} · {}", entry.slug, entry.owner_label),
                        None,
                        Some(&entry.description),
                        None,
                        busy || !can_write,
                        cx,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.activate_composer_library("attach", selected.clone(), cx)
                    }))
                    .into_any_element(),
                );
            }
        }
        if let Some(result) = &library.result {
            rows.push(menu_note(&format!("New sessions select up to {} default skills. Existing sessions keep their selected revisions.",result.default_selection_limit),cx).into_any_element());
            if let Some(notice) = &result.default_selection_notice {
                rows.push(menu_note(notice, cx).into_any_element());
            }
        }
        rows.push(menu_divider(cx).into_any_element());
        rows.push(menu_note("Agent skill inventory", cx).into_any_element());
        rows
    }
}

struct LibraryReader {
    read: LibraryRead,
    selected: usize,
    text: Entity<TextareaState>,
    file: Entity<InputState>,
}
impl LibraryReader {
    fn new(read: LibraryRead, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let text = cx.new(|cx| TextareaState::new(window, cx).default_value(read.content.clone()));
        let file = cx.new(|cx| InputState::new(window, cx).default_value("SKILL.md"));
        Self {
            read,
            selected: 0,
            text,
            file,
        }
    }
    fn select(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let (name, text) = if index == 0 {
            ("SKILL.md".into(), self.read.content.clone())
        } else {
            let file = &self.read.files[index - 1];
            let text = if file.encoding.as_deref() == Some("base64") {
                STANDARD
                    .decode(&file.content)
                    .ok()
                    .and_then(|v| String::from_utf8(v).ok())
                    .unwrap_or_else(|| "Binary file — preview unavailable.".into())
            } else {
                file.content.clone()
            };
            (file.path.clone(), text)
        };
        self.selected = index;
        self.file
            .update(cx, |input, cx| input.set_value(name, window, cx));
        self.text
            .update(cx, |input, cx| input.set_value(text, window, cx));
        cx.notify();
    }
}
impl Render for LibraryReader {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let names = std::iter::once("SKILL.md".to_owned())
            .chain(self.read.files.iter().map(|f| f.path.clone()))
            .collect::<Vec<_>>();
        div().v_flex().gap(px(tokens::FORM_GAP)).text_size(px(tokens::FORM_TEXT_SIZE))
            .child(format!("{} · revision {}",self.read.entry.owner_label,self.read.entry.revision.chars().take(8).collect::<String>()))
            .child(div().text_color(p.muted).child("This is the exact revision selected for this session. Session access allows reading this pin, not editing its library or browsing other revisions."))
            .child(div().id("library-files").h_flex().gap(px(tokens::FORM_SEGMENT_GAP)).overflow_x_scroll().children(names.into_iter().enumerate().map(|(index,name)|Button::new(("library-file",index)).ghost().small().label(name).when(self.selected==index,|b|b.bg(p.hover)).on_click(cx.listener(move|this,_,window,cx|this.select(index,window,cx))))))
            .child(Input::new(&self.file).readonly(true).aria_label("Selected skill file"))
            .child(Textarea::new(&self.text).readonly(true).h(px(tokens::LIBRARY_PREVIEW_HEIGHT)).aria_label("Selected skill revision"))
    }
}
