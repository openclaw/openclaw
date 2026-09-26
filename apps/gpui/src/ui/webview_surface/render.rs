use super::*;

impl WebViewSurface {
    pub fn element(&self) -> AnyElement {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            if let Some(error) = self.0.borrow().error.clone() {
                if self.0.borrow().spec.background {
                    return div().into_any_element();
                }
                return div()
                    .size_full()
                    .p(crate::ui::theme::tokens::space::REM_LG)
                    .child(error)
                    .into_any_element();
            }
            use gpui_kit::component::{Sizable, StyledExt, spinner::Spinner};
            let palette =
                crate::ui::theme::Palette::for_dark(self.0.borrow().dark.unwrap_or(false));
            let background = self.0.borrow().spec.background;
            let blank = self.0.borrow().spec.auth.is_none()
                && self.0.borrow().events.presentation.borrow().url == "about:blank";
            // The native view can mask itself from an IPC callback before GPUI's
            // next render; this placeholder is always ready beneath its layer.
            let placeholder = div()
                .size_full()
                .v_flex()
                .items_center()
                .justify_center()
                .gap(crate::ui::theme::tokens::space::REM_MD)
                .bg(palette.bg)
                .text_color(palette.muted)
                .when(!blank, |el| {
                    el.child(Spinner::new().small().color(palette.muted))
                })
                .child(if blank {
                    "Open a link or enter a URL above."
                } else {
                    "Loading…"
                });
            let state = self.0.clone();
            let surface = canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    // Platform construction/cookie completion can pump the native
                    // event loop. Do not retain a borrow across a nested paint.
                    let create = {
                        let mut state = state.borrow_mut();
                        if state.view.is_none()
                            && state.error.is_none()
                            && !state.creating
                            && !state.retired
                        {
                            state.creating = true;
                            Some((
                                state.spec.clone(),
                                state.store.clone(),
                                state.events.clone(),
                            ))
                        } else {
                            None
                        }
                    };
                    if let Some((spec, store, events)) = create {
                        let result = native::build(&spec, &store, &events, bounds, window);
                        let mut state = state.borrow_mut();
                        state.creating = false;
                        match result {
                            Ok(view) if !state.retired => {
                                state.events.mask.borrow_mut().attach(&view);
                                if let Some(dark) = state.dark {
                                    native::set_dark(&view, dark);
                                }
                                // Nested platform paint may have updated desired visibility
                                // while construction was pumping the native event loop.
                                state.visible = false;
                                state.view = Some(view);
                                let _ = state.events.wake.try_send(());
                            }
                            Ok(view) => {
                                native::retire(view, false);
                            }
                            Err(error) => {
                                log::warn!("webview_create failed: {error}");
                                state.events.push(WebViewEvent::Error(error.clone()));
                                state.error = Some(error);
                            }
                        }
                    }
                    let mut state = state.borrow_mut();
                    let bounds = SurfaceBounds::from(bounds).pixel_aligned(window.scale_factor());
                    if state.bounds != Some(bounds)
                        || state.scale_factor != Some(window.scale_factor())
                    {
                        state.bounds = Some(bounds);
                        state.scale_factor = Some(window.scale_factor());
                        state.events.viewport.set((bounds.width, bounds.height));
                        state.events.presentation.borrow_mut().ready = false;
                        state.events.mask();
                        if let Some(view) = &state.view {
                            native::set_bounds(view, bounds);
                            native::request_presentation(view);
                        }
                    }
                    use gpui_kit::component::{GlobalState, Root, WindowExt};
                    let native_overlay = GlobalState::is_in_deferred_context(cx)
                        || window.has_active_dialog(cx)
                        || window.has_active_sheet(cx)
                        || !Root::read(window, cx)
                            .notification
                            .read(cx)
                            .notifications()
                            .is_empty();
                    let visible = !native_overlay
                        && surface_visible(
                            state.present,
                            background || state.spec.background,
                            bounds,
                            &state.overlays,
                        );
                    let presentation = state.events.presentation.borrow();
                    let ready = presentation.ready;
                    let revealable = presentation.revealable();
                    drop(presentation);
                    if let Some(view) = &state.view
                        && let Err(error) = native::present(
                            view,
                            visible || state.spec.background,
                            visible && revealable,
                        )
                    {
                        state.events.push(WebViewEvent::Error(error.clone()));
                        state.error = Some(error);
                        return;
                    }
                    state.visible = visible && revealable;
                    if visible && ready {
                        state.events.revealed();
                    }
                },
            )
            .size_full();
            if background {
                surface.into_any_element()
            } else {
                div()
                    .relative()
                    .size_full()
                    .child(placeholder)
                    .child(div().absolute().inset_0().size_full().child(surface))
                    .into_any_element()
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let url = self.0.borrow().spec.url.clone();
            div()
                .id("webview-linux-stub")
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .child("Open in browser")
                .on_click(move |_, _, cx| cx.open_url(&url))
                .into_any_element()
        }
    }
}
