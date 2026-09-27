//! Measured action menus. Positioner owns placement; this owner keeps one focus and
//! dismissal chain for the root and its submenus, including embedded editors.
use super::{ElementTooltip, icons::icon};
use crate::ui::theme::{
    Palette,
    tokens::{TypographyExt, colors, menu as t, space, text},
};
use gpui_kit::{
    assets::IconName,
    base::{Align, POPUP_PRIORITY, Placement, Positioner, actions},
    component::{Icon, Side, StyledExt, Theme, button::Button},
    prelude::FluentBuilder,
    *,
};
use std::rc::Rc;

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type OpenHandler = Rc<dyn Fn(&mut Window, &mut App)>;
type Content = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;
type Builder = Rc<dyn Fn(ActionMenu, &mut Window, &mut Context<ActionMenu>) -> ActionMenu>;

fn observe_bounds(
    callback: impl FnOnce(Bounds<Pixels>, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    // Explicit edges keep the observer out of the parent's padded content flow.
    canvas(callback, |_, _, _, _| {}).absolute().inset_0()
}

#[derive(Clone)]
enum Entry {
    Action(SharedString),
    Content(Content),
    Submenu(SharedString, Entity<ActionMenu>),
    Label(SharedString),
    Separator,
}

#[derive(Clone)]
pub(crate) struct ActionMenuItem {
    entry: Entry,
    icon: Option<Icon>,
    disabled: bool,
    checked: bool,
    destructive: bool,
    hint: Option<SharedString>,
    mnemonic: Option<SharedString>,
    title: Option<SharedString>,
    handler: Option<Handler>,
}

impl FluentBuilder for ActionMenuItem {}

impl ActionMenuItem {
    fn from_entry(entry: Entry) -> Self {
        Self {
            entry,
            icon: None,
            disabled: false,
            checked: false,
            destructive: false,
            hint: None,
            mnemonic: None,
            title: None,
            handler: None,
        }
    }
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self::from_entry(Entry::Action(label.into()))
    }
    pub fn element<E: IntoElement>(render: impl Fn(&mut Window, &mut App) -> E + 'static) -> Self {
        Self::from_entry(Entry::Content(Rc::new(move |window, cx| {
            render(window, cx).into_any_element()
        })))
    }
    pub fn submenu(label: impl Into<SharedString>, menu: Entity<ActionMenu>) -> Self {
        Self::from_entry(Entry::Submenu(label.into(), menu))
    }
    pub fn separator() -> Self {
        Self::from_entry(Entry::Separator)
    }
    pub fn label(label: impl Into<SharedString>) -> Self {
        Self::from_entry(Entry::Label(label.into()))
    }
    pub fn icon(mut self, icon: impl Into<Icon>) -> Self {
        self.icon = Some(icon.into());
        self
    }
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }
    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        let hint = hint.into();
        if hint.len() == 1 {
            self.mnemonic = Some(hint.to_lowercase().into());
        }
        self.hint = Some(hint);
        self
    }
    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.handler = Some(Rc::new(handler));
        self
    }
    fn selectable(&self) -> bool {
        !self.disabled
            && match self.entry {
                Entry::Action(_) | Entry::Submenu(_, _) => true,
                Entry::Content(_) => self.handler.is_some(),
                _ => false,
            }
    }
    fn embedded(&self) -> bool {
        matches!(self.entry, Entry::Content(_)) && self.handler.is_none()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SelectionDisplay {
    Hidden,
    Pointer,
    Keyboard,
}

pub(crate) struct ActionMenu {
    items: Vec<ActionMenuItem>,
    focus: FocusHandle,
    return_focus: Option<FocusHandle>,
    initial_focus: Option<FocusHandle>,
    on_open: Option<OpenHandler>,
    parent: Option<WeakEntity<ActionMenu>>,
    selected: Option<usize>,
    selection_display: SelectionDisplay,
    submenu_open: bool,
    bounds: Bounds<Pixels>,
    item_bounds: Vec<Bounds<Pixels>>,
    min_width: Option<Pixels>,
    max_width: Pixels,
    max_height: Option<Pixels>,
    scrollable: bool,
    check_side: Side,
    depth: usize,
    scroll: ScrollHandle,
}

impl FluentBuilder for ActionMenu {}
impl EventEmitter<DismissEvent> for ActionMenu {}
impl Focusable for ActionMenu {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ActionMenu {
    fn new(cx: &mut App) -> Self {
        Self {
            items: vec![],
            focus: cx.focus_handle(),
            return_focus: None,
            initial_focus: None,
            on_open: None,
            parent: None,
            selected: None,
            selection_display: SelectionDisplay::Hidden,
            submenu_open: false,
            bounds: Bounds::default(),
            item_bounds: vec![],
            min_width: None,
            max_width: t::STANDARD.width,
            max_height: None,
            scrollable: false,
            check_side: Side::Right,
            depth: 0,
            scroll: ScrollHandle::default(),
        }
    }
    pub fn build(
        window: &mut Window,
        cx: &mut App,
        builder: impl FnOnce(Self, &mut Window, &mut Context<Self>) -> Self,
    ) -> Entity<Self> {
        cx.new(|cx| builder(Self::new(cx), window, cx))
    }
    pub fn min_w(mut self, value: impl Into<Pixels>) -> Self {
        self.min_width = Some(value.into());
        self
    }
    pub fn max_w(mut self, value: impl Into<Pixels>) -> Self {
        self.max_width = value.into();
        self
    }
    pub fn max_h(mut self, value: impl Into<Pixels>) -> Self {
        self.max_height = Some(value.into());
        self
    }
    pub fn scrollable(mut self, value: bool) -> Self {
        self.scrollable = value;
        self
    }
    pub fn check_side(mut self, side: Side) -> Self {
        self.check_side = side;
        self
    }
    pub fn on_open(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }
    pub fn initial_focus(mut self, focus: FocusHandle) -> Self {
        self.initial_focus = Some(focus);
        self
    }
    pub fn action_context(mut self, focus: FocusHandle) -> Self {
        self.return_focus = Some(focus);
        self
    }
    pub fn item(mut self, item: ActionMenuItem) -> Self {
        self.items.push(item);
        self
    }
    pub fn separator(self) -> Self {
        if self.items.is_empty()
            || self
                .items
                .last()
                .is_some_and(|item| matches!(item.entry, Entry::Separator))
        {
            return self;
        }
        self.item(ActionMenuItem::separator())
    }
    pub fn label(self, label: impl Into<SharedString>) -> Self {
        self.item(ActionMenuItem::label(label))
    }
    pub fn submenu_with_icon(
        mut self,
        icon: Option<Icon>,
        label: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
        builder: impl Fn(Self, &mut Window, &mut Context<Self>) -> Self + 'static,
    ) -> Self {
        let submenu = Self::build(window, cx, builder);
        let parent = cx.entity().downgrade();
        submenu.update(cx, |menu, _| {
            menu.parent = Some(parent);
            menu.depth = self.depth + 1;
        });
        self.items.push(
            ActionMenuItem::submenu(label, submenu).when_some(icon, |item, icon| item.icon(icon)),
        );
        self
    }
    /// Metadata for the most recently appended submenu, without a parallel submenu builder.
    pub fn last_hint(mut self, hint: impl Into<SharedString>) -> Self {
        if let Some(item) = self.items.last_mut() {
            *item = item.clone().hint(hint);
        }
        self
    }
    pub fn last_disabled(mut self, disabled: bool, reason: Option<SharedString>) -> Self {
        if let Some(item) = self.items.last_mut() {
            item.disabled = disabled;
            item.title = reason;
        }
        self
    }
    pub fn rebuild(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        builder: impl FnOnce(Self, &mut Window, &mut Context<Self>) -> Self,
    ) {
        let mut menu = std::mem::replace(self, Self::new(cx));
        menu.items.clear();
        menu.item_bounds.clear();
        menu.selected = None;
        menu.submenu_open = false;
        *self = builder(menu, window, cx);
        self.selected = self.items.iter().position(ActionMenuItem::selectable);
        cx.notify();
    }
    fn submenu_at(&self, index: usize) -> Option<Entity<Self>> {
        match &self.items.get(index)?.entry {
            Entry::Submenu(_, menu) => Some(menu.clone()),
            _ => None,
        }
    }
    fn active_submenu(&self) -> Option<Entity<Self>> {
        self.submenu_open
            .then_some(self.selected)
            .flatten()
            .and_then(|index| self.submenu_at(index))
    }
    fn contains_point(&self, point: &Point<Pixels>, cx: &App) -> bool {
        self.bounds.contains(point)
            || self
                .active_submenu()
                .is_some_and(|menu| menu.read(cx).contains_point(point, cx))
    }
    fn move_selection(&mut self, forward: bool, cx: &mut Context<Self>) {
        let eligible: Vec<_> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.selectable())
            .map(|(index, _)| index)
            .collect();
        if eligible.is_empty() {
            return;
        }
        let current = self
            .selected
            .and_then(|index| eligible.iter().position(|candidate| *candidate == index));
        self.submenu_open = false;
        self.selection_display = SelectionDisplay::Keyboard;
        self.selected = Some(
            eligible[match current {
                Some(index) if forward => (index + 1) % eligible.len(),
                Some(index) => (index + eligible.len() - 1) % eligible.len(),
                None if forward => 0,
                None => eligible.len() - 1,
            }],
        );
        if let Some(index) = self.selected {
            self.scroll.scroll_to_item(index);
        }
        cx.notify();
    }
    pub fn focus_first(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.selected = None;
        self.move_selection(true, cx);
        self.initial_focus
            .as_ref()
            .unwrap_or(&self.focus)
            .focus(window, cx);
    }
    fn close_branch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(parent) = self.parent.clone() {
            let _ = parent.update(cx, |parent, cx| {
                parent.submenu_open = false;
                parent.selection_display = SelectionDisplay::Keyboard;
                parent.focus.focus(window, cx);
                cx.notify();
            });
        } else {
            self.dismiss(window, cx);
        }
    }
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(parent) = self.parent.clone() {
            let _ = parent.update(cx, |parent, cx| parent.dismiss(window, cx));
        } else {
            if let Some(focus) = &self.return_focus {
                focus.focus(window, cx);
            }
            cx.emit(DismissEvent);
            cx.notify();
        }
    }
    fn open_submenu(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<Self>> {
        let submenu = self.submenu_at(index)?;
        let opening = self.selected != Some(index) || !self.submenu_open;
        self.selected = Some(index);
        self.submenu_open = true;
        if opening {
            let on_open = submenu.read(cx).on_open.clone();
            if let Some(on_open) = on_open {
                on_open(window, cx);
            }
        }
        Some(submenu)
    }
    fn activate(
        &mut self,
        index: usize,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(item) = self
            .items
            .get(index)
            .filter(|item| item.selectable())
            .cloned()
        else {
            return;
        };
        if let Some(submenu) = self.open_submenu(index, window, cx) {
            let keyboard = self.selection_display == SelectionDisplay::Keyboard;
            submenu.update(cx, |menu, cx| {
                menu.focus_first(window, cx);
                if !keyboard {
                    menu.selection_display = SelectionDisplay::Hidden;
                }
            });
            cx.notify();
            return;
        }
        let handler = item.handler.clone();
        self.dismiss(window, cx);
        if let Some(handler) = handler {
            handler(event, window, cx);
        }
    }
    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.selected {
            self.activate(index, &ClickEvent::default(), window, cx);
        }
    }
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if self
            .active_submenu()
            .is_some_and(|menu| menu.focus_handle(cx).contains_focused(window, cx))
        {
            return;
        }
        if key == "escape" {
            cx.stop_propagation();
            self.close_branch(window, cx);
            return;
        }
        // Inputs and embedded controls own their editing and grid navigation.
        if !self.focus.is_focused(window) {
            return;
        }
        self.selection_display = SelectionDisplay::Keyboard;
        match key {
            "down" => self.move_selection(true, cx),
            "up" => self.move_selection(false, cx),
            "left" if self.parent.is_some() => self.close_branch(window, cx),
            "right" => {
                if let Some(index) = self
                    .selected
                    .filter(|index| self.submenu_at(*index).is_some())
                {
                    self.activate(index, &ClickEvent::default(), window, cx);
                }
            }
            "enter" | "space" => self.confirm(window, cx),
            _ if !event.keystroke.modifiers.platform
                && !event.keystroke.modifiers.control
                && !event.keystroke.modifiers.alt =>
            {
                let index = self.items.iter().position(|item| {
                    item.selectable()
                        && item
                            .mnemonic
                            .as_ref()
                            .is_some_and(|mnemonic| mnemonic.eq_ignore_ascii_case(key))
                });
                let Some(index) = index else {
                    return;
                };
                self.activate(index, &ClickEvent::default(), window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
    }
    fn render_row(
        &self,
        index: usize,
        item: &ActionMenuItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        match &item.entry {
            Entry::Separator => {
                return div()
                    .h(space::HAIRLINE)
                    .mx(space::MD)
                    .my(space::XS)
                    .bg(p.border.opacity(t::ACTION_SEPARATOR_OPACITY))
                    .into_any_element();
            }
            Entry::Label(label) => {
                return div()
                    .px(space::MD)
                    .pt(space::XS)
                    .pb(space::SM)
                    .text_color(p.muted)
                    .typography(text::MENU_INFO)
                    .child(label.clone())
                    .into_any_element();
            }
            _ => {}
        }
        let embedded = item.embedded();
        let selectable = item.selectable();
        let submenu = matches!(item.entry, Entry::Submenu(_, _));
        let selected = self.selected == Some(index);
        let highlighted = selected && self.selection_display != SelectionDisplay::Hidden;
        let focus_ring = selected
            && self.selection_display == SelectionDisplay::Keyboard
            && self.focus.is_focused(window);
        let color = if item.destructive { p.danger } else { p.text };
        let mut row = div()
            .id(index)
            .role(Role::MenuItem)
            .aria_selected(selected)
            .when(selected && selectable, |row| row.aria_active_descendant())
            .when_some(item.mnemonic.clone(), |row, key| row.aria_keyshortcuts(key))
            .when(submenu, |row| {
                row.aria_expanded(selected && self.submenu_open)
            })
            .relative()
            .h_flex()
            .min_h(t::ROW_HEIGHT)
            .items_center()
            .gap(t::ICON_GAP)
            .rounded(t::ACTION_ITEM_RADIUS)
            .text_color(color)
            .typography(text::MENU)
            .when(!embedded, |row| row.px(space::MD))
            .when(highlighted && selectable, |row| row.bg(p.hover))
            .when(item.disabled && !embedded, |row| {
                row.opacity(t::ACTION_DISABLED_OPACITY)
            })
            .when_some(item.title.clone(), |row, title| {
                row.aria_description(title.clone()).element_tooltip(title)
            })
            .child(observe_bounds({
                let menu = cx.entity().downgrade();
                move |bounds, _, cx| {
                    let _ = menu.update(cx, |menu, _| {
                        if index < menu.item_bounds.len() {
                            menu.item_bounds[index] = bounds;
                        }
                    });
                }
            }))
            .when(selectable, |row| {
                row.cursor_pointer()
                    .on_hover(cx.listener(move |menu, hovered, window, cx| {
                        if *hovered
                            && (menu.selected != Some(index)
                                || (submenu && !menu.submenu_open)
                                || menu.selection_display != SelectionDisplay::Pointer)
                        {
                            menu.selection_display = SelectionDisplay::Pointer;
                            if submenu {
                                menu.open_submenu(index, window, cx);
                            } else {
                                menu.selected = Some(index);
                                menu.submenu_open = false;
                            }
                            menu.focus.focus(window, cx);
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |menu, event: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        menu.selection_display = if event.is_keyboard() {
                            SelectionDisplay::Keyboard
                        } else {
                            SelectionDisplay::Pointer
                        };
                        menu.activate(index, event, window, cx);
                    }))
            });
        if let Some(glyph) = item.icon.clone() {
            row = row.child(
                glyph
                    .size(t::ACTION_ICON_SIZE)
                    .text_color(if item.destructive { p.danger } else { p.muted }),
            );
        } else if item.checked && self.check_side.is_left() {
            row = row.child(icon(IconName::Check, t::ACTION_ICON_SIZE).text_color(p.accent));
        }
        row = match &item.entry {
            Entry::Action(label) | Entry::Submenu(label, _) => row.aria_label(label.clone()).child(
                div()
                    .flex_grow(1.)
                    .min_w_0()
                    .truncate()
                    .child(label.clone()),
            ),
            Entry::Content(render) => {
                row.child(div().flex_grow(1.).min_w_0().child(render(window, cx)))
            }
            _ => row,
        };
        if item.checked && self.check_side.is_right() {
            row = row.child(icon(IconName::Check, t::ACTION_ICON_SIZE).text_color(p.accent));
        }
        if let Some(hint) = &item.hint {
            row = row.child(
                div()
                    .ml(t::ACTION_HINT_MARGIN - t::ICON_GAP)
                    .min_w(t::ACTION_HINT_MIN_WIDTH)
                    .font_family(Theme::global(cx).mono_font_family.clone())
                    .text_size(t::ACTION_HINT_SIZE)
                    .line_height(t::ACTION_HINT_SIZE)
                    .text_center()
                    .text_color(p.muted)
                    .child(hint.clone()),
            );
        }
        if submenu {
            row =
                row.child(icon(IconName::ChevronRight, t::ACTION_CHEVRON_SIZE).text_color(p.muted));
        }
        if focus_ring && selectable {
            row = row.child(
                deferred(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| {
                            let outset = t::ACTION_FOCUS_OFFSET + t::ACTION_FOCUS_WIDTH;
                            window.paint_quad(quad(
                                bounds.dilate(outset),
                                t::ACTION_ITEM_RADIUS + outset,
                                transparent_black(),
                                t::ACTION_FOCUS_WIDTH,
                                p.accent,
                                BorderStyle::default(),
                            ));
                        },
                    )
                    .absolute()
                    .inset_0()
                    .size_full(),
                )
                .with_priority(POPUP_PRIORITY + self.depth + 1),
            );
        }
        row.into_any_element()
    }
}

impl Render for ActionMenu {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        self.item_bounds.resize(self.items.len(), Bounds::default());
        let rows: Vec<_> = self
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| self.render_row(index, item, window, cx))
            .collect();
        let mut body = div().id("action-menu-items").v_flex().children(rows);
        if self.scrollable {
            body = body
                .max_h(
                    self.max_height
                        .unwrap_or(window.bounds().size.height - space::MD * 2.),
                )
                .overflow_y_scroll()
                .track_scroll(&self.scroll);
        }
        let mut menu = div()
            .id("action-menu")
            .relative()
            .role(Role::Menu)
            .key_context("ActionMenu")
            .track_focus(&self.focus)
            .tab_group()
            .v_flex()
            .when_some(self.min_width, |menu, width| menu.min_w(width))
            .max_w(self.max_width)
            .p(if self.parent.is_some() {
                t::ACTION_SUBMENU_PADDING
            } else {
                space::XS
            })
            .border(space::HAIRLINE)
            .border_color(colors::overlay_border(p))
            .rounded(t::ACTION_RADIUS)
            .bg(p.elevated)
            .shadow(colors::menu_shadow(Theme::global(cx).is_dark()))
            .on_key_down(cx.listener(Self::key_down))
            .on_action(cx.listener(|this, _: &actions::SelectDown, _, cx| {
                cx.stop_propagation();
                this.move_selection(true, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::SelectUp, _, cx| {
                cx.stop_propagation();
                this.move_selection(false, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::Cancel, window, cx| {
                cx.stop_propagation();
                this.close_branch(window, cx);
            }))
            .on_action(
                cx.listener(|this, _: &gpui_kit::component::input::Escape, window, cx| {
                    cx.stop_propagation();
                    this.close_branch(window, cx);
                }),
            )
            .on_action(cx.listener(|this, _: &actions::Confirm, window, cx| {
                cx.stop_propagation();
                this.confirm(window, cx);
            }))
            .child(observe_bounds({
                let view = cx.entity().downgrade();
                move |bounds, _, cx| {
                    let _ = view.update(cx, |menu, _| menu.bounds = bounds);
                }
            }))
            .when(self.parent.is_none(), |menu| {
                menu.on_mouse_down_out(cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    if !this.contains_point(&event.position, cx) {
                        this.dismiss(window, cx);
                    }
                }))
            })
            .child(body);
        if let Some(index) = self.selected
            && self.submenu_open
            && let Some(submenu) = self.submenu_at(index)
        {
            let bounds = self.item_bounds[index];
            if bounds.size.width > space::NONE {
                menu = menu.child(
                    deferred(
                        Positioner::side(bounds)
                            .placement(Placement::Right)
                            .align(Align::Start)
                            .offset(t::ACTION_SUBMENU_GAP)
                            .margin(space::MD)
                            .occlude()
                            .child(submenu),
                    )
                    .with_priority(POPUP_PRIORITY + self.depth + 1),
                );
            }
        }
        menu
    }
}

#[derive(Default)]
struct MenuHost {
    menu: Option<Entity<ActionMenu>>,
    subscription: Option<Subscription>,
    position: Point<Pixels>,
    trigger_bounds: Option<Bounds<Pixels>>,
    context_bounds: Bounds<Pixels>,
    registration: Option<gpui_kit::base::DeferredPopover>,
}

impl MenuHost {
    fn show(
        host: &Entity<Self>,
        builder: &Builder,
        mut position: Point<Pixels>,
        keyboard: bool,
        current_view: EntityId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let return_focus = host
            .read(cx)
            .menu
            .as_ref()
            .and_then(|menu| menu.read(cx).return_focus.clone())
            .or_else(|| window.focused(cx));
        let builder = builder.clone();
        let menu = ActionMenu::build(window, cx, move |menu, window, cx| {
            builder(menu, window, cx)
                .when_some(return_focus, |menu, focus| menu.action_context(focus))
        });
        let dismiss_host = host.downgrade();
        let subscription = window.subscribe(&menu, cx, move |_, _: &DismissEvent, _, cx| {
            let _ = dismiss_host.update(cx, |host, _| {
                host.menu = None;
                host.subscription = None;
                host.registration = None;
            });
            cx.notify(current_view);
        });
        let on_open = menu.read(cx).on_open.clone();
        if let Some(on_open) = on_open {
            on_open(window, cx);
        }
        menu.update(cx, |menu, cx| {
            menu.focus_first(window, cx);
            if !keyboard {
                menu.selection_display = SelectionDisplay::Hidden;
            }
        });
        if host.read(cx).trigger_bounds.is_none() {
            let viewport = window.bounds().size;
            position.x = position
                .x
                .min(viewport.width - t::ACTION_CONTEXT_ESTIMATED_WIDTH - space::MD)
                .max(space::MD);
            position.y = position
                .y
                .min(viewport.height - t::ACTION_CONTEXT_ESTIMATED_HEIGHT - space::MD)
                .max(space::MD)
                + t::ACTION_CONTEXT_OFFSET_Y;
        }
        let registration = gpui_kit::base::GlobalState::register_deferred_popover(cx);
        host.update(cx, |host, _| {
            host.position = position;
            host.menu = Some(menu);
            host.subscription = Some(subscription);
            host.registration = Some(registration);
        });
        cx.notify(current_view);
    }
    fn layer(&self) -> Option<AnyElement> {
        self.menu.clone().map(|menu| {
            let positioner = if let Some(bounds) = self.trigger_bounds {
                Positioner::side(bounds)
                    .placement(Placement::Bottom)
                    .align(Align::Start)
                    .offset(space::XS)
            } else {
                Positioner::corner(Anchor::TopLeft, self.position)
            };
            deferred(positioner.margin(space::MD).occlude().child(menu))
                .with_priority(POPUP_PRIORITY)
                .into_any_element()
        })
    }
}

pub(crate) trait ActionContextMenuExt:
    InteractiveElement + ParentElement + Styled + IntoElement + Sized + 'static
{
    #[track_caller]
    fn context_menu(
        mut self,
        builder: impl Fn(ActionMenu, &mut Window, &mut Context<ActionMenu>) -> ActionMenu + 'static,
    ) -> ActionContextMenu<Self> {
        let id = self
            .interactivity()
            .element_id
            .clone()
            .unwrap_or_else(|| ElementId::CodeLocation(*std::panic::Location::caller()));
        ActionContextMenu {
            id,
            element: self,
            builder: Rc::new(builder),
        }
    }
}
impl<E: InteractiveElement + ParentElement + Styled + IntoElement + 'static> ActionContextMenuExt
    for E
{
}

#[derive(IntoElement)]
pub(crate) struct ActionContextMenu<
    E: InteractiveElement + ParentElement + Styled + IntoElement + 'static,
> {
    id: ElementId,
    element: E,
    builder: Builder,
}

impl<E: InteractiveElement + ParentElement + Styled + IntoElement + 'static> RenderOnce
    for ActionContextMenu<E>
{
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus = window
            .use_keyed_state((self.id.clone(), "action-menu-focus"), cx, |_, cx| {
                cx.focus_handle()
            })
            .read(cx)
            .clone();
        let host = window.use_keyed_state((self.id, "action-menu-host"), cx, |_, _| {
            MenuHost::default()
        });
        let current_view = window.current_view();
        let open_host = host.clone();
        let builder = self.builder;
        let key_builder = builder.clone();
        let key_host = host.clone();
        let layer = host.read(cx).layer();
        self.element
            .relative()
            .track_focus(&focus)
            .tab_index(0)
            .child(observe_bounds(move |bounds, _, cx| {
                host.update(cx, |host, _| host.context_bounds = bounds);
            }))
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key == "f10" && event.keystroke.modifiers.shift {
                    cx.stop_propagation();
                    let position = key_host.read(cx).context_bounds.bottom_left();
                    MenuHost::show(
                        &key_host,
                        &key_builder,
                        position,
                        true,
                        current_view,
                        window,
                        cx,
                    );
                }
            })
            .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                cx.stop_propagation();
                MenuHost::show(
                    &open_host,
                    &builder,
                    event.position,
                    false,
                    current_view,
                    window,
                    cx,
                );
            })
            .children(layer)
    }
}

#[track_caller]
pub(crate) fn dropdown_menu(
    trigger: Button,
    builder: impl Fn(ActionMenu, &mut Window, &mut Context<ActionMenu>) -> ActionMenu + 'static,
) -> ActionDropdownMenu {
    ActionDropdownMenu {
        id: ElementId::CodeLocation(*std::panic::Location::caller()),
        trigger,
        builder: Rc::new(builder),
    }
}

#[derive(IntoElement)]
pub(crate) struct ActionDropdownMenu {
    id: ElementId,
    trigger: Button,
    builder: Builder,
}

impl RenderOnce for ActionDropdownMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let host = window.use_keyed_state((self.id.clone(), "action-menu-host"), cx, |_, _| {
            MenuHost::default()
        });
        let layer = host.read(cx).layer();
        let open_host = host.clone();
        let current_view = window.current_view();
        let builder = self.builder;
        div()
            .id(self.id)
            .relative()
            .child(observe_bounds(move |bounds, _, cx| {
                host.update(cx, |host, _| host.trigger_bounds = Some(bounds));
            }))
            .child(self.trigger.on_click(move |event, window, cx| {
                cx.stop_propagation();
                let current = open_host.read(cx).menu.clone();
                if let Some(menu) = current {
                    menu.update(cx, |menu, cx| menu.dismiss(window, cx));
                } else {
                    MenuHost::show(
                        &open_host,
                        &builder,
                        Point::default(),
                        event.is_keyboard(),
                        current_view,
                        window,
                        cx,
                    );
                }
            }))
            .children(layer)
    }
}
