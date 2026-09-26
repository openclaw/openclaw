use super::menu::popover;
use gpui_kit::{
    component::{button::Button, menu::PopupMenu},
    *,
};
use std::rc::Rc;

type MenuBuilder = Rc<dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu>;

#[derive(IntoElement)]
pub struct Dropdown {
    id: ElementId,
    anchor: Anchor,
    trigger: Button,
    builder: MenuBuilder,
}

#[derive(Default)]
struct DropdownState {
    open: bool,
    menu: Option<Entity<PopupMenu>>,
    dismissal: Option<Subscription>,
}

impl Dropdown {
    pub fn new(
        id: impl Into<ElementId>,
        anchor: Anchor,
        trigger: Button,
        builder: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            anchor,
            trigger,
            builder: Rc::new(builder),
        }
    }
}

impl RenderOnce for Dropdown {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let menu_state =
            window.use_keyed_state(self.id.clone(), cx, |_, _| DropdownState::default());
        let open = menu_state.read(cx).open;
        let change_state = menu_state.clone();
        let parent_view = window.current_view();
        popover(
            SharedString::from(format!("dropdown-popover:{}", self.id)),
            self.anchor,
            open,
            self.trigger,
            div().into_any_element(),
            move |open, _, cx| {
                change_state.update(cx, |state, _| {
                    state.open = open;
                    if !open {
                        state.menu = None;
                        state.dismissal = None;
                    }
                });
                cx.notify(parent_view);
            },
        )
        // PopupMenu owns outside clicks across its entire submenu chain.
        .overlay_closable(false)
        .content(move |_, window, cx| {
            if let Some(menu) = menu_state.read(cx).menu.clone() {
                return menu;
            }
            let builder = self.builder.clone();
            let menu = PopupMenu::build(window, cx, move |menu, window, cx| {
                builder(menu, window, cx)
            });
            let popover_state = cx.entity().downgrade();
            let dismissal = window.subscribe(&menu, cx, move |_, _: &DismissEvent, window, cx| {
                let _ = popover_state.update(cx, |state, cx| state.dismiss(window, cx));
            });
            menu_state.update(cx, |state, _| {
                state.menu = Some(menu.clone());
                state.dismissal = Some(dismissal);
            });
            menu.focus_handle(cx).focus(window, cx);
            menu
        })
    }
}
