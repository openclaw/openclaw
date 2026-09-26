use super::menu::popover;
use crate::ui::theme::{
    Palette,
    tokens::{MenuMetrics, colors, menu, radius, space},
};
use gpui_kit::{
    base::{Align, Placement, Positioner, StyledExt},
    component::{Side, Theme, button::Button, menu::PopupMenu},
    prelude::FluentBuilder,
    *,
};
use std::rc::Rc;

type MenuBuilder = Rc<dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu>;

#[derive(Clone, Copy)]
pub(crate) struct MenuSurfaceSpec {
    pub metrics: MenuMetrics,
    pub placement: Placement,
    pub horizontal_offset: Pixels,
    pub border_as_ring: bool,
}

impl MenuSurfaceSpec {
    pub fn below(metrics: MenuMetrics) -> Self {
        Self {
            metrics,
            placement: Placement::Bottom,
            horizontal_offset: space::NONE,
            border_as_ring: false,
        }
    }
    pub fn above(metrics: MenuMetrics) -> Self {
        Self {
            placement: Placement::Top,
            ..Self::below(metrics)
        }
    }
    pub fn horizontal_offset(mut self, offset: Pixels) -> Self {
        self.horizontal_offset = offset;
        self
    }
    pub fn outer_ring(mut self) -> Self {
        self.border_as_ring = true;
        self
    }
}

#[derive(Default)]
struct MenuHost {
    menu: Option<Entity<PopupMenu>>,
    subscription: Option<Subscription>,
    return_focus: Option<FocusHandle>,
    trigger_bounds: Bounds<Pixels>,
    open: bool,
}

impl MenuHost {
    fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.open = open;
        if !open {
            self.menu = None;
            self.subscription = None;
        }
        cx.notify();
    }
}

#[derive(IntoElement)]
pub(crate) struct MenuSurface {
    id: SharedString,
    trigger: Button,
    style: MenuSurfaceSpec,
    build: MenuBuilder,
}

/// PopupMenu owns selection, keyboard and submenu dismissal. This adapter
/// supplies the measured sidebar presentation and placement.
pub(crate) fn menu_surface(
    id: impl Into<SharedString>,
    trigger: Button,
    style: MenuSurfaceSpec,
    build: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
) -> MenuSurface {
    MenuSurface {
        id: id.into(),
        trigger,
        style,
        build: Rc::new(build),
    }
}

impl RenderOnce for MenuSurface {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let holder = window.use_keyed_state(
            SharedString::from(format!("menu-surface-state:{}", self.id)),
            cx,
            |_, _| MenuHost::default(),
        );
        if !holder.read(cx).open {
            let focus = window.focused(cx);
            holder.update(cx, |holder, _| holder.return_focus = focus);
        }
        let style = self.style;
        let button_style = self.trigger.style().clone();
        let trigger_style = StyleRefinement {
            position: button_style.position,
            inset: button_style.inset,
            size: button_style.size,
            min_size: button_style.min_size,
            max_size: button_style.max_size,
            margin: button_style.margin,
            align_self: button_style.align_self,
            flex_grow: button_style.flex_grow,
            flex_shrink: button_style.flex_shrink,
            flex_basis: button_style.flex_basis,
            ..Default::default()
        };
        let open_holder = holder.downgrade();
        let content_holder = holder.clone();
        let build = self.build;
        let parent_view = window.current_view();
        let popup = popover(
            SharedString::from(format!("menu-surface:{}", self.id)),
            Anchor::TopLeft,
            holder.read(cx).open,
            self.trigger,
            div().into_any_element(),
            move |open, _, cx| {
                let _ = open_holder.update(cx, |holder, cx| holder.set_open(open, cx));
                cx.notify(parent_view);
            },
        )
        // PopupMenu owns outside clicks across its entire submenu chain.
        .overlay_closable(false)
        .top(space::NONE)
        .content(move |_, window, cx| {
            let existing = content_holder.read(cx).menu.clone();
            let menu = existing.unwrap_or_else(|| {
                let build = build.clone();
                let return_focus = content_holder.read(cx).return_focus.clone();
                let menu = PopupMenu::build(window, cx, move |menu, window, cx| {
                    let extra_padding =
                        (style.metrics.padding - menu::NATIVE_PADDING).max(space::NONE);
                    let width = style.metrics.width - space::HAIRLINE * 2. - extra_padding * 2.;
                    build(menu, window, cx)
                        .min_w(width)
                        .max_w(width)
                        .max_h(style.metrics.max_height)
                        .scrollable(true)
                        .check_side(Side::Right)
                        .when_some(return_focus, |menu, focus| menu.action_context(focus))
                });
                let popover = cx.entity().downgrade();
                let subscription =
                    window.subscribe(&menu, cx, move |_, _: &DismissEvent, window, cx| {
                        let _ = popover.update(cx, |popover, cx| popover.dismiss(window, cx));
                        window.refresh();
                    });
                content_holder.update(cx, |holder, _| {
                    holder.menu = Some(menu.clone());
                    holder.subscription = Some(subscription);
                });
                menu.focus_handle(cx).focus(window, cx);
                menu
            });
            let p = Palette::sidebar(cx);
            let extra_padding = (style.metrics.padding - menu::NATIVE_PADDING).max(space::NONE);
            let mut shadows = colors::menu_shadow(Theme::global(cx).is_dark());
            if style.border_as_ring {
                shadows.insert(
                    0,
                    BoxShadow {
                        color: colors::overlay_border(p),
                        offset: point(space::NONE, space::NONE),
                        blur_radius: space::NONE,
                        spread_radius: space::HAIRLINE,
                        inset: false,
                    },
                );
            }
            let surface = div()
                .w(style.metrics.width)
                .border(space::HAIRLINE)
                .border_color(if style.border_as_ring {
                    transparent_black()
                } else {
                    colors::overlay_border(p)
                })
                .rounded(radius::ROW)
                .bg(p.elevated)
                .shadow(shadows)
                .p(extra_padding)
                .child(
                    div()
                        .rounded((radius::ROW - space::HAIRLINE - extra_padding).max(space::NONE))
                        .overflow_hidden()
                        .child(menu),
                );
            let mut trigger_bounds = content_holder.read(cx).trigger_bounds;
            trigger_bounds.origin.x += style.horizontal_offset;
            Positioner::side(trigger_bounds)
                .placement(style.placement)
                .align(Align::Start)
                .offset(menu::ANCHOR_GAP)
                .margin(menu::VIEWPORT_MARGIN)
                .occlude()
                .child(surface)
                .into_any_element()
        });
        div()
            .id(SharedString::from(format!(
                "menu-surface-trigger:{}",
                self.id
            )))
            .refine_style(&trigger_style)
            .child(
                canvas(
                    move |bounds, _, cx| {
                        holder.update(cx, |holder, _| holder.trigger_bounds = bounds);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0()
                .size_full(),
            )
            .child(popup)
            .into_any_element()
    }
}
