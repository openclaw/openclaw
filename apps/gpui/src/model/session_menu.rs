use serde_json::Value;

use super::{
    composer_capabilities::{has_operator_scope, method_available},
    sessions::SessionRow,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Pin,
    Rename,
    Read,
    Archive,
    Fork,
    Delete,
    Icon,
    Color,
    Group,
    NewGroup,
    Owner,
    Involvement,
    CopyId,
    CopyLink,
    CopyMarkdown,
    Open,
}

fn durable(row: &SessionRow) -> bool {
    row.session_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
}

fn protected(row: &SessionRow, main_key: &str) -> bool {
    let key = row.key.trim().to_ascii_lowercase();
    let main = main_key.rsplit(':').next().unwrap_or("main").trim();
    matches!(key.as_str(), "main" | "global" | "unknown")
        || matches!(row.kind.as_deref(), Some("global" | "unknown"))
        || key == main_key.trim().to_ascii_lowercase()
        || key
            .strip_prefix("agent:")
            .and_then(|key| key.split_once(':'))
            .is_some_and(|(_, rest)| rest.eq_ignore_ascii_case(main))
}

pub fn can_archive(row: &SessionRow, main_key: &str) -> bool {
    durable(row) && !protected(row, main_key)
}

fn incognito(row: &SessionRow) -> bool {
    if row.incognito {
        return true;
    }
    let key = row.key.trim().to_ascii_lowercase();
    let parts: Vec<_> = key.split(':').collect();
    matches!(parts.as_slice(), ["agent", agent, "dashboard" | "subagent" | "internal-session-effects", id]
        if !agent.is_empty() && id.strip_prefix("incognito-").is_some_and(|id| !id.is_empty()))
}

fn method_reason(hello: &Value, row: &SessionRow, method: &str, scope: &str) -> Option<String> {
    if !method_available(hello, method) {
        return Some("This Gateway does not support this session action.".into());
    }
    if !has_operator_scope(hello, scope) {
        return Some(format!("This action requires {scope} access."));
    }
    if scope == "operator.sessions.write"
        && !has_operator_scope(hello, "operator.write")
        && !matches!(row.sharing_role.as_deref(), Some("owner" | "admin"))
    {
        return Some("Only the session owner can make this change.".into());
    }
    None
}

/// Mirrors the web sidebar's connection, method, scope, ownership, and row guards.
/// Callers additionally fence transient loading/archiving state before dispatch.
pub fn disabled_reason(
    action: MenuAction,
    row: &SessionRow,
    hello: Option<&Value>,
    main_key: &str,
) -> Option<String> {
    let Some(hello) = hello else {
        return Some("Connect to the Gateway to change sessions.".into());
    };
    let row_reason = match action {
        MenuAction::Pin if !row.can_pin(main_key) => {
            Some("Only root sessions can be pinned; pin the parent session instead.")
        }
        MenuAction::Pin if row.archived => Some("Restore this session before pinning it."),
        MenuAction::Archive if !durable(row) => {
            Some("Session lifecycle action requires a durable session identity.")
        }
        MenuAction::Archive if !row.archived && !can_archive(row, main_key) => {
            Some("Main, global, and unknown sessions cannot be archived.")
        }
        MenuAction::Delete if !row.archived && protected(row, main_key) => {
            Some("Main, global, and unknown sessions cannot be deleted.")
        }
        MenuAction::Delete if !row.archived && row.has_active_run => {
            Some("Wait for this session's active run to finish before deleting it.")
        }
        MenuAction::Fork if row.model_selection_locked => {
            Some("This session's locked model does not support forking.")
        }
        MenuAction::Group | MenuAction::NewGroup
            if row.navigation_parent(main_key, None).is_some() =>
        {
            Some("Move the parent session to a group instead.")
        }
        MenuAction::CopyId if !durable(row) => Some("Refresh before copying this session's ID."),
        MenuAction::Involvement if !durable(row) || row.hidden_from_involving_me.is_none() => {
            Some("This session does not support Involving me.")
        }
        MenuAction::Involvement
            if hello
                .pointer("/policy/hasMultipleSessionSharingIdentities")
                .and_then(Value::as_bool)
                != Some(true) =>
        {
            Some("This Gateway does not support Involving me.")
        }
        _ => None,
    };
    if let Some(reason) = row_reason {
        return Some(reason.into());
    }
    let (method, scope) = match action {
        MenuAction::Pin | MenuAction::Rename | MenuAction::Archive => {
            ("sessions.patch", "operator.sessions.write")
        }
        MenuAction::Read | MenuAction::Icon | MenuAction::Color | MenuAction::Group => {
            ("sessions.patch", "operator.write")
        }
        MenuAction::NewGroup => {
            return method_reason(hello, row, "sessions.groups.put", "operator.write")
                .or_else(|| method_reason(hello, row, "sessions.patch", "operator.write"));
        }
        MenuAction::Owner => ("sessions.assignOwner", "operator.write"),
        MenuAction::Involvement => ("sessions.setInvolvement", "operator.read"),
        MenuAction::CopyMarkdown => ("chat.history", "operator.sessions.read"),
        MenuAction::Delete => (
            "sessions.delete",
            if row.archived {
                "operator.write"
            } else {
                "operator.admin"
            },
        ),
        MenuAction::Fork => (
            "sessions.create",
            if incognito(row) {
                "operator.admin"
            } else {
                "operator.write"
            },
        ),
        MenuAction::CopyId | MenuAction::CopyLink | MenuAction::Open => return None,
    };
    method_reason(hello, row, method, scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> SessionRow {
        serde_json::from_value(json!({
            "key":"agent:main:work", "sessionId":"durable-session", "sharingRole":"owner",
            "hiddenFromInvolvingMe":false
        }))
        .unwrap()
    }

    fn hello(scope: &str) -> Value {
        json!({
            "auth":{"role":"operator","scopes":[scope]},
            "features":{"methods":["sessions.patch","sessions.delete","sessions.create",
                "sessions.assignOwner","sessions.setInvolvement","sessions.groups.put","chat.history"]},
            "policy":{"hasMultipleSessionSharingIdentities":true}
        })
    }

    #[test]
    fn narrow_writers_can_manage_owned_rows_but_not_broad_metadata_or_other_owners() {
        let mut row = row();
        let scoped = hello("operator.sessions.write");
        for action in [MenuAction::Pin, MenuAction::Rename, MenuAction::Archive] {
            assert_eq!(disabled_reason(action, &row, Some(&scoped), "main"), None);
            row.sharing_role = Some("viewer".into());
            assert_eq!(
                disabled_reason(action, &row, Some(&scoped), "main").as_deref(),
                Some("Only the session owner can make this change.")
            );
            assert_eq!(
                disabled_reason(action, &row, Some(&hello("operator.write")), "main"),
                None
            );
            row.sharing_role = Some("owner".into());
        }
        for action in [
            MenuAction::Read,
            MenuAction::Icon,
            MenuAction::Color,
            MenuAction::Group,
            MenuAction::NewGroup,
            MenuAction::Owner,
            MenuAction::Fork,
        ] {
            assert_eq!(
                disabled_reason(action, &row, Some(&scoped), "main").as_deref(),
                Some("This action requires operator.write access.")
            );
        }
    }

    #[test]
    fn read_and_connection_grants_match_the_web_menu() {
        let row = row();
        for scope in [
            "operator.read",
            "operator.sessions.read",
            "operator.sessions.write",
            "operator.write",
            "operator.admin",
        ] {
            assert_eq!(
                disabled_reason(MenuAction::CopyMarkdown, &row, Some(&hello(scope)), "main"),
                None
            );
        }
        for scope in ["operator.read", "operator.write", "operator.admin"] {
            assert_eq!(
                disabled_reason(MenuAction::Involvement, &row, Some(&hello(scope)), "main"),
                None
            );
        }
        assert!(
            disabled_reason(
                MenuAction::Rename,
                &row,
                Some(&hello("operator.read")),
                "main"
            )
            .is_some()
        );
        for action in [
            MenuAction::CopyId,
            MenuAction::CopyLink,
            MenuAction::CopyMarkdown,
            MenuAction::Open,
            MenuAction::Rename,
        ] {
            assert_eq!(
                disabled_reason(action, &row, None, "main").as_deref(),
                Some("Connect to the Gateway to change sessions.")
            );
        }
        let mut unsupported = hello("operator.admin");
        unsupported["features"]["methods"] = json!([]);
        assert_eq!(
            disabled_reason(MenuAction::Rename, &row, Some(&unsupported), "main").as_deref(),
            Some("This Gateway does not support this session action.")
        );
        unsupported["features"]["methods"] = json!(["sessions.groups.put"]);
        assert_eq!(
            disabled_reason(MenuAction::NewGroup, &row, Some(&unsupported), "main").as_deref(),
            Some("This Gateway does not support this session action.")
        );
        let mut other_role = hello("operator.admin");
        other_role["auth"]["role"] = json!("node");
        assert!(disabled_reason(MenuAction::Rename, &row, Some(&other_role), "main").is_some());
    }

    #[test]
    fn lifecycle_and_incognito_constraints_preserve_archived_and_running_exceptions() {
        let admin = hello("operator.admin");
        let write = hello("operator.write");
        let mut row = row();
        row.has_active_run = true;
        assert_eq!(
            disabled_reason(MenuAction::Archive, &row, Some(&admin), "main"),
            None
        );
        assert_eq!(
            disabled_reason(MenuAction::Fork, &row, Some(&write), "main"),
            None
        );
        assert!(disabled_reason(MenuAction::Delete, &row, Some(&admin), "main").is_some());
        row.archived = true;
        assert_eq!(
            disabled_reason(MenuAction::Delete, &row, Some(&write), "main"),
            None
        );
        row.archived = false;
        row.has_active_run = false;
        assert_eq!(
            disabled_reason(MenuAction::Delete, &row, Some(&write), "main").as_deref(),
            Some("This action requires operator.admin access.")
        );
        row.key = "agent:main:dashboard:incognito-example".into();
        assert_eq!(
            disabled_reason(MenuAction::Fork, &row, Some(&write), "main").as_deref(),
            Some("This action requires operator.admin access.")
        );
        assert_eq!(
            disabled_reason(MenuAction::Fork, &row, Some(&admin), "main"),
            None
        );
        row.model_selection_locked = true;
        assert!(disabled_reason(MenuAction::Fork, &row, Some(&admin), "main").is_some());
        row.key = "agent:other:home".into();
        assert!(!can_archive(&row, "agent:main:home"));
        row.key = "agent:main:work".into();
        row.session_id = Some(" ".into());
        assert!(!can_archive(&row, "main"));
        assert_eq!(
            disabled_reason(MenuAction::Archive, &row, Some(&admin), "main").as_deref(),
            Some("Session lifecycle action requires a durable session identity.")
        );
        row.session_id = Some("durable-session".into());
        row.parent_session_key = Some("agent:main:parent".into());
        assert!(disabled_reason(MenuAction::Pin, &row, Some(&admin), "main").is_some());
        assert!(disabled_reason(MenuAction::Group, &row, Some(&admin), "main").is_some());
    }
}
