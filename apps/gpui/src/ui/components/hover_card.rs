use gpui_kit::{
    base::{DeferredPopover, GlobalState},
    component::Theme,
    *,
};
use std::{cell::Cell, rc::Rc};

use crate::{
    model::overlay_placement as geometry,
    ui::theme::{
        Palette,
        tokens::{card, colors, motion, radius, space},
    },
};

type CardContent = Box<dyn Fn(HoverCardDismiss, &mut Window, &mut App) -> AnyElement>;
type CardTrigger = Box<dyn FnOnce(bool) -> AnyElement>;

#[derive(IntoElement)]
pub(in crate::ui) struct HoverCard {
    id: ElementId,
    trigger: CardTrigger,
    content: CardContent,
}

impl HoverCard {
    pub(in crate::ui) fn new(
        id: impl Into<ElementId>,
        trigger: impl FnOnce(bool) -> AnyElement + 'static,
        content: impl Fn(HoverCardDismiss, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            trigger: Box::new(trigger),
            content: Box::new(content),
        }
    }
}

#[derive(Clone)]
pub(in crate::ui) struct HoverCardDismiss(WeakEntity<HoverState>);
impl HoverCardDismiss {
    pub fn dismiss(&self, window: &mut Window, cx: &mut App) {
        let _ = self.0.update(cx, |state, cx| state.show(false, window, cx));
    }
}

#[derive(Default)]
struct HoverState {
    open: bool,
    over_trigger: bool,
    over_card: bool,
    timer: Option<Task<()>>,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    overlay: Option<DeferredPopover>,
}

impl HoverState {
    fn show(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.timer = None;
        self.open = open;
        self.overlay = if open {
            Some(GlobalState::register_deferred_popover(cx))
        } else {
            None
        };
        cx.notify();
        window.refresh();
    }

    fn hover(
        &mut self,
        trigger: bool,
        hovering: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if trigger {
            self.over_trigger = hovering;
        } else {
            self.over_card = hovering;
        }
        self.timer = None;
        if hovering && self.open {
            return;
        }
        let open = self.over_trigger || self.over_card;
        if open == self.open {
            return;
        }
        let delay = if open {
            motion::PERSON_OPEN
        } else {
            motion::PERSON_CLOSE
        };
        self.timer = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update_in(cx, |this, window, cx| this.show(open, window, cx));
        }));
    }
}

impl Render for HoverState {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

impl RenderOnce for HoverCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| HoverState::default());
        let open = state.read(cx).open;
        let bounds = state.read(cx).bounds.clone();
        let capture = bounds.clone();
        let mut root = div()
            .id(self.id)
            .child(
                div()
                    .id("hover-card-trigger")
                    .child((self.trigger)(open))
                    .on_click(window.listener_for(&state, |state, _, window, cx| {
                        state.show(false, window, cx)
                    })),
            )
            // A size-only absolute child keeps its static position after the row.
            // Pin the probe to the row's origin before applying viewport placement.
            .child(
                canvas(move |bounds, _, _| capture.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .inset_0()
                    .size_full(),
            )
            .on_hover(window.listener_for(&state, |state, hovered, window, cx| {
                state.hover(true, *hovered, window, cx)
            }));
        if state.read(cx).open {
            let p = Palette::get(cx);
            let dark = Theme::global(cx).is_dark();
            let surface = colors::hover_card_surface(p, dark);
            let content = div()
                .id("hover-card-content")
                .w(card::WIDTH.min(
                    (window.viewport_size().width - card::VIEWPORT_MARGIN * 2.).max(space::NONE),
                ))
                .max_h(card::MAX_HEIGHT.min(
                    (window.viewport_size().height - card::VIEWPORT_MARGIN * 2.).max(space::NONE),
                ))
                .border(space::HAIRLINE)
                .border_color(p.border)
                .rounded(radius::CARD)
                .bg(surface)
                .shadow(colors::hover_card_shadow(dark))
                .overflow_y_scroll()
                .on_hover(window.listener_for(&state, |state, hovered, window, cx| {
                    state.hover(false, *hovered, window, cx)
                }))
                .on_mouse_down_out(
                    window
                        .listener_for(&state, |state, _, window, cx| state.show(false, window, cx)),
                )
                .child((self.content)(
                    HoverCardDismiss(state.downgrade()),
                    window,
                    cx,
                ));
            root = root.child(
                deferred(PositionedCard {
                    anchor: bounds,
                    content: content.into_any_element(),
                })
                .with_priority(gpui_kit::base::POPUP_PRIORITY),
            );
        }
        root
    }
}

struct PositionedCard {
    anchor: Rc<Cell<Bounds<Pixels>>>,
    content: AnyElement,
}

impl IntoElement for PositionedCard {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for PositionedCard {
    type RequestLayoutState = LayoutId;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, LayoutId) {
        let child = self.content.request_layout(window, cx);
        let layout = window.request_layout(
            Style {
                position: Position::Absolute,
                display: Display::Flex,
                ..Default::default()
            },
            [child],
            cx,
        );
        (layout, child)
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut LayoutId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let anchor = self.anchor.get();
        let card = window.layout_bounds(*child).size;
        let viewport = window.viewport_size();
        let [x, y] = geometry::horizontal_first(
            geometry::Rect {
                left: anchor.left().into(),
                top: anchor.top().into(),
                width: anchor.size.width.into(),
                height: anchor.size.height.into(),
            },
            [card.width.into(), card.height.into()],
            [viewport.width.into(), viewport.height.into()],
            geometry::Placement {
                gap: card::ANCHOR_GAP.into(),
                viewport_padding: card::VIEWPORT_MARGIN.into(),
            },
        );
        let origin = point(px(x), px(y));
        window.insert_hitbox(Bounds::new(origin, card), HitboxBehavior::BlockMouse);
        window.with_element_offset(origin - bounds.origin, |window| {
            self.content.prepaint(window, cx)
        });
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut LayoutId,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.content.paint(window, cx);
    }
}
