use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{
    base::{
        SliderTrack,
        slider::{SliderEvent, SliderState},
    },
    prelude::FluentBuilder as _,
    *,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy)]
pub(crate) enum SliderBoost {
    Maximum,
    Ultra,
}

pub(crate) struct SliderStop {
    pub boost: Option<SliderBoost>,
}

pub(crate) struct DiscreteSliderConfig {
    pub stops: Vec<SliderStop>,
    pub selected: Option<usize>,
    pub preview: Option<usize>,
    pub inherited: bool,
    pub disabled: bool,
    pub label: &'static str,
    pub description: String,
}

type SliderCallback = Rc<dyn Fn(&usize, &mut Window, &mut App)>;
#[derive(Default)]
struct Callbacks {
    preview: Option<SliderCallback>,
    commit: Option<SliderCallback>,
}
struct SliderBinding {
    state: Entity<SliderState>,
    callbacks: Rc<RefCell<Callbacks>>,
    _subscription: Subscription,
}

/// A controlled discrete slider. Base SliderState/SliderTrack own pointer mapping and drag lifecycle.
#[derive(IntoElement)]
pub(crate) struct DiscreteSlider {
    id: SharedString,
    config: DiscreteSliderConfig,
    focus: FocusHandle,
    callbacks: Callbacks,
}

impl DiscreteSlider {
    pub fn new(
        id: impl Into<SharedString>,
        config: DiscreteSliderConfig,
        focus: &FocusHandle,
    ) -> Self {
        Self {
            id: id.into(),
            config,
            focus: focus.clone(),
            callbacks: Callbacks::default(),
        }
    }
    pub fn on_preview(
        mut self,
        callback: impl Fn(&usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callbacks.preview = Some(Rc::new(callback));
        self
    }
    pub fn on_commit(mut self, callback: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
        self.callbacks.commit = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for DiscreteSlider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let binding = window.use_keyed_state(
            SharedString::from(format!("discrete-slider-state:{}", self.id)),
            cx,
            |window, cx| {
                let state = cx.new(|_| SliderState::new());
                let callbacks = Rc::new(RefCell::new(Callbacks::default()));
                let callback_owner = callbacks.clone();
                let subscription =
                    window.subscribe(&state, cx, move |_, event: &SliderEvent, window, cx| {
                        let callbacks = callback_owner.borrow();
                        let (value, callback) = match event {
                            SliderEvent::Change(value) => (value, callbacks.preview.as_ref()),
                            SliderEvent::Release(value) => (value, callbacks.commit.as_ref()),
                        };
                        if let Some(callback) = callback {
                            callback(&(value.end().round() as usize), window, cx);
                        }
                    });
                SliderBinding {
                    state,
                    callbacks,
                    _subscription: subscription,
                }
            },
        );
        let slider = binding.read(cx).state.clone();
        *binding.read(cx).callbacks.borrow_mut() = self.callbacks;
        let count = self.config.stops.len();
        let selected = self.config.preview.or(self.config.selected).unwrap_or(0);
        let max = count.saturating_sub(1) as f32;
        slider.update(cx, |state, cx| {
            if state.max_value() != max {
                *state = SliderState::new().max(max).default_value(selected as f32);
            } else if state.value().end() != selected as f32 {
                state.set_value(selected as f32, window, cx);
            }
        });
        let p = Palette::get(cx);
        let colors = p.controls();
        let fraction = selected as f32 / (count - 1) as f32;
        let anchored = self.config.selected.is_some() || self.config.preview.is_some();
        let boost = anchored
            .then(|| self.config.stops[selected].boost)
            .flatten();
        let boosted = boost.is_some();
        let ultra = matches!(boost, Some(SliderBoost::Ultra));
        let thumb = if !self.config.inherited || self.config.preview.is_some() {
            p.strong
        } else {
            p.muted
        };
        let thumb = if anchored {
            thumb
        } else {
            thumb.opacity(t::UNANCHORED_OPACITY)
        };
        let focus = self.focus.clone();
        let focus_pointer = self.focus.clone();
        let bounds_state = slider.clone();
        let disabled = self.config.disabled;
        let current = self.config.selected.unwrap_or(0);
        let last = count.saturating_sub(1);
        let keyboard = binding.read(cx).callbacks.borrow().commit.clone();
        let increment = keyboard.clone();
        let decrement = keyboard.clone();
        div()
            .id(self.id)
            .role(Role::Slider)
            .aria_label(self.config.label)
            .aria_numeric_value(selected as f64)
            .aria_min_numeric_value(0.)
            .aria_max_numeric_value(max as f64)
            .aria_numeric_value_step(1.)
            .aria_description(self.config.description)
            .track_focus(&self.focus)
            .tab_index(0)
            .mx(px(t::SPACE_SM))
            .h(px(t::SLIDER_HEIGHT))
            .w(px(t::SLIDER_WIDTH))
            .rounded_full()
            .when(disabled, |root| root.opacity(t::DISABLED_OPACITY))
            .when(boosted, |root| {
                root.shadow(vec![BoxShadow {
                    inset: false,
                    color: if ultra {
                        colors.ultra_glow
                    } else {
                        colors.boost_glow
                    },
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(if ultra {
                        t::SLIDER_ULTRA_BLUR
                    } else {
                        t::SLIDER_BOOST_BLUR
                    }),
                    spread_radius: px(0.),
                }])
            })
            .child(
                SliderTrack::new(&slider)
                    .disabled(disabled)
                    .size_full()
                    .capture_any_mouse_down(move |_, window, cx| {
                        if !disabled {
                            focus_pointer.focus(window, cx);
                        }
                    })
                    .child(
                        canvas(
                            move |bounds, _, cx| {
                                bounds_state.update(cx, |state, _| {
                                    state.set_bounds(Bounds::new(
                                        point(
                                            bounds.left() + px(t::SLIDER_THUMB_WIDTH / 2.),
                                            bounds.top(),
                                        ),
                                        size(
                                            bounds.size.width - px(t::SLIDER_THUMB_WIDTH),
                                            bounds.size.height,
                                        ),
                                    ))
                                });
                            },
                            move |bounds, _, window, _| {
                                let track_bg = if boosted {
                                    p.accent
                                } else {
                                    colors.slider_track
                                };
                                if boosted {
                                    let center = if ultra {
                                        colors.ultra_center
                                    } else {
                                        colors.boost_center
                                    };
                                    let half = bounds.size.width / 2.;
                                    for (offset, from, to, left) in [
                                        (px(0.), p.accent, center, true),
                                        (half, center, p.accent, false),
                                    ] {
                                        let radii = Corners {
                                            top_left: if left {
                                                px(t::SLIDER_RADIUS)
                                            } else {
                                                px(0.)
                                            },
                                            bottom_left: if left {
                                                px(t::SLIDER_RADIUS)
                                            } else {
                                                px(0.)
                                            },
                                            top_right: if left {
                                                px(0.)
                                            } else {
                                                px(t::SLIDER_RADIUS)
                                            },
                                            bottom_right: if left {
                                                px(0.)
                                            } else {
                                                px(t::SLIDER_RADIUS)
                                            },
                                        };
                                        let rect = Bounds::new(
                                            point(bounds.left() + offset, bounds.top()),
                                            size(half, bounds.size.height),
                                        );
                                        window.paint_quad(
                                            fill(
                                                rect,
                                                linear_gradient(
                                                    t::SLIDER_GRADIENT_ANGLE,
                                                    linear_color_stop(from, 0.),
                                                    linear_color_stop(to, 1.),
                                                ),
                                            )
                                            .corner_radii(radii),
                                        );
                                    }
                                } else {
                                    window.paint_quad(rounded_fill(
                                        bounds,
                                        px(t::SLIDER_RADIUS),
                                        track_bg,
                                    ));
                                }
                                if !boosted && fraction > 0. {
                                    window.paint_quad(rounded_fill(
                                        Bounds::new(
                                            bounds.origin,
                                            size(bounds.size.width * fraction, bounds.size.height),
                                        ),
                                        px(t::SLIDER_RADIUS),
                                        colors.slider_fill,
                                    ));
                                }
                                if boosted {
                                    window.paint_quad(
                                        outline(
                                            bounds,
                                            if ultra {
                                                colors.ultra_border
                                            } else {
                                                colors.boost_border
                                            },
                                            BorderStyle::Solid,
                                        )
                                        .corner_radii(px(t::SLIDER_RADIUS)),
                                    );
                                }
                                for index in 0..count {
                                    let x = bounds.left()
                                        + px(t::SLIDER_DOT_INSET)
                                        + (bounds.size.width - px(t::SLIDER_DOT_INSET * 2.))
                                            * index as f32
                                            / (count - 1) as f32;
                                    window.paint_quad(rounded_fill(
                                        Bounds::new(
                                            point(
                                                x - px(t::SLIDER_DOT_SIZE / 2.),
                                                bounds.top() + px(t::SLIDER_DOT_TOP),
                                            ),
                                            size(px(t::SLIDER_DOT_SIZE), px(t::SLIDER_DOT_SIZE)),
                                        ),
                                        px(t::SLIDER_DOT_SIZE / 2.),
                                        colors.slider_dot,
                                    ));
                                }
                                let x = bounds.left()
                                    + (bounds.size.width - px(t::SLIDER_THUMB_WIDTH)) * fraction;
                                let thumb_bounds = Bounds::new(
                                    point(x, bounds.top() + px(t::SLIDER_THUMB_INSET)),
                                    size(px(t::SLIDER_THUMB_WIDTH), px(t::SLIDER_THUMB_HEIGHT)),
                                );
                                window.paint_quad(rounded_fill(
                                    thumb_bounds,
                                    px(t::SLIDER_THUMB_RADIUS),
                                    thumb,
                                ));
                                if focus.is_focused(window) {
                                    window.paint_quad(
                                        outline(
                                            thumb_bounds.dilate(px(t::SLIDER_FOCUS_OUTSET)),
                                            p.accent,
                                            BorderStyle::Solid,
                                        )
                                        .corner_radii(px(t::SLIDER_FOCUS_RADIUS)),
                                    );
                                }
                            },
                        )
                        .size_full(),
                    ),
            )
            .when(!disabled, |root| {
                root.on_mouse_up(
                    MouseButton::Left,
                    window.listener_for(&slider, |state, _, _, cx| state.handle_release(cx)),
                )
                .on_mouse_up_out(
                    MouseButton::Left,
                    window.listener_for(&slider, |state, _, _, cx| state.handle_release(cx)),
                )
                .on_key_down(move |event: &KeyDownEvent, window, cx| {
                    let next = match event.keystroke.key.as_str() {
                        "left" | "down" => current.saturating_sub(1),
                        "right" | "up" => (current + 1).min(last),
                        "home" | "pagedown" => 0,
                        "end" | "pageup" => last,
                        _ => return,
                    };
                    if let Some(callback) = &keyboard {
                        callback(&next, window, cx);
                    }
                    window.prevent_default();
                    cx.stop_propagation();
                })
                .on_a11y_action(AccessibleAction::Increment, move |_, window, cx| {
                    if let Some(callback) = &increment {
                        callback(&(current + 1).min(last), window, cx);
                    }
                })
                .on_a11y_action(
                    AccessibleAction::Decrement,
                    move |_, window, cx| {
                        if let Some(callback) = &decrement {
                            callback(&current.saturating_sub(1), window, cx);
                        }
                    },
                )
            })
    }
}

fn rounded_fill(bounds: Bounds<Pixels>, radius: Pixels, color: Hsla) -> PaintQuad {
    fill(bounds, color).corner_radii(radius)
}
