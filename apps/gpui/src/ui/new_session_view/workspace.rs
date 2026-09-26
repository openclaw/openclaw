use super::*;

impl AppView {
    pub(super) fn draft_project_label(&self) -> String {
        let draft = &self.new_session.draft;
        if draft.destination.is_remote() && draft.fresh_workspace {
            return "New workspace".into();
        }
        self.new_session
            .projects
            .iter()
            .find(|p| p.id == draft.project_id)
            .map(|p| p.display_name.clone())
            .unwrap_or_else(|| {
                if !draft.project_git_url.is_empty() {
                    draft.project_git_url.clone()
                } else {
                    folder_name(&draft.folder)
                }
            })
    }

    pub(super) fn draft_project_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.new_session;
        let draft = &state.draft;
        let mut menu = menu::panel(
            "draft-project-menu",
            t::PROJECT_MENU_WIDTH,
            MenuStyle::Selection,
            cx,
        );
        if state.browsing {
            menu =
                menu.child(row("draft-browser-back", "‹ Projects", false, cx).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.new_session.browsing = false;
                        cx.notify();
                    }),
                ))
                .child(
                    Input::new(&state.folder_input)
                        .small()
                        .appearance(false)
                        .aria_label("Folder path"),
                );
            if let Some(listing) = &state.directory {
                if let Some(parent) = listing.parent.clone() {
                    menu = menu.child(row("draft-folder-parent", "..", false, cx).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.browse_draft_folder(Some(parent.clone()), cx)
                        }),
                    ));
                }
                for entry in &listing.entries {
                    let path = entry.path.clone();
                    menu = menu.child(
                        row(
                            SharedString::from(format!("draft-folder-{path}")),
                            entry.name.clone(),
                            false,
                            cx,
                        )
                        .when(entry.hidden, |el| el.text_color(Palette::get(cx).muted))
                        .icon(Icon::new(IconName::Folder).size(px(m::ICON_SIZE)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.browse_draft_folder(Some(path.clone()), cx)
                        })),
                    );
                }
                let path = listing.path.clone();
                menu = menu.child(
                    Button::new("draft-use-folder")
                        .primary()
                        .small()
                        .label("Use this folder")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.choose_draft_folder(path.clone(), window, cx)
                        })),
                );
            }
            if state.directory_loading {
                menu = menu.child(title("Loading…", cx));
            }
            return menu.into_any_element();
        }
        menu = menu.child(title("PROJECTS", cx));
        if draft.destination.is_remote() {
            menu = menu.child(
                row(
                    "draft-new-workspace",
                    "New workspace",
                    draft.fresh_workspace,
                    cx,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.new_session.draft.fresh_workspace = true;
                    this.new_session.draft.project_id.clear();
                    this.new_session.draft.project_git_url.clear();
                    this.new_session.picker = None;
                    cx.notify();
                })),
            );
        }
        if !draft.workspace.is_empty() {
            let folder = draft.workspace.clone();
            menu = menu.child(
                row(
                    "draft-agent-workspace",
                    folder_name(&folder),
                    draft.folder == folder && draft.project_id.is_empty(),
                    cx,
                )
                .icon(Icon::new(IconName::Folder).size(px(m::ICON_SIZE)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.choose_draft_folder(folder.clone(), window, cx)
                })),
            );
        }
        menu = menu.child(
            Input::new(&state.search)
                .small()
                .appearance(false)
                .h(px(m::ROW_HEIGHT))
                .px(px(m::ROW_PADDING_X))
                .border_1()
                .border_color(Palette::get(cx).border)
                .rounded(px(t::SEARCH_RADIUS))
                .bg(Palette::get(cx).bg)
                .aria_label("Search projects or paste a clone URL"),
        );
        let query = state.search.read(cx).value().to_string();
        for project in &state.projects {
            if !format!(
                "{} {} {}",
                project.display_name,
                project.repo_root.as_deref().unwrap_or(""),
                project.origin_url.as_deref().unwrap_or("")
            )
            .to_lowercase()
            .contains(&query.to_lowercase())
            {
                continue;
            }
            let project = project.clone();
            menu = menu.child(
                row(
                    format!("draft-project-{}", project.id),
                    project.display_name.clone(),
                    draft.project_id == project.id,
                    cx,
                )
                .icon(Icon::new(IconName::GitBranch).size(px(m::ICON_SIZE)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.choose_draft_project(project.clone(), window, cx)
                })),
            );
        }
        if clone_url(&query) {
            let url = query.clone();
            menu = menu.child(
                row("draft-clone-url", format!("Clone {url}"), false, cx).on_click(cx.listener(
                    move |this, _, _, cx| this.choose_remote_draft_project(url.clone(), cx),
                )),
            );
        }
        for project in &state.remote_projects {
            let Some(url) = project["cloneUrl"].as_str().map(str::to_owned) else {
                continue;
            };
            menu = menu.child(
                row(
                    format!("draft-remote-{url}"),
                    project["fullName"].as_str().unwrap_or(&url).to_owned(),
                    false,
                    cx,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose_remote_draft_project(url.clone(), cx)
                })),
            );
        }
        menu.child(
            row("draft-browse", "Browse folders", false, cx)
                .icon(Icon::new(IconName::Folder).size(px(m::ICON_SIZE)))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.browse_draft_folder(Some(this.new_session.draft.folder.clone()), cx)
                })),
        )
        .into_any_element()
    }

    pub(super) fn draft_checkout_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.new_session;
        let draft = &state.draft;
        let repository = draft.destination.is_remote() && !draft.project_git_url.is_empty();
        let mut menu = menu::panel(
            "draft-checkout-menu",
            if draft.worktree {
                t::WORKTREE_MENU_WIDTH
            } else {
                t::CHECKOUT_MENU_WIDTH
            },
            MenuStyle::Selection,
            cx,
        )
        .child(title("CHECKOUT", cx));
        if !repository {
            menu = menu
                .child(
                    checkout_option(
                        "draft-current-checkout",
                        "Current checkout",
                        IconName::Folder,
                        state.branches.head_branch.as_deref().unwrap_or(""),
                        !draft.worktree,
                        cx,
                    )
                    .disabled(draft.destination.is_remote())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.new_session.draft.worktree = false;
                        cx.notify();
                    })),
                )
                .child(
                    checkout_option(
                        "draft-new-worktree",
                        "New worktree",
                        IconName::GitBranch,
                        "Isolated copy of the repo",
                        draft.worktree,
                        cx,
                    )
                    .disabled(
                        state.branches.repository_status.as_deref() != Some("git")
                            && draft.project_git_url.is_empty(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.new_session.draft.worktree = true;
                        this.new_session.draft.fresh_workspace = false;
                        cx.notify();
                    })),
                );
        }
        if draft.worktree || repository {
            menu = menu.child(checkout_field(
                "From",
                "Base branch or commit",
                &state.base_ref_input,
                cx,
            ));
            let query = state.base_ref_input.read(cx).value().to_lowercase();
            for branch in state
                .branches
                .branches
                .iter()
                .filter(|b| state.branch_suggestions && b.name.to_lowercase().contains(&query))
                .take(8)
            {
                let name = branch.name.clone();
                menu = menu.child(
                    row(
                        format!("draft-base-{name}"),
                        name.clone(),
                        draft.base_ref == name,
                        cx,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.new_session.draft.base_ref = name.clone();
                        this.new_session.branch_suggestions = false;
                        this.new_session
                            .base_ref_input
                            .update(cx, |input, cx| input.set_value(name.clone(), window, cx));
                        cx.notify();
                    })),
                );
            }
            menu = menu.child(note(
                if state.branches.branches_unavailable {
                    "Branch suggestions are unavailable. Enter a branch or commit."
                } else {
                    "Suggestions are limited. Enter any branch or commit."
                },
                cx,
            ));
            if !repository {
                menu = menu
                    .child(checkout_field(
                        "Name",
                        "New worktree name",
                        &state.worktree_name_input,
                        cx,
                    ))
                    .child(note(
                        worktree_branch_name(&draft.worktree_name)
                            .map(|name| format!("Creates branch {name} in a separate checkout."))
                            .unwrap_or_else(|| {
                                "Creates a branch from the session title in a separate checkout."
                                    .into()
                            }),
                        cx,
                    ));
            }
        }
        if state.branches_loading {
            menu = menu.child(note("Loading branches…", cx));
        }
        menu.into_any_element()
    }
}

fn folder_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("Select folder")
        .to_owned()
}
