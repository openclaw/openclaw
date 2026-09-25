use super::{AppView, theme::Palette};
use crate::model::{
    people::Person,
    sidebar::{ArchiveFilter, EmptyGroups, Grouping, SidebarPreferences, SortMode},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Icon, Sizable,
        button::{Button, ButtonVariants},
        menu::{DropdownMenu, PopupMenuItem},
    },
    *,
};

impl AppView {
    pub(super) fn sidebar_filter_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let prefs = self.sidebar_state.preferences.clone();
        let owners = self.sidebar_state.owners.clone();
        let self_id = self
            .sidebar_state
            .people
            .self_user
            .as_ref()
            .map(|person| person.id.clone());
        let view = cx.entity().downgrade();
        Button::new("sidebar-filter")
            .ghost()
            .small()
            .size(px(26.))
            .icon(
                Icon::new(IconName::ListFilter)
                    .size(px(16.))
                    .text_color(if prefs.filtered() { p.accent } else { p.muted }),
            )
            .accessibility_label("Filter and sort conversations")
            .dropdown_menu(move |mut menu, window, cx| {
                let page = view.clone();
                menu = menu
                    .item(
                        PopupMenuItem::new("Session sources…").on_click(move |_, window, cx| {
                            let _ = page.update(cx, |this, cx| {
                                this.open_control_page(
                                    "/settings/appearance#settings-appearance-sidebar",
                                    "Session sources",
                                    window,
                                    cx,
                                )
                            });
                        }),
                    )
                    .separator();
                let group_view = view.clone();
                let current = prefs.grouping;
                menu = menu.submenu("Group by", window, cx, move |mut menu, _, _| {
                    for (label, value) in [
                        ("Category", Grouping::Category),
                        ("Person", Grouping::Person),
                        ("Project", Grouping::Project),
                        ("None", Grouping::None),
                    ] {
                        menu = menu.item(preference_item(
                            label,
                            current == value,
                            group_view.clone(),
                            move |prefs| prefs.grouping = value,
                        ));
                    }
                    menu
                });
                let sort_view = view.clone();
                let current = prefs.sort;
                menu = menu
                    .submenu("Sort by", window, cx, move |mut menu, _, _| {
                        for (label, value) in [
                            ("Created", SortMode::Created),
                            ("Updated", SortMode::Updated),
                            ("People", SortMode::People),
                        ] {
                            menu = menu.item(preference_item(
                                label,
                                current == value,
                                sort_view.clone(),
                                move |prefs| prefs.sort = value,
                            ));
                        }
                        menu
                    })
                    .separator()
                    .label("Status");
                for (label, value) in [
                    ("Active", ArchiveFilter::Active),
                    ("Archived", ArchiveFilter::Archived),
                    ("All", ArchiveFilter::All),
                ] {
                    menu = menu.item(preference_item(
                        label,
                        prefs.archive == value,
                        view.clone(),
                        move |prefs| prefs.archive = value,
                    ));
                }
                menu = menu
                    .separator()
                    .label("Owners")
                    .item(preference_item(
                        "Everyone",
                        prefs.owner_id.is_none() && !prefs.involving_me,
                        view.clone(),
                        |prefs| {
                            prefs.owner_id = None;
                            prefs.involving_me = false;
                        },
                    ))
                    .item(preference_item(
                        "Involving me",
                        prefs.involving_me,
                        view.clone(),
                        |prefs| {
                            prefs.owner_id = None;
                            prefs.involving_me = true;
                        },
                    ));
                if let Some(id) = self_id.clone() {
                    menu = menu.item(preference_item(
                        "Mine",
                        prefs.owner_id.as_ref() == Some(&id),
                        view.clone(),
                        move |prefs| {
                            prefs.owner_id = Some(id.clone());
                            prefs.involving_me = false;
                        },
                    ));
                }
                let owner_view = view.clone();
                let owner_rows = owners.clone();
                let current = prefs.owner_id.clone();
                menu = menu
                    .submenu("Specific owner", window, cx, move |mut menu, _, _| {
                        for owner in &owner_rows {
                            if let Some(person) = Person::from_actor(owner) {
                                let id = person.id.clone();
                                menu = menu.item(preference_item(
                                    person.label(),
                                    current.as_ref() == Some(&id),
                                    owner_view.clone(),
                                    move |prefs| {
                                        prefs.owner_id = Some(id.clone());
                                        prefs.involving_me = false;
                                    },
                                ));
                            }
                        }
                        menu
                    })
                    .separator();
                menu = menu
                    .item(preference_item(
                        "Show previews",
                        prefs.show_preview,
                        view.clone(),
                        |prefs| prefs.show_preview = !prefs.show_preview,
                    ))
                    .item(preference_item(
                        "Show cron / automations",
                        prefs.show_cron,
                        view.clone(),
                        |prefs| prefs.show_cron = !prefs.show_cron,
                    ))
                    .item(preference_item(
                        "Show system sessions",
                        prefs.show_system,
                        view.clone(),
                        |prefs| prefs.show_system = !prefs.show_system,
                    ));
                let empty_view = view.clone();
                let current = prefs.empty_groups;
                menu = menu.submenu("Hide empty groups", window, cx, move |mut menu, _, _| {
                    for (label, value) in [
                        ("When filtering", EmptyGroups::Filtering),
                        ("Always", EmptyGroups::Always),
                        ("Never", EmptyGroups::Never),
                    ] {
                        menu = menu.item(preference_item(
                            label,
                            current == value,
                            empty_view.clone(),
                            move |prefs| prefs.empty_groups = value,
                        ));
                    }
                    menu
                });
                menu
            })
    }

    pub(super) fn sidebar_filter_summary(&self, cx: &mut Context<Self>) -> AnyElement {
        let prefs = &self.sidebar_state.preferences;
        let mut labels = Vec::new();
        if let Some(id) = &prefs.owner_id {
            labels.push(
                self.sidebar_state
                    .owners
                    .iter()
                    .filter_map(Person::from_actor)
                    .find(|person| &person.id == id)
                    .map(|person| person.label().to_owned())
                    .unwrap_or_else(|| id.clone()),
            );
        }
        if prefs.involving_me {
            labels.push("Involving me".into());
        }
        if prefs.archive != ArchiveFilter::Active {
            labels.push(
                if prefs.archive == ArchiveFilter::Archived {
                    "Archived"
                } else {
                    "All"
                }
                .into(),
            );
        }
        Button::new("clear-sidebar-filters")
            .ghost()
            .small()
            .h(px(24.))
            .max_w(px(160.))
            .text_size(px(11.))
            .label(labels.join(" · "))
            .icon(Icon::new(IconName::X).size(px(12.)))
            .accessibility_label("Clear conversation filters")
            .on_click(cx.listener(|this, _, _, cx| {
                this.change_sidebar_preferences(
                    |prefs| {
                        prefs.archive = ArchiveFilter::Active;
                        prefs.owner_id = None;
                        prefs.involving_me = false;
                    },
                    cx,
                )
            }))
            .into_any_element()
    }
}
fn preference_item(
    label: &str,
    checked: bool,
    view: WeakEntity<AppView>,
    change: impl Fn(&mut SidebarPreferences) + 'static,
) -> PopupMenuItem {
    PopupMenuItem::new(label.to_owned())
        .checked(checked)
        .on_click(move |_, _, cx| {
            let _ = view.update(cx, |this, cx| {
                this.change_sidebar_preferences(|prefs| change(prefs), cx)
            });
        })
}
