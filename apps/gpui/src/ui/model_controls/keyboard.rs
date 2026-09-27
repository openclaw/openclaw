use super::*;

impl AppView {
    pub(super) fn model_picker_choices(&self, cx: &App) -> Vec<(usize, PickerMenuRow)> {
        self.model_controls
            .target
            .as_ref()
            .map(|target| {
                self.picker_menu_entries(target, cx)
                    .into_iter()
                    .enumerate()
                    .filter_map(|(index, entry)| match entry {
                        PickerMenuEntry::Row(row) if !row.disabled => Some((index, row)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn picker_is_composing(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.model_controls
            .search
            .focus_handle(cx)
            .is_focused(window)
            && self.model_controls.search.update(cx, |search, cx| {
                search.marked_text_range(window, cx).is_some()
            })
    }

    pub(super) fn confirm_model_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_controls.menu_focus.is_focused(window)
            && !self
                .model_controls
                .search
                .focus_handle(cx)
                .is_focused(window)
        {
            return;
        }
        if self.picker_is_composing(window, cx) {
            return;
        }
        if let Some(target) = self.model_controls.target.clone() {
            let choices = self.model_picker_choices(cx);
            if let Some((_, row)) = choices.get(
                self.model_controls
                    .highlight
                    .min(choices.len().saturating_sub(1)),
            ) {
                self.activate_picker_row(&target, row, window, cx);
            }
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    pub(super) fn escape_model_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker_is_composing(window, cx) {
            return;
        }
        if self
            .model_controls
            .search
            .focus_handle(cx)
            .is_focused(window)
            && !self.model_controls.search.read(cx).value().is_empty()
        {
            self.model_controls
                .search
                .update(cx, |search, cx| search.set_value("", window, cx));
            self.reset_model_picker_highlight(cx);
        } else {
            self.model_controls.close_popups();
            self.model_controls.trigger_focus.focus(window, cx);
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    pub(super) fn move_model_picker(
        &mut self,
        offset: isize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker_is_composing(window, cx) {
            return;
        }
        let choices = self.model_picker_choices(cx);
        if !choices.is_empty() {
            let current = self.model_controls.highlight.min(choices.len() - 1);
            self.model_controls.highlight =
                (current as isize + offset).rem_euclid(choices.len() as isize) as usize;
            self.model_controls
                .menu_scroll
                .scroll_to_item(choices[self.model_controls.highlight].0);
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    pub(super) fn model_picker_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker_is_composing(window, cx) {
            return;
        }
        let focused = self
            .model_controls
            .search
            .focus_handle(cx)
            .is_focused(window);
        match event.keystroke.key.as_str() {
            "escape" => self.escape_model_picker(window, cx),
            "down" => self.move_model_picker(1, window, cx),
            "up" => self.move_model_picker(-1, window, cx),
            "enter" => self.confirm_model_picker(window, cx),
            key => {
                let choices = self.model_picker_choices(cx);
                if focused || choices.is_empty() {
                    return;
                }
                let choose = match key {
                    "home" => {
                        self.model_controls.highlight = 0;
                        false
                    }
                    "end" => {
                        self.model_controls.highlight = choices.len() - 1;
                        false
                    }
                    _ => {
                        let Ok(number) = key.parse::<usize>() else {
                            return;
                        };
                        if number == 0 || number > choices.len().min(9) {
                            return;
                        }
                        self.model_controls.highlight = number - 1;
                        true
                    }
                };
                self.model_controls
                    .menu_scroll
                    .scroll_to_item(choices[self.model_controls.highlight].0);
                if choose && let Some(target) = self.model_controls.target.clone() {
                    self.activate_picker_row(
                        &target,
                        &choices[self.model_controls.highlight].1,
                        window,
                        cx,
                    );
                }
                window.prevent_default();
                cx.stop_propagation();
                cx.notify();
            }
        }
    }
}
