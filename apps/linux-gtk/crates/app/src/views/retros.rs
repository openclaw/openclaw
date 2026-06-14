use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::SharedClient;

pub struct RetrosView {
    container: gtk4::Box,
}

impl RetrosView {
    pub fn new(client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Time range selector
        let filter_bar = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(16)
            .margin_end(16)
            .margin_top(8)
            .margin_bottom(4)
            .build();

        let range_label = gtk4::Label::builder()
            .label("Period:")
            .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
            .build();
        let range_dropdown = gtk4::DropDown::from_strings(&["7 days", "14 days", "30 days"]);
        range_dropdown.set_selected(0);

        let refresh_btn = gtk4::Button::builder()
            .icon_name("view-refresh-symbolic")
            .css_classes(vec!["flat".to_string()])
            .build();

        filter_bar.append(&range_label);
        filter_bar.append(&range_dropdown);
        filter_bar.append(&gtk4::Box::builder().hexpand(true).build());
        filter_bar.append(&refresh_btn);

        container.append(&filter_bar);
        container.append(&gtk4::Separator::new(Orientation::Horizontal));

        // Summary cards
        let cards = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(16)
            .homogeneous(true)
            .margin_start(16)
            .margin_end(16)
            .margin_top(12)
            .build();

        let cost_label = gtk4::Label::builder()
            .label("$--")
            .css_classes(vec!["title-2".to_string()])
            .build();
        let tokens_label = gtk4::Label::builder()
            .label("--")
            .css_classes(vec!["title-2".to_string()])
            .build();
        let sessions_label = gtk4::Label::builder()
            .label("--")
            .css_classes(vec!["title-2".to_string()])
            .build();

        cards.append(&Self::wrap_card("Total Cost", &cost_label));
        cards.append(&Self::wrap_card("Total Tokens", &tokens_label));
        cards.append(&Self::wrap_card("Sessions", &sessions_label));
        container.append(&cards);

        // Session usage list
        let scroll = gtk4::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .margin_top(12)
            .build();

        let list_box = gtk4::ListBox::builder()
            .selection_mode(gtk4::SelectionMode::None)
            .css_classes(vec!["boxed-list".to_string()])
            .margin_start(16)
            .margin_end(16)
            .margin_bottom(16)
            .build();

        scroll.set_child(Some(&list_box));
        container.append(&scroll);

        // Load data
        let load_data = {
            let client = client.clone();
            let cost_label = cost_label.clone();
            let tokens_label = tokens_label.clone();
            let sessions_label = sessions_label.clone();
            let list_box = list_box.clone();
            let range_dropdown = range_dropdown.clone();
            move || {
                if let Some(gw) = client.lock().unwrap().clone() {
                    let cl = cost_label.clone();
                    let tl = tokens_label.clone();
                    let sl = sessions_label.clone();
                    let lb = list_box.clone();
                    let days = match range_dropdown.selected() {
                        0 => 7,
                        1 => 14,
                        _ => 30,
                    };

                    glib::spawn_future_local(async move {
                        let params = serde_json::json!({
                            "days": days,
                            "limit": 50,
                        });
                        match gw.request("sessions.usage", params).await {
                            Ok(payload) => {
                                // Parse totals
                                if let Some(totals) = payload.get("totals") {
                                    let cost = totals
                                        .get("totalCost")
                                        .and_then(|v| v.as_f64())
                                        .unwrap_or(0.0);
                                    let tokens = totals
                                        .get("totalTokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                    cl.set_label(&format!("${cost:.4}"));
                                    tl.set_label(&format!("{tokens}"));
                                }

                                // Parse sessions
                                if let Some(sessions) =
                                    payload.get("sessions").and_then(|s| s.as_array())
                                {
                                    sl.set_label(&format!("{}", sessions.len()));

                                    // Clear old rows
                                    while let Some(child) = lb.first_child() {
                                        lb.remove(&child);
                                    }

                                    for sess in sessions.iter().take(30) {
                                        let key = sess
                                            .get("key")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("?");
                                        let cost = sess
                                            .get("totalCost")
                                            .and_then(|v| v.as_f64())
                                            .unwrap_or(0.0);
                                        let tokens = sess
                                            .get("totalTokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0);
                                        let agent = sess
                                            .get("agentId")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("default");

                                        let row = adw::ActionRow::builder()
                                            .title(key)
                                            .subtitle(format!(
                                                "{agent} | {tokens} tokens | ${cost:.4}"
                                            ))
                                            .build();
                                        lb.append(&row);
                                    }

                                    if sessions.is_empty() {
                                        let row = adw::ActionRow::builder()
                                            .title("No session data")
                                            .subtitle("No usage recorded in this period")
                                            .build();
                                        lb.append(&row);
                                    }
                                }
                            }
                            Err(e) => {
                                cl.set_label("--");
                                tl.set_label("--");
                                sl.set_label(&format!("Error: {e}"));
                            }
                        }
                    });
                }
            }
        };

        let load = load_data.clone();
        glib::timeout_add_local_once(std::time::Duration::from_secs(2), move || {
            load();
        });

        let load2 = load_data.clone();
        refresh_btn.connect_clicked(move |_| {
            load2();
        });

        let load3 = load_data;
        range_dropdown.connect_selected_notify(move |_| {
            load3();
        });

        Self { container }
    }

    fn wrap_card(title: &str, value_widget: &gtk4::Label) -> gtk4::Box {
        let card = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .css_classes(vec!["card".to_string()])
            .build();
        let inner = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .margin_start(16)
            .margin_end(16)
            .margin_top(12)
            .margin_bottom(12)
            .build();
        inner.append(
            &gtk4::Label::builder()
                .label(title)
                .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
                .halign(gtk4::Align::Start)
                .build(),
        );
        inner.append(value_widget);
        card.append(&inner);
        card
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
