use gtk4::prelude::*;
use gtk4::{self, Orientation};

pub struct AboutView {
    container: gtk4::Box,
}

impl AboutView {
    pub fn new() -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        let scroll = gtk4::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .build();

        let content = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(16)
            .margin_start(32)
            .margin_end(32)
            .margin_top(48)
            .margin_bottom(48)
            .valign(gtk4::Align::Center)
            .halign(gtk4::Align::Center)
            .build();

        // Logo / title
        let title = gtk4::Label::builder()
            .label("OpenClaw")
            .css_classes(vec!["title-1".to_string()])
            .build();

        let version = gtk4::Label::builder()
            .label(format!("Desktop v{}", env!("CARGO_PKG_VERSION")))
            .css_classes(vec!["dim-label".to_string()])
            .build();

        let tagline = gtk4::Label::builder()
            .label("Your AI agents, on your terms.")
            .css_classes(vec!["title-4".to_string()])
            .margin_top(8)
            .build();

        content.append(&title);
        content.append(&version);
        content.append(&tagline);

        // Separator
        content.append(
            &gtk4::Separator::builder()
                .margin_top(16)
                .margin_bottom(16)
                .build(),
        );

        // Tech stack
        let tech = gtk4::Label::builder()
            .label("Built with Rust + GTK4 + Libadwaita")
            .css_classes(vec!["dim-label".to_string()])
            .build();
        content.append(&tech);

        let powered = gtk4::Label::builder()
            .label("Gateway powered by OpenClaw")
            .css_classes(vec!["dim-label".to_string()])
            .build();
        content.append(&powered);

        // Silly footer
        content.append(
            &gtk4::Separator::builder()
                .margin_top(16)
                .margin_bottom(8)
                .build(),
        );

        let footer = gtk4::Label::builder()
            .label("Made with \u{1F980} and \u{2615} by the OpenClaw contributors")
            .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
            .build();
        content.append(&footer);

        let github = gtk4::LinkButton::builder()
            .label("github.com/openclaw/openclaw")
            .uri("https://github.com/openclaw/openclaw")
            .margin_top(4)
            .build();
        content.append(&github);

        let clamp = libadwaita::Clamp::builder()
            .maximum_size(500)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));
        container.append(&scroll);

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
