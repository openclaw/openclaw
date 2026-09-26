use super::{
    AppView,
    components::{
        icon_button::icon_button,
        icons::icon as ui_icon,
        menu_surface::{MenuSurfaceSpec, menu_surface},
    },
    theme::{
        Palette,
        tokens::{TypographyExt, header, icon, icon_button as buttons, menu, sidebar, text},
    },
};
use crate::model::sidebar::{ArchiveFilter, EmptyGroups, Grouping, SidebarPreferences, SortMode};
use gpui_kit::{
    assets::IconName,
    component::{
        Sizable,
        button::{Button, ButtonVariants},
        menu::PopupMenuItem,
    },
    *,
};

impl AppView {
    pub(super) fn sidebar_filter_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::sidebar(cx);
        let ownership = self.sidebar_owners();
        let prefs = ownership.effective_preferences(&self.sidebar_state.preferences);
        let people_sort_available = ownership.people_available;
        let owners = if ownership.filters_available {
            ownership.options
        } else {
            Vec::new()
        };
        let self_id = ownership.self_id;
        let owner_filter_active = prefs.owner_id.is_some() || prefs.involving_me;
        let view = cx.entity().downgrade();
        let trigger = icon_button(
            "sidebar-filter",
            IconName::ListFilter,
            "Filter and sort conversations",
            buttons::COMPACT,
            cx,
        )
        .text_color(if prefs.filtered() { p.accent } else { p.muted });
        menu_surface(
            "sidebar-filter-popup",
            trigger,
            MenuSurfaceSpec::below(menu::FILTER),
            move |mut menu, window, cx| {
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
                if !prefs.all_agents {
                    menu = menu.label("GROUP BY");
                    for (label, value) in [
                        ("Custom groups", Grouping::Category),
                        ("Project", Grouping::Project),
                        ("Person", Grouping::Person),
                        ("None", Grouping::None),
                    ] {
                        if value == Grouping::Person && !people_sort_available {
                            continue;
                        }
                        menu = menu.item(preference_item(
                            label,
                            prefs.grouping == value,
                            view.clone(),
                            move |prefs| prefs.grouping = value,
                        ));
                    }
                    menu = menu.separator();
                }
                menu = menu.label("SORT BY");
                for (label, value) in [
                    ("Created", SortMode::Created),
                    ("Last updated", SortMode::Updated),
                    ("Owners", SortMode::People),
                ] {
                    if value == SortMode::People && !people_sort_available {
                        continue;
                    }
                    menu = menu.item(preference_item(
                        label,
                        prefs.sort == value,
                        view.clone(),
                        move |prefs| prefs.sort = value,
                    ));
                }
                menu = menu.separator().label("STATUS");
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
                if !owners.is_empty() || owner_filter_active {
                    menu = menu
                        .separator()
                        .label("OWNERS")
                        .item(preference_item(
                            "All owners",
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
                    if !owners.is_empty() {
                        let owner_view = view.clone();
                        let owner_rows = owners.clone();
                        let current = prefs.owner_id.clone();
                        let own_id = self_id.clone();
                        menu = menu.submenu("Specific owner", window, cx, move |mut menu, _, _| {
                            for person in &owner_rows {
                                let id = person.id.clone();
                                let label = if own_id.as_ref() == Some(&id) {
                                    format!("{} (You)", person.label())
                                } else {
                                    person.label().to_owned()
                                };
                                menu = menu.item(preference_item(
                                    &label,
                                    current.as_ref() == Some(&id),
                                    owner_view.clone(),
                                    move |prefs| {
                                        prefs.owner_id = Some(id.clone());
                                        prefs.involving_me = false;
                                    },
                                ));
                            }
                            menu
                        });
                    }
                }
                menu = menu.separator();
                menu = menu
                    .item(preference_item(
                        "Show preview",
                        prefs.show_preview,
                        view.clone(),
                        |prefs| prefs.show_preview = !prefs.show_preview,
                    ))
                    .item(preference_item(
                        "Show cron jobs",
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
                if !prefs.all_agents {
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
                }
                menu
            },
        )
    }

    pub(super) fn sidebar_filter_summary(&self, cx: &mut Context<Self>) -> AnyElement {
        let prefs = &self.sidebar_state.preferences;
        let ownership = self.sidebar_owners();
        let mut labels = Vec::new();
        if let Some(id) = &prefs.owner_id {
            labels.push(
                ownership
                    .options
                    .iter()
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
            .h(header::SECTION_HEIGHT)
            .max_w(sidebar::FILTER_SUMMARY_MAX_WIDTH)
            .typography(text::CAPTION)
            .label(labels.join(" · "))
            .icon(ui_icon(IconName::X, icon::SMALL))
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
