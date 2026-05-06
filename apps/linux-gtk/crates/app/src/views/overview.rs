use gtk4::{self, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::AppState;

pub struct OverviewView {
    container: gtk4::Box,
}

impl OverviewView {
    pub fn new(state: AppState) -> Self {
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
            .spacing(24)
            .margin_start(32)
            .margin_end(32)
            .margin_top(24)
            .margin_bottom(24)
            .build();

        // Status cards row
        let cards_row = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(16)
            .homogeneous(true)
            .build();

        let agent_card = Self::build_stat_card("Agents", "0", "system-users-symbolic");
        let session_card = Self::build_stat_card("Sessions", "0", "view-list-symbolic");
        let channel_card = Self::build_stat_card("Channels", "0", "network-transmit-symbolic");
        let status_card = Self::build_stat_card("Status", "Connecting...", "network-idle-symbolic");

        cards_row.append(&agent_card);
        cards_row.append(&session_card);
        cards_row.append(&channel_card);
        cards_row.append(&status_card);
        content.append(&cards_row);

        // Gateway info group
        let info_group = adw::PreferencesGroup::builder()
            .title("Gateway")
            .description("Connection and runtime information")
            .build();

        let version_row = adw::ActionRow::builder()
            .title("Version")
            .subtitle("--")
            .build();
        info_group.add(&version_row);

        let uptime_row = adw::ActionRow::builder()
            .title("Connection")
            .subtitle("Waiting...")
            .build();
        info_group.add(&uptime_row);

        content.append(&info_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(800)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));
        container.append(&scroll);

        // Poll state for live updates
        let s = state;
        let ac = agent_card;
        let sc2 = session_card;
        let cc = channel_card;
        let stc = status_card;
        let vr = version_row;
        let ur = uptime_row;
        gtk4::glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if s.is_connected() {
                Self::update_stat_value(&ac, &format!("{}", s.agents().len()));
                Self::update_stat_value(&sc2, &format!("{}", s.sessions().len()));
                Self::update_stat_value(&cc, &format!("{}", s.channels().len()));
                Self::update_stat_value(&stc, "Online");
                vr.set_subtitle(&format!("v{}", s.server_version()));
                ur.set_subtitle("Connected");
            } else {
                Self::update_stat_value(&stc, "Offline");
                ur.set_subtitle("Disconnected");
            }
            gtk4::glib::ControlFlow::Continue
        });

        Self { container }
    }

    fn build_stat_card(title: &str, value: &str, icon: &str) -> gtk4::Box {
        let card = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .css_classes(vec!["card".to_string()])
            .build();

        // Use a frame-like styling
        let inner = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .margin_start(16)
            .margin_end(16)
            .margin_top(16)
            .margin_bottom(16)
            .build();

        let header = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .build();

        header.append(&gtk4::Image::from_icon_name(icon));
        header.append(
            &gtk4::Label::builder()
                .label(title)
                .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
                .build(),
        );

        let value_label = gtk4::Label::builder()
            .label(value)
            .css_classes(vec!["title-2".to_string()])
            .halign(gtk4::Align::Start)
            .name("stat-value")
            .build();

        inner.append(&header);
        inner.append(&value_label);
        card.append(&inner);
        card
    }

    fn update_stat_value(card: &gtk4::Box, value: &str) {
        // Find the value label inside the card (inner > value_label)
        if let Some(inner) = card.first_child() {
            let inner_box = inner.downcast_ref::<gtk4::Box>();
            if let Some(inner_box) = inner_box {
                // Second child is the value label
                if let Some(first) = inner_box.first_child()
                    && let Some(second) = first.next_sibling()
                        && let Some(label) = second.downcast_ref::<gtk4::Label>() {
                            label.set_label(value);
                        }
            }
        }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
