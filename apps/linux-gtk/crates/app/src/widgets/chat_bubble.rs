use gtk4::prelude::*;
use gtk4::{self, Align, Orientation};

/// A chat message bubble widget.
pub struct ChatBubble;

impl ChatBubble {
    /// Create a bubble for a user message (right-aligned, accent color).
    pub fn new_user(text: &str) -> gtk4::Box {
        let outer = gtk4::Box::new(Orientation::Horizontal, 0);
        outer.set_halign(Align::End);
        outer.set_margin_bottom(4);

        let inner = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .css_classes(["chat-bubble", "user-bubble"])
            .margin_start(48)
            .build();

        let label = gtk4::Label::builder()
            .label(text)
            .wrap(true)
            .xalign(0.0)
            .selectable(true)
            .build();

        inner.append(&label);
        outer.append(&inner);
        outer
    }

    /// Create a bubble for an assistant message (left-aligned).
    #[allow(dead_code)]
    pub fn new_assistant(text: &str, agent_name: Option<&str>) -> gtk4::Box {
        let outer = gtk4::Box::new(Orientation::Horizontal, 0);
        outer.set_halign(Align::Start);
        outer.set_margin_bottom(4);

        let inner = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .css_classes(["chat-bubble", "assistant-bubble"])
            .margin_end(48)
            .build();

        if let Some(name) = agent_name {
            let header = gtk4::Label::builder()
                .label(name)
                .css_classes(["caption", "dim-label"])
                .xalign(0.0)
                .margin_bottom(4)
                .build();
            inner.append(&header);
        }

        let label = gtk4::Label::builder()
            .label(text)
            .wrap(true)
            .xalign(0.0)
            .selectable(true)
            .use_markup(true)
            .build();

        inner.append(&label);
        outer.append(&inner);
        outer
    }

    /// Create a system/info bubble (centered, subtle).
    #[allow(dead_code)]
    pub fn new_system(text: &str) -> gtk4::Box {
        let outer = gtk4::Box::new(Orientation::Horizontal, 0);
        outer.set_halign(Align::Center);
        outer.set_margin_bottom(4);

        let label = gtk4::Label::builder()
            .label(text)
            .css_classes(["caption", "dim-label"])
            .wrap(true)
            .build();

        outer.append(&label);
        outer
    }
}
