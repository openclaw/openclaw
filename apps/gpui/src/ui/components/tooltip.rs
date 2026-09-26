use gpui_kit::{component::tooltip::Tooltip, *};
// Search retires rows without pointer leave events. Element-owned tooltips retire with them.
pub(crate) trait ElementTooltip: InteractiveElement + Sized {
    fn element_tooltip(mut self, text: impl Into<SharedString>) -> Self {
        let text = text.into();
        self.interactivity()
            .tooltip(move |window, cx| Tooltip::new(text.clone()).build(window, cx));
        self
    }
}
impl<T: InteractiveElement> ElementTooltip for T {}
