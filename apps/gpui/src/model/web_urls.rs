//! Control UI route and document-start authentication contracts shared with native hosts.

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use serde_json::json;
use url::Url;

use crate::gateway::{access, config::ConnectionConfig};

#[derive(Clone)]
pub struct WebAuth {
    pub gateway_url: String,
    pub token: Option<String>,
    pub password: Option<String>,
    pub access_session: Option<access::Session>,
}

impl WebAuth {
    pub fn from_config(config: &ConnectionConfig, access_session: Option<access::Session>) -> Self {
        Self {
            gateway_url: config.url.clone(),
            token: config.token.clone(),
            password: config.password.clone(),
            access_session,
        }
    }

    pub fn initialization_script(&self) -> Result<String, String> {
        let base = control_base_url(&self.gateway_url)?;
        let origin = json!(base.origin().ascii_serialization());
        let mount = json!(base.path().trim_end_matches('/'));
        let protected = self.access_session.is_some();
        let auth = json!({
            "gatewayUrl": self.gateway_url,
            "token": if protected { None } else { self.token.as_ref() },
            "password": if protected { None } else { self.password.as_ref() },
        });
        let platform = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "linux"
        };
        Ok(format!(
            r#"(() => {{
  if (location.origin !== {origin}) return;
  const mount = {mount};
  if (mount && location.pathname !== mount && !location.pathname.startsWith(mount + '/')) return;
  Object.defineProperty(window, '__OPENCLAW_NATIVE_CONTROL_AUTH__', {{value:{auth}, configurable:true}});
  window.__OPENCLAW_NATIVE_EMBED__ = {{platform:{platform}, formFactor:'desktop', navigationChrome:'host'}};
  window.__OPENCLAW_NATIVE_WEB_CHROME__ = true;
  window.__OPENCLAW_NATIVE_PANEL__ = {{postMessage:payload => window.ipc.postMessage(JSON.stringify(payload))}};
  window.__OPENCLAW_NATIVE_HISTORY__ = {{canGoBack:false, canGoForward:false}};
}})();"#,
            platform = json!(platform)
        ))
    }

    pub fn trusts(&self, value: &str) -> bool {
        let (Ok(base), Ok(url)) = (control_base_url(&self.gateway_url), Url::parse(value)) else {
            return false;
        };
        let mount = base.path().trim_end_matches('/');
        base.origin() == url.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && (mount.is_empty()
                || url.path() == mount
                || url.path().starts_with(&format!("{mount}/")))
    }
}

pub fn control_base_url(gateway_url: &str) -> Result<Url, String> {
    let normalized = crate::gateway::config::normalize_url(gateway_url)?;
    let mut url = Url::parse(&normalized).map_err(|_| "Invalid Gateway address")?;
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    url.set_scheme(scheme)
        .map_err(|_| "Invalid Gateway address")?;
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

/// A navigation destination stays within the connected Gateway's mount.
pub fn control_page_url(gateway_url: &str, path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return Err("Use a Control UI route on this Gateway".into());
    }
    let base = control_base_url(gateway_url)?;
    let url = base
        .join(&path[1..])
        .map_err(|_| "Invalid Control UI route")?;
    if url.origin() != base.origin() || !url.path().starts_with(base.path()) {
        return Err("Control UI routes must stay on their Gateway".into());
    }
    Ok(url.into())
}

pub fn control_page_path(gateway_url: &str, value: &str) -> Option<String> {
    let base = control_base_url(gateway_url).ok()?;
    let url = Url::parse(value).ok()?;
    if base.origin() != url.origin() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let path = url.path().strip_prefix(base.path())?;
    let mut relative = format!("/{path}");
    if let Some(query) = url.query() {
        relative.push('?');
        relative.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        relative.push('#');
        relative.push_str(fragment);
    }
    Some(relative)
}

#[derive(Clone, Copy)]
pub struct SidebarRoute {
    pub id: &'static str,
    pub path: &'static str,
    pub title: &'static str,
}

pub const SIDEBAR_ROUTES: &[SidebarRoute] = &[
    SidebarRoute {
        id: "agents-home",
        path: "/agents",
        title: "Agents",
    },
    SidebarRoute {
        id: "dashboards",
        path: "/dashboards",
        title: "Dashboards",
    },
    SidebarRoute {
        id: "usage",
        path: "/usage",
        title: "Usage",
    },
    SidebarRoute {
        id: "cron",
        path: "/automations",
        title: "Automations",
    },
    SidebarRoute {
        id: "tasks",
        path: "/tasks",
        title: "Tasks",
    },
    SidebarRoute {
        id: "sessions",
        path: "/sessions",
        title: "Sessions",
    },
    SidebarRoute {
        id: "systems",
        path: "/systems",
        title: "Systems",
    },
    SidebarRoute {
        id: "activity",
        path: "/activity",
        title: "Activity",
    },
    SidebarRoute {
        id: "meetings",
        path: "/meetings",
        title: "Meetings",
    },
    SidebarRoute {
        id: "plugins",
        path: "/plugins",
        title: "Plugins",
    },
    SidebarRoute {
        id: "apps",
        path: "/apps",
        title: "Apps",
    },
    SidebarRoute {
        id: "portals",
        path: "/portals",
        title: "Portals",
    },
];

pub fn sidebar_route_for_path(path: &str) -> Option<&'static SidebarRoute> {
    let path = path.split(['?', '#']).next()?;
    let path = match path {
        "/worktrees" => "/sessions",
        "/skills" | "/skills/workshop" => "/plugins",
        _ => path,
    };
    SIDEBAR_ROUTES
        .iter()
        .find(|route| path == route.path || path.starts_with(&format!("{}/", route.path)))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlUiTab {
    pub plugin_id: String,
    pub id: String,
    pub label: String,
    pub slug: Option<String>,
    pub icon: Option<String>,
    pub group: Option<String>,
    pub placement: Option<String>,
}

impl ControlUiTab {
    pub fn key(&self) -> String {
        format!("{}/{}", self.plugin_id, self.id)
    }

    pub fn path(&self) -> String {
        if let Some(slug) = &self.slug
            && valid_plugin_slug(slug)
        {
            return format!("/{slug}");
        }
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("plugin", &self.plugin_id)
            .append_pair("id", &self.id)
            .finish();
        format!("/plugin?{query}")
    }

    pub fn is_active(&self, path: &str) -> bool {
        let Some(page) = Url::parse("https://control.invalid/")
            .ok()
            .and_then(|base| base.join(path).ok())
        else {
            return false;
        };
        if let Some(slug) = &self.slug
            && valid_plugin_slug(slug)
        {
            return page.path() == format!("/{slug}");
        }
        page.path() == "/plugin"
            && page
                .query_pairs()
                .any(|(key, value)| key == "plugin" && value == self.plugin_id)
            && page
                .query_pairs()
                .any(|(key, value)| key == "id" && value == self.id)
    }
}

fn valid_plugin_slug(slug: &str) -> bool {
    let native = [
        "apps",
        "settings",
        "chat",
        "terminal",
        "dashboard",
        "dashboards",
        "custodian",
        "new",
        "activity",
        "meetings",
        "portals",
        "agents",
        "channels",
        "config",
        "profile",
        "communications",
        "appearance",
        "lobsterdex",
        "automation",
        "mcp",
        "infrastructure",
        "ai-agents",
        "model-setup",
        "model-providers",
        "memory-import",
        "workboard",
        "worktrees",
        "sessions",
        "systems",
        "usage",
        "debug",
        "logs",
        "skills",
        "plugins",
        "automations",
        "cron",
        "tasks",
        "nodes",
        "cloud-workers",
        "plugin",
    ];
    !slug.is_empty()
        && slug.len() <= 64
        && !native.contains(&slug)
        && slug.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub fn agent_settings_path(agent: &str) -> Option<String> {
    if agent.is_empty() || agent.contains('/') || matches!(agent, "." | "..") {
        return None;
    }
    const CHARACTERS: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    Some(format!(
        "/settings/agents/{}",
        utf8_percent_encode(agent, CHARACTERS)
    ))
}

pub fn panel_url(
    gateway_url: &str,
    agent: &str,
    session: &str,
    slot: &str,
    extras: &[(&str, &str)],
) -> Result<String, String> {
    let mut url = control_base_url(gateway_url)?
        .join("apps/panel")
        .map_err(|_| "Invalid panel route")?;
    url.query_pairs_mut()
        .append_pair("agent", agent)
        .append_pair("session", session)
        .append_pair("slot", slot);
    for (key, value) in extras {
        if matches!(
            *key,
            "taskId" | "portalId" | "environmentId" | "path" | "url"
        ) {
            url.query_pairs_mut().append_pair(key, value);
        }
    }
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_routes_keep_the_gateway_mount_and_encode_session_context() {
        assert_eq!(
            control_page_url("wss://gateway.example/control/", "/settings").unwrap(),
            "https://gateway.example/control/settings"
        );
        let url = Url::parse(
            &panel_url(
                "ws://127.0.0.1:19555/control",
                "agent/a",
                "agent:a:test & child",
                "plugin:test/panel",
                &[("taskId", "a&b"), ("token", "must-not-appear")],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(url.path(), "/control/apps/panel");
        assert_eq!(
            url.query_pairs().into_owned().collect::<Vec<_>>(),
            vec![
                ("agent".into(), "agent/a".into()),
                ("session".into(), "agent:a:test & child".into()),
                ("slot".into(), "plugin:test/panel".into()),
                ("taskId".into(), "a&b".into())
            ]
        );
        assert!(control_page_url("https://user:secret@gateway.example", "/settings").is_err());
    }

    #[test]
    fn navigation_routes_keep_credentials_on_the_gateway_and_plugins_keep_opaque_ids() {
        let gateway = "wss://gateway.example/control/";
        let full =
            control_page_url(gateway, "/settings/profile#settings-profile-identity").unwrap();
        assert_eq!(
            control_page_path(gateway, &full).as_deref(),
            Some("/settings/profile#settings-profile-identity")
        );
        for path in [
            "https://elsewhere.example",
            "//elsewhere.example",
            "/../outside",
            "/%2e%2e/outside",
            "/\\elsewhere",
        ] {
            assert!(control_page_url(gateway, path).is_err(), "{path}");
        }
        assert!(
            control_page_path(gateway, "https://gateway.example/control-other/agents").is_none()
        );
        let mut tab: ControlUiTab = serde_json::from_value(json!({
            "pluginId":"notes & ideas", "id":"daily/notes", "label":"Notes", "slug":"agents"
        }))
        .unwrap();
        assert_eq!(
            tab.path(),
            "/plugin?plugin=notes+%26+ideas&id=daily%2Fnotes"
        );
        assert!(tab.is_active("/plugin?id=daily%2Fnotes&plugin=notes+%26+ideas&p.view=board"));
        assert!(!tab.is_active("/plugin?id=another&plugin=notes+%26+ideas"));
        tab.slug = Some("daily-notes".into());
        assert_eq!(tab.path(), "/daily-notes");
        assert!(tab.is_active("/daily-notes?p.view=board"));
        assert_eq!(
            sidebar_route_for_path("/skills/workshop").map(|route| route.id),
            Some("plugins")
        );
        assert_eq!(
            sidebar_route_for_path("/worktrees").map(|route| route.id),
            Some("sessions")
        );
        assert!(sidebar_route_for_path("/settings/agents").is_none());
        assert_eq!(
            agent_settings_path("agent & name").as_deref(),
            Some("/settings/agents/agent%20%26%20name")
        );
        assert!(agent_settings_path("../agent").is_none());
    }

    #[test]
    fn native_authority_excludes_similar_origins_and_mount_prefixes() {
        let auth = WebAuth {
            gateway_url: "wss://gateway.example/control".into(),
            token: None,
            password: None,
            access_session: None,
        };
        assert!(auth.trusts("https://gateway.example/control/settings"));
        assert!(auth.trusts("https://gateway.example/control?x=1"));
        for url in [
            "https://gateway.example/control-other",
            "https://gateway.example.evil/control",
            "http://gateway.example/control",
            "https://user@gateway.example/control",
        ] {
            assert!(!auth.trusts(url));
        }
    }
}
