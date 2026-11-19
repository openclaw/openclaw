//! External links carry package identity only, never Gateway or install authority.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tauri::Url;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DeepLinkRoute {
    Dashboard,
    Review(ClawHubReview),
    FocusOnly,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClawHubReview {
    kind: ReviewKind,
    name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ReviewKind {
    Plugin,
    Skill,
    Template,
}

impl ClawHubReview {
    pub(crate) fn dashboard_url(&self, base: &Url) -> Url {
        // Validation leaves only encodeURIComponent-safe bytes plus @ and /.
        let encoded = self.name.replace('@', "%40").replace('/', "%2F");
        let (path, query) = match self.kind {
            ReviewKind::Plugin => (
                format!(
                    "plugins/ch_{}",
                    URL_SAFE_NO_PAD.encode(self.name.as_bytes())
                ),
                None,
            ),
            ReviewKind::Skill => ("skills".to_string(), Some(format!("clawhub={encoded}"))),
            ReviewKind::Template => (format!("templates/packages/{encoded}"), None),
        };
        let mut url = base.clone();
        url.set_path(&format!("{}/{path}", base.path().trim_end_matches('/')));
        url.set_query(query.as_deref());
        // The selected Gateway owns this fragment (for example CLI #token
        // bootstrap). External fragments were rejected before creating review.
        url
    }
}

pub(crate) fn route(url: &Url, scheme: &str) -> DeepLinkRoute {
    if url.scheme() != scheme {
        return DeepLinkRoute::FocusOnly;
    }
    // Preserve the existing dashboard contract, including its ignored path/query.
    if url.host_str() == Some("dashboard") {
        return DeepLinkRoute::Dashboard;
    }
    let kind = match url.host_str() {
        Some(host) if host.eq_ignore_ascii_case("plugins") => ReviewKind::Plugin,
        Some(host) if host.eq_ignore_ascii_case("skills") => ReviewKind::Skill,
        Some(host) if host.eq_ignore_ascii_case("templates") => ReviewKind::Template,
        _ => return DeepLinkRoute::FocusOnly,
    };
    // DeepLinkExt supplies parsed URLs: raw dot-segment spellings and empty
    // userinfo have already been normalized away. Checks apply to that URL;
    // traversal in the package identity is always rejected below.
    if url.path() != "/install"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query().is_none_or(|query| query.contains('&'))
    {
        return DeepLinkRoute::FocusOnly;
    }
    let mut query = url.query_pairs();
    let Some((key, name)) = query.next() else {
        return DeepLinkRoute::FocusOnly;
    };
    if key != "name" || query.next().is_some() || !valid_package_name(&name) {
        return DeepLinkRoute::FocusOnly;
    }
    DeepLinkRoute::Review(ClawHubReview {
        kind,
        name: name.into_owned(),
    })
}

fn valid_package_name(name: &str) -> bool {
    // ^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$, at most 214 UTF-8 bytes.
    fn component(value: &str) -> bool {
        let mut bytes = value.bytes();
        bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && bytes.all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
            })
    }
    if name.len() > 214 {
        return false;
    }
    if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(owner, slug)| component(owner) && component(slug))
    } else {
        component(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_links_select_review_not_install_authority() {
        for (kind, family) in [
            (ReviewKind::Plugin, "plugins"),
            (ReviewKind::Skill, "skills"),
            (ReviewKind::Template, "templates"),
        ] {
            let url =
                Url::parse(&format!("openclaw://{family}/install?name=example-tool")).unwrap();
            assert_eq!(
                route(&url, "openclaw"),
                DeepLinkRoute::Review(ClawHubReview {
                    kind,
                    name: "example-tool".into(),
                })
            );
        }
    }

    #[test]
    fn scoped_identity_preserves_trusted_gateway_base_and_auth_not_external_authority() {
        let base =
            Url::parse("https://gateway.example/control/?old=1#token=trusted-fixture").unwrap();
        for (family, suffix) in [
            ("plugins", "plugins/ch_QG93bmVyL3Rvb2w"),
            ("skills", "skills?clawhub=%40owner%2Ftool"),
            ("templates", "templates/packages/%40owner%2Ftool"),
        ] {
            let url =
                Url::parse(&format!("openclaw://{family}/install?name=%40owner%2Ftool")).unwrap();
            let DeepLinkRoute::Review(review) = route(&url, "openclaw") else {
                panic!("expected a review route for {family}");
            };
            assert_eq!(
                review.dashboard_url(&base).as_str(),
                format!("https://gateway.example/control/{suffix}#token=trusted-fixture")
            );
            let external_auth = Url::parse(&format!(
                "openclaw://{family}/install?name=%40owner%2Ftool#token=external-fixture"
            ))
            .unwrap();
            assert_eq!(route(&external_auth, "openclaw"), DeepLinkRoute::FocusOnly);
        }
    }

    #[test]
    fn malformed_or_action_bearing_links_only_focus_the_app() {
        for family in ["plugins", "skills", "templates"] {
            for tail in [
                "/install",
                "/install?name=",
                "/install?package=tool",
                "/install?name=tool&name=other",
                "/install?name=tool&enable=true",
                "/install?name=tool&gateway=https%3A%2F%2Fother.example",
                "/install?name=tool&",
                "/install?name=tool#",
                "/install?name=tool#token=secret",
                "/install/?name=tool",
                "/install/enable?name=tool",
                "/enable?name=tool",
                "/%69nstall?name=tool",
                ":443/install?name=tool",
            ] {
                let input = format!("openclaw://{family}{tail}");
                assert_eq!(
                    route(&Url::parse(&input).unwrap(), "openclaw"),
                    DeepLinkRoute::FocusOnly,
                    "{input}"
                );
            }
            for authority in [format!("user@{family}"), format!("user:secret@{family}")] {
                let url = Url::parse(&format!("openclaw://{authority}/install?name=tool")).unwrap();
                assert_eq!(route(&url, "openclaw"), DeepLinkRoute::FocusOnly);
            }
            for name in [
                "Tool",
                "@Owner/tool",
                "@owner/Tool",
                "../tool",
                "%2e%2e%2Ftool",
                ".",
                "..",
                "@owner/..",
                "@../tool",
                "@owner/tool/extra",
                "owner/tool",
                "@owner",
                "@/tool",
                "@owner/",
                "-tool",
                "_tool",
                "tool%00",
                "tool%20",
                "tool+name",
                "tool%252Fextra",
                "tool%5Cextra",
                "caf%C3%A9",
                "tool%26enable%3Dtrue",
            ] {
                let input = format!("openclaw://{family}/install?name={name}");
                assert_eq!(
                    route(&Url::parse(&input).unwrap(), "openclaw"),
                    DeepLinkRoute::FocusOnly,
                    "{input}"
                );
            }
        }
    }

    #[test]
    fn package_names_are_bounded_to_214_bytes_and_preserved_exactly() {
        for name in [
            "a".repeat(214),
            format!("@a/{}", "b".repeat(211)),
            "@owner.name/tool_1.2-3".into(),
            "0".into(),
        ] {
            let url = Url::parse(&format!("openclaw://skills/install?name={name}")).unwrap();
            let DeepLinkRoute::Review(review) = route(&url, "openclaw") else {
                panic!("valid name rejected");
            };
            assert_eq!(review.name, name);
        }
        for name in ["a".repeat(215), format!("@a/{}", "b".repeat(212))] {
            let url = Url::parse(&format!("openclaw://skills/install?name={name}")).unwrap();
            assert_eq!(route(&url, "openclaw"), DeepLinkRoute::FocusOnly);
        }
    }

    #[test]
    fn review_urls_support_loopback_and_base_paths_without_switching_gateway() {
        let DeepLinkRoute::Review(review) = route(
            &Url::parse("openclaw://skills/install?name=tool_1.2-3").unwrap(),
            "openclaw",
        ) else {
            panic!("review");
        };
        for (base, expected) in [
            (
                "http://127.0.0.1:18789/#token=fixture",
                "http://127.0.0.1:18789/skills?clawhub=tool_1.2-3#token=fixture",
            ),
            (
                "https://gateway.example/control",
                "https://gateway.example/control/skills?clawhub=tool_1.2-3",
            ),
        ] {
            assert_eq!(
                review.dashboard_url(&Url::parse(base).unwrap()).as_str(),
                expected
            );
        }
    }

    #[test]
    fn dashboard_focus_and_isolated_profile_semantics_are_unchanged() {
        for (input, scheme, expected) in [
            (
                "openclaw://dashboard/ignored?source=test",
                "openclaw",
                DeepLinkRoute::Dashboard,
            ),
            (
                "openclaw://settings/dashboard",
                "openclaw",
                DeepLinkRoute::FocusOnly,
            ),
            ("https://dashboard/", "openclaw", DeepLinkRoute::FocusOnly),
            (
                "https://plugins/install?name=tool",
                "openclaw",
                DeepLinkRoute::FocusOnly,
            ),
            (
                "openclaw://dashboard",
                "openclaw-aot",
                DeepLinkRoute::FocusOnly,
            ),
            (
                "openclaw-aot://dashboard",
                "openclaw-aot",
                DeepLinkRoute::Dashboard,
            ),
        ] {
            assert_eq!(route(&Url::parse(input).unwrap(), scheme), expected);
        }
        let url = Url::parse("openclaw-aot://plugins/install?name=tool").unwrap();
        assert!(matches!(
            route(&url, "openclaw-aot"),
            DeepLinkRoute::Review(_)
        ));
        assert_eq!(route(&url, "openclaw"), DeepLinkRoute::FocusOnly);
        let mixed_case = Url::parse("OPENCLAW://Skills/install?name=tool").unwrap();
        assert!(matches!(
            route(&mixed_case, "openclaw"),
            DeepLinkRoute::Review(_)
        ));
    }
}
