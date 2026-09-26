use super::super::AppView;
use crate::{model::web_urls, ui::theme::tokens::motion};
use gpui_kit::{
    assets::IconName,
    base::{DeferredPopover, GlobalState},
    *,
};
use std::{cell::Cell, rc::Rc, time::Instant};

#[derive(Clone)]
pub(super) enum Choice {
    Agent(String),
    Roster,
    Agents,
    New,
    Capabilities(String),
    Settings(String),
    Help,
    Link(&'static str),
}
#[derive(Clone)]
pub(super) struct Entry {
    pub(super) label: String,
    pub(super) icon: Option<IconName>,
    pub(super) choice: Choice,
    pub(super) enabled: bool,
}
#[derive(Clone, Copy, PartialEq)]
pub(super) enum OpenMode {
    Hover,
    Click,
}

pub(super) struct PickerState {
    pub(super) mode: Option<OpenMode>,
    pub(super) trigger_focus: FocusHandle,
    pub(super) menu_focus: FocusHandle,
    pub(super) previous_focus: Option<FocusHandle>,
    pub(super) keyboard_index: Option<usize>,
    pub(super) over_trigger: bool,
    pub(super) over_menu: bool,
    pub(super) timer: Option<Task<()>>,
    pub(super) overlay: Option<DeferredPopover>,
    pub(super) bounds: Rc<Cell<Bounds<Pixels>>>,
    pub(super) query: String,
    pub(super) typed_at: Instant,
    pub(super) help: bool,
    pub(super) epoch: u64,
}
impl PickerState {
    pub(super) fn new(epoch: u64, cx: &App) -> Self {
        Self {
            mode: None,
            trigger_focus: cx.focus_handle(),
            menu_focus: cx.focus_handle(),
            previous_focus: None,
            keyboard_index: None,
            over_trigger: false,
            over_menu: false,
            timer: None,
            overlay: None,
            bounds: Rc::new(Cell::new(Bounds::default())),
            query: String::new(),
            typed_at: Instant::now(),
            help: false,
            epoch,
        }
    }
    pub(super) fn close(&mut self, restore: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.mode = None;
        self.timer = None;
        self.overlay = None;
        self.help = false;
        self.keyboard_index = None;
        if restore {
            self.trigger_focus.focus(window, cx);
        } else if self.menu_focus.contains_focused(window, cx)
            && let Some(focus) = self.previous_focus.take()
        {
            focus.focus(window, cx);
        }
        self.previous_focus = None;
        window.refresh();
        cx.notify();
    }
    pub(super) fn open(
        &mut self,
        mode: OpenMode,
        active: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.timer = None;
        if self.mode.is_none() {
            self.previous_focus = window.focused(cx);
        }
        self.mode = Some(mode);
        self.overlay = Some(GlobalState::register_deferred_popover(cx));
        if mode == OpenMode::Click {
            self.keyboard_index = Some(active);
            self.menu_focus.focus(window, cx);
        }
        window.refresh();
        cx.notify();
    }
    pub(super) fn toggle(&mut self, active: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.mode == Some(OpenMode::Click) {
            self.close(true, window, cx);
        } else {
            self.open(OpenMode::Click, active, window, cx);
        }
    }
    pub(super) fn hover(
        &mut self,
        trigger: bool,
        over: bool,
        active: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if trigger {
            self.over_trigger = over;
        } else {
            self.over_menu = over;
        }
        self.timer = None;
        if self.mode == Some(OpenMode::Click) {
            return;
        }
        let opening = self.over_trigger || self.over_menu;
        if opening == self.mode.is_some() {
            return;
        }
        self.timer = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(if opening {
                    motion::AGENT_OPEN
                } else {
                    motion::AGENT_CLOSE
                })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                if opening {
                    this.open(OpenMode::Hover, active, window, cx);
                } else if !this.menu_focus.contains_focused(window, cx) {
                    this.close(false, window, cx);
                }
            });
        }));
    }
}
impl Render for PickerState {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

pub(super) fn activate(
    state: &mut PickerState,
    choice: &Choice,
    view: &WeakEntity<AppView>,
    epoch: u64,
    window: &mut Window,
    cx: &mut Context<PickerState>,
) {
    if matches!(choice, Choice::Help) {
        state.help = true;
        state.keyboard_index = None;
        cx.notify();
        window.refresh();
        return;
    }
    state.close(false, window, cx);
    let _ = view.update(cx, |this, cx| {
        if this.epoch != epoch {
            return;
        }
        match choice {
            Choice::Agent(id) => {
                if !this
                    .sidebar_state
                    .agents
                    .iter()
                    .any(|agent| &agent.id == id)
                {
                    return;
                }
                this.switch_agent(id.clone(), window, cx);
            }
            Choice::Roster => {
                this.change_sidebar_preferences(|prefs| prefs.all_agents = !prefs.all_agents, cx)
            }
            Choice::Agents => this.open_control_page("/agents", "All agents", window, cx),
            Choice::New => {
                this.open_control_page("/custodian?intent=new-agent", "New agent", window, cx)
            }
            Choice::Capabilities(id) => {
                if this.session.is_none()
                    || !this
                        .sidebar_state
                        .agents
                        .iter()
                        .any(|agent| &agent.id == id)
                {
                    return;
                }
                this.switch_agent(id.clone(), window, cx);
                this.select_session(this.agent_home(), window, cx);
                this.composer.update(cx, |input, cx| {
                    input.set_value("What can you do?", window, cx);
                    input.focus(window, cx);
                });
            }
            Choice::Settings(id) => {
                if let Some(path) = web_urls::agent_settings_path(id) {
                    this.open_control_page(&path, "Agent settings", window, cx);
                }
            }
            Choice::Link(url) => cx.open_url(url),
            Choice::Help => {}
        }
    });
}
pub(super) fn picker_key(
    state: &mut PickerState,
    event: &KeyDownEvent,
    entries: &[Entry],
    view: &WeakEntity<AppView>,
    epoch: u64,
    window: &mut Window,
    cx: &mut Context<PickerState>,
) {
    let help = help_entries();
    let entries = if state.help { &help } else { entries };
    let enabled: Vec<_> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.enabled.then_some(i))
        .collect();
    if enabled.is_empty() {
        return;
    }
    let key = event.keystroke.key.as_str();
    match key {
        "escape" => {
            state.close(true, window, cx);
            cx.stop_propagation();
            return;
        }
        "tab" => {
            state.close(true, window, cx);
            return;
        }
        "enter" | "space" => {
            if let Some(entry) = state.keyboard_index.and_then(|i| entries.get(i)) {
                activate(state, &entry.choice, view, epoch, window, cx);
            }
            cx.stop_propagation();
            return;
        }
        "up" | "down" | "home" | "end" => {
            let current = state
                .keyboard_index
                .and_then(|i| enabled.iter().position(|v| *v == i));
            let index = match key {
                "home" => 0,
                "end" => enabled.len() - 1,
                "up" => current
                    .map(|v| (v + enabled.len() - 1) % enabled.len())
                    .unwrap_or(enabled.len() - 1),
                _ => current.map(|v| (v + 1) % enabled.len()).unwrap_or(0),
            };
            state.keyboard_index = Some(enabled[index]);
        }
        "left" if state.help => {
            state.help = false;
            state.keyboard_index = None;
        }
        _ if key.chars().count() == 1
            && !event.keystroke.modifiers.platform
            && !event.keystroke.modifiers.control
            && !event.keystroke.modifiers.alt =>
        {
            if state.typed_at.elapsed() > motion::TYPEAHEAD_RESET {
                state.query.clear();
            }
            state.typed_at = Instant::now();
            state.query.push_str(&key.to_lowercase());
            state.keyboard_index = entries.iter().position(|entry| {
                entry.enabled && entry.label.to_lowercase().starts_with(&state.query)
            });
        }
        _ => return,
    }
    cx.stop_propagation();
    window.refresh();
    cx.notify();
}
pub(super) fn help_entries() -> Vec<Entry> {
    [
        ("Docs", IconName::BookOpen, "https://docs.openclaw.ai"),
        (
            "Get help",
            IconName::MessageSquare,
            "https://docs.openclaw.ai/help",
        ),
        ("Discord", IconName::UsersRound, "https://discord.gg/clawd"),
        (
            "View changelog",
            IconName::ScrollText,
            "https://docs.openclaw.ai/releases",
        ),
    ]
    .into_iter()
    .map(|(label, icon, url)| Entry {
        label: label.into(),
        icon: Some(icon),
        choice: Choice::Link(url),
        enabled: true,
    })
    .collect()
}
