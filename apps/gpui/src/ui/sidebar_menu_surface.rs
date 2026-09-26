use super::theme::Palette;
use gpui_kit::{
    base::{Align, Placement, Positioner, StyledExt},
    component::{Side, Theme, button::Button, menu::PopupMenu, popover::Popover},
    prelude::FluentBuilder,
    *,
};
use std::rc::Rc;

type MenuBuilder = Rc<dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu>;

#[derive(Clone, Copy)]
pub(super) enum SidebarMenuPlacement {
    Below,
    Above,
}

#[derive(Clone, Copy)]
pub(super) struct SidebarMenuStyle {
    pub width: f32,
    pub max_height: f32,
    pub padding: f32,
    pub placement: SidebarMenuPlacement,
    pub horizontal_offset: f32,
    pub border_as_ring: bool,
}

impl SidebarMenuStyle {
    pub fn below(width: f32, max_height: f32) -> Self {
        Self {
            width,
            max_height,
            padding: 4.,
            placement: SidebarMenuPlacement::Below,
            horizontal_offset: 0.,
            border_as_ring: false,
        }
    }

    pub fn identity() -> Self {
        Self {
            width: 278.,
            max_height: 600.,
            padding: 6.,
            placement: SidebarMenuPlacement::Above,
            horizontal_offset: -8.,
            border_as_ring: true,
        }
    }
}

#[derive(Default)]
struct SidebarMenuHost {
    menu: Option<Entity<PopupMenu>>,
    subscription: Option<Subscription>,
    return_focus: Option<FocusHandle>,
    trigger_bounds: Bounds<Pixels>,
    open: bool,
}

#[derive(IntoElement)]
pub(super) struct SidebarMenuSurface {
    id: SharedString,
    trigger: Button,
    style: SidebarMenuStyle,
    build: MenuBuilder,
}

/// The native menu retains its item, selection, keyboard and dismissal owners.
/// This adapter supplies only the measured sidebar surface and placement.
pub(super) fn sidebar_menu_surface(
    id: impl Into<SharedString>,
    trigger: Button,
    style: SidebarMenuStyle,
    build: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
) -> SidebarMenuSurface {
    SidebarMenuSurface {
        id: id.into(),
        trigger,
        style,
        build: Rc::new(build),
    }
}

impl RenderOnce for SidebarMenuSurface {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let holder = window.use_keyed_state(
            SharedString::from(format!("sidebar-menu-state:{}", self.id)),
            cx,
            |_, _| SidebarMenuHost::default(),
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
        let popup = Popover::new(SharedString::from(format!("sidebar-menu:{}", self.id)))
            .appearance(false)
            .overlay_closable(false)
            .trigger(self.trigger)
            .top(px(0.))
            .on_open_change(move |open, _, cx| {
                let _ = open_holder.update(cx, |holder, _| {
                    holder.open = *open;
                    if !open {
                        holder.menu = None;
                        holder.subscription = None;
                    }
                });
            })
            .content(move |_, window, cx| {
                let existing = content_holder.read(cx).menu.clone();
                let menu = existing.unwrap_or_else(|| {
                    let build = build.clone();
                    let return_focus = content_holder.read(cx).return_focus.clone();
                    let extra_padding = (style.padding - 4.).max(0.);
                    let menu_width = style.width - 2. - 2. * extra_padding;
                    let menu = PopupMenu::build(window, cx, move |menu, window, cx| {
                        build(menu, window, cx)
                            .min_w(px(menu_width))
                            .max_w(px(menu_width))
                            .max_h(px(style.max_height))
                            .scrollable(true)
                            .check_side(Side::Right)
                            .when_some(return_focus, |menu, focus| menu.action_context(focus))
                    });
                    menu.focus_handle(cx).focus(window, cx);
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
                    menu
                });
                let p = Palette::sidebar(cx);
                let extra_padding = (style.padding - 4.).max(0.);
                let dark = Theme::global(cx).is_dark();
                let shadow_color: Hsla = if dark {
                    rgb(0x000000).into()
                } else {
                    rgb(0x3c2a18).into()
                };
                let mut shadows = vec![
                    BoxShadow {
                        color: shadow_color.opacity(if dark { 0.18 } else { 0.035 }),
                        offset: point(px(0.), px(1.)),
                        blur_radius: px(2.),
                        spread_radius: px(0.),
                        inset: false,
                    },
                    BoxShadow {
                        color: shadow_color.opacity(if dark { 0.24 } else { 0.065 }),
                        offset: point(px(0.), px(8.)),
                        blur_radius: px(24.),
                        spread_radius: px(0.),
                        inset: false,
                    },
                ];
                if style.border_as_ring {
                    shadows.insert(
                        0,
                        BoxShadow {
                            color: p.border_strong.opacity(0.64),
                            offset: point(px(0.), px(0.)),
                            blur_radius: px(0.),
                            spread_radius: px(1.),
                            inset: false,
                        },
                    );
                }
                let surface = div()
                    .w(px(style.width))
                    .border_1()
                    .border_color(if style.border_as_ring {
                        transparent_black()
                    } else {
                        p.border_strong.opacity(0.64)
                    })
                    .rounded(px(12.5))
                    .bg(p.elevated)
                    .shadow(shadows)
                    .p(px(extra_padding))
                    .child(
                        div()
                            .rounded(px((12.5 - 1. - extra_padding).max(0.)))
                            .overflow_hidden()
                            .child(menu),
                    );
                let mut trigger_bounds = content_holder.read(cx).trigger_bounds;
                trigger_bounds.origin.x += px(style.horizontal_offset);
                Positioner::side(trigger_bounds)
                    .placement(match style.placement {
                        SidebarMenuPlacement::Below => Placement::Bottom,
                        SidebarMenuPlacement::Above => Placement::Top,
                    })
                    .align(Align::Start)
                    .offset(px(10.))
                    .margin(px(8.))
                    .occlude()
                    .child(surface)
            });
        div()
            .id(SharedString::from(format!(
                "sidebar-menu-trigger:{}",
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
    }
}
