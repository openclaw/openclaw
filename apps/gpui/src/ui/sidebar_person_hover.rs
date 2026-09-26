use gpui_kit::{
    base::{DeferredPopover, GlobalState},
    component::Theme,
    *,
};
use std::{cell::Cell, rc::Rc, time::Duration};

use crate::model::person_card as geometry;

type CardContent = Box<dyn Fn(&mut Window, &mut App) -> AnyElement>;

#[derive(IntoElement)]
pub(in crate::ui) struct PersonHoverCard {
    id: ElementId,
    trigger: AnyElement,
    content: CardContent,
}

impl PersonHoverCard {
    pub(in crate::ui) fn new(
        id: impl Into<ElementId>,
        trigger: impl IntoElement,
        content: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            trigger: trigger.into_any_element(),
            content: Box::new(content),
        }
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
        let delay = Duration::from_millis(if open { 450 } else { 220 });
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

impl RenderOnce for PersonHoverCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| HoverState::default());
        let bounds = state.read(cx).bounds.clone();
        let capture = bounds.clone();
        let mut root = div()
            .id(self.id)
            .child(self.trigger)
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
            let p = super::theme::Palette::sidebar(cx);
            let dark = Theme::global(cx).is_dark();
            let surface = if dark {
                p.card.blend(Hsla {
                    a: 0.06,
                    ..rgb(0).into()
                })
            } else {
                p.card
            };
            let content = div()
                .id("person-hover-content")
                .w(px(304.).min((window.viewport_size().width - px(24.)).max(px(0.))))
                .max_h(px(520.).min((window.viewport_size().height - px(24.)).max(px(0.))))
                .border_1()
                .border_color(p.border)
                .rounded(px(14.))
                .bg(surface)
                .shadow(vec![BoxShadow {
                    color: if dark {
                        rgba(0x00000066).into()
                    } else {
                        rgba(0x3c2a1817).into()
                    },
                    offset: point(px(0.), px(12.)),
                    blur_radius: px(if dark { 32. } else { 28. }),
                    spread_radius: px(0.),
                    inset: false,
                }])
                .overflow_y_scroll()
                .on_hover(window.listener_for(&state, |state, hovered, window, cx| {
                    state.hover(false, *hovered, window, cx)
                }))
                .on_mouse_down_out(
                    window
                        .listener_for(&state, |state, _, window, cx| state.show(false, window, cx)),
                )
                .child((self.content)(window, cx));
            root = root.child(
                deferred(PositionedCard {
                    anchor: bounds,
                    content: content.into_any_element(),
                })
                .with_priority(100),
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
        let [x, y] = geometry::position(
            geometry::Rect {
                left: anchor.left().into(),
                top: anchor.top().into(),
                width: anchor.size.width.into(),
                height: anchor.size.height.into(),
            },
            [card.width.into(), card.height.into()],
            [viewport.width.into(), viewport.height.into()],
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
