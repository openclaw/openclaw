//! Avatar trust, precedence and deterministic artwork mirror the Control UI owners.
use super::{people::Person, sessions::SessionRow, web_urls::control_base_url};
use base64::Engine;
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

pub const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AvatarFallback {
    Initials { text: String, hue: u16, owner: bool },
    Text(String),
    AgentFace(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvatarSpec {
    pub url: Option<String>,
    pub fallback: AvatarFallback,
}

pub fn fnv1a_utf16(value: &str) -> u32 {
    value.encode_utf16().fold(0x811c9dc5, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x01000193)
    })
}

pub fn initials(label: &str) -> String {
    let value = label
        .split_whitespace()
        .take(2)
        .map(first_grapheme)
        .collect::<String>()
        .to_uppercase();
    if value.is_empty() { "?".into() } else { value }
}

#[cfg(target_os = "macos")]
fn first_grapheme(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    // Foundation supplies the same composed-character boundary as Intl.Segmenter,
    // including emoji ZWJ sequences; never slice Rust UTF-8 using its UTF-16 range.
    let string = objc2_foundation::NSString::from_str(value);
    let range = string.rangeOfComposedCharacterSequenceAtIndex(0);
    String::from_utf16_lossy(&value.encode_utf16().take(range.length).collect::<Vec<_>>())
}

#[cfg(not(target_os = "macos"))]
fn first_grapheme(value: &str) -> String {
    value.chars().take(1).collect()
}

/// Only the connected Gateway's exact image routes may receive authentication.
pub fn trusted_avatar_url(value: &str, gateway: &str, kind: Option<&str>) -> Option<String> {
    if value.contains('\\') || value.chars().any(char::is_control) || value.starts_with("//") {
        return None;
    }
    let base = control_base_url(gateway).ok()?;
    let mount = base.path().trim_end_matches('/');
    let mut parsed = base.join(value).ok()?;
    if parsed.origin() != base.origin()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let path = parsed.path();
    let local = path.strip_prefix(mount).unwrap_or("");
    let user = valid_component(
        path.strip_prefix("/api/users/")
            .and_then(|s| s.strip_suffix("/avatar")),
    )
    .or_else(|| {
        valid_component(
            local
                .strip_prefix("/api/users/")
                .and_then(|s| s.strip_suffix("/avatar")),
        )
    });
    let agent = valid_component(local.strip_prefix("/avatar/"));
    let channel = valid_component(local.strip_prefix("/__openclaw__/channel-avatar/"));
    let canonical = match kind {
        Some("profile") => format!("{mount}/api/users/{}/avatar", user?),
        Some("agent") => format!("{mount}/avatar/{}", agent?),
        Some("channel") => format!("{mount}/__openclaw__/channel-avatar/{}", channel?),
        Some(_) => return None,
        None => {
            if let Some(user) = user {
                format!("{mount}/api/users/{user}/avatar")
            } else {
                format!("{mount}/avatar/{}", agent?)
            }
        }
    };
    parsed.set_path(&canonical);
    parsed.set_fragment(None);
    Some(parsed.into())
}

fn valid_component(value: Option<&str>) -> Option<&str> {
    let value = value.filter(|value| !value.is_empty() && !value.contains('/'))?;
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return None;
        }
    }
    percent_decode_str(value).decode_utf8().ok()?;
    Some(value)
}

pub fn person_avatar(person: &Person, gateway: &str) -> AvatarSpec {
    let label = person
        .name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or(person.email.as_deref())
        .unwrap_or(&person.id);
    let label = if person.name.is_none() && person.email.is_none() {
        label.split_once('@').map_or(label, |(local, _)| local)
    } else {
        label
    };
    let fallback = match &person.identity {
        Some(identity) if identity.kind == "agent" => {
            AvatarFallback::AgentFace(identity.id.clone())
        }
        _ => AvatarFallback::Initials {
            text: initials(label),
            hue: (fnv1a_utf16(if person.id.trim().is_empty() {
                label
            } else {
                person.id.trim()
            }) % 360) as u16,
            owner: false,
        },
    };
    let kind = person.identity.as_ref().map(|id| id.kind.as_str());
    let url = person
        .avatar_url
        .as_deref()
        .and_then(|value| trusted_avatar_url(value, gateway, kind))
        .or_else(|| {
            person.profile_id().and_then(|id| {
                trusted_avatar_url(
                    &format!(
                        "/api/users/{}/avatar",
                        utf8_percent_encode(id, NON_ALPHANUMERIC)
                    ),
                    gateway,
                    Some("profile"),
                )
            })
        });
    AvatarSpec { url, fallback }
}

pub fn owner_avatar(person: &Person, gateway: &str) -> AvatarSpec {
    let mut avatar = person_avatar(person, gateway);
    if avatar.url.is_none() && !matches!(&avatar.fallback, AvatarFallback::AgentFace(_)) {
        let label = person
            .name
            .as_deref()
            .unwrap_or(&person.id)
            .split('@')
            .next()
            .unwrap_or("");
        let text = label
            .split([' ', '\t', '\n', '.', '_', '-'])
            .filter(|word| !word.is_empty())
            .take(2)
            .map(first_grapheme)
            .collect::<String>()
            .to_uppercase();
        let hash = person.id.encode_utf16().fold(0_i32, |hash, unit| {
            hash.wrapping_mul(31).wrapping_add(i32::from(unit))
        });
        avatar.fallback = AvatarFallback::Initials {
            text,
            hue: (hash.unsigned_abs() % 360) as u16,
            owner: true,
        };
    }
    avatar
}

pub fn agent_avatar(
    id: &str,
    avatar: Option<&str>,
    avatar_url: Option<&str>,
    emoji: Option<&str>,
    gateway: &str,
) -> AvatarSpec {
    let url = [avatar, avatar_url]
        .into_iter()
        .flatten()
        .find_map(|value| {
            if decode_data_image(value).is_some() {
                Some(value.to_owned())
            } else {
                trusted_avatar_url(value, gateway, Some("agent"))
            }
        });
    let text = [emoji, avatar]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| {
            !value.is_empty() && value.encode_utf16().count() <= 8 && !value.chars().any(|c| {
                c.is_whitespace()
                    || matches!(c, '\\' | '/' | '.' | ':')
                    || matches!(c as u32, 0x200b..=0x200f|0x202a..=0x202e|0x2060..=0x206f|0xfeff)
            })
        });
    AvatarSpec {
        url,
        fallback: text
            .map(|value| AvatarFallback::Text(value.to_owned()))
            .unwrap_or_else(|| AvatarFallback::AgentFace(id.to_owned())),
    }
}

pub fn decode_data_image(value: &str) -> Option<(String, Vec<u8>)> {
    if value.len() > MAX_AVATAR_BYTES.div_ceil(3) * 4 + 32 {
        return None;
    }
    let (prefix, encoded) = value.strip_prefix("data:")?.split_once(',')?;
    let (mime, base64) = prefix
        .strip_suffix(";base64")
        .map_or((prefix, false), |mime| (mime, true));
    if !mime.to_ascii_lowercase().starts_with("image/") {
        return None;
    }
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?
    } else {
        percent_decode_str(encoded).collect()
    };
    (bytes.len() <= MAX_AVATAR_BYTES).then(|| (mime.to_owned(), bytes))
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionAvatarKind {
    Attention,
    Icon,
    Channel,
    Owner,
    Empty,
}

pub fn session_avatar_kind(row: &SessionRow, attention: bool) -> SessionAvatarKind {
    if attention {
        SessionAvatarKind::Attention
    } else if row.icon.as_ref().is_some_and(|icon| !icon.is_empty()) {
        SessionAvatarKind::Icon
    } else if row.channel_avatar_url.is_some() {
        SessionAvatarKind::Channel
    } else if session_owner(row).is_some() {
        SessionAvatarKind::Owner
    } else {
        SessionAvatarKind::Empty
    }
}

pub fn session_owner(row: &SessionRow) -> Option<Person> {
    row.owner
        .as_ref()
        .and_then(|owner| owner.get("actor"))
        .and_then(Person::from_actor)
        .or_else(|| row.created_actor.as_ref().and_then(Person::from_actor))
}

pub fn has_multiple_human_identities(
    owners: &[serde_json::Value],
    rows: &[SessionRow],
    self_user: Option<&Person>,
) -> bool {
    let mut humans = std::collections::HashSet::new();
    if let Some(person) = self_user {
        humans.insert(format!(
            "profile:{}",
            person.profile_id().unwrap_or(&person.id)
        ));
    }
    for owner in owners {
        if owner.get("type").and_then(serde_json::Value::as_str) == Some("human")
            && let Some(person) = Person::from_actor(owner)
        {
            humans.insert(format!(
                "profile:{}",
                person.profile_id().unwrap_or(&person.id)
            ));
        }
    }
    if humans.len() >= 2 {
        return true;
    }
    for row in rows {
        for participant in &row.participants {
            let Some(identity) = participant.get("identity") else {
                continue;
            };
            let kind = identity.get("type").and_then(serde_json::Value::as_str);
            match kind {
                Some("profile") => {
                    if let Some(id) = identity.get("id").and_then(serde_json::Value::as_str) {
                        humans.insert(format!("profile:{id}"));
                    }
                }
                Some("observation")
                    if identity
                        .get("senderKind")
                        .and_then(serde_json::Value::as_str)
                        == Some("human") =>
                {
                    humans.insert(identity.to_string());
                }
                Some("legacy")
                    if identity
                        .get("actorType")
                        .and_then(serde_json::Value::as_str)
                        == Some("human") =>
                {
                    humans.insert(identity.to_string());
                }
                _ => {}
            }
            if humans.len() >= 2 {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::super::people::PersonIdentity;
    use super::*;

    #[test]
    fn channel_human_participants_enable_owner_faces_but_unshown_or_bot_participants_do_not() {
        let owners = vec![serde_json::json!({"type":"human","id":"alice"})];
        let mut row:SessionRow=serde_json::from_value(serde_json::json!({"key":"group","participantCount":5,"participants":[{"identity":{"type":"observation","senderKind":"bot","pluginId":"channel","accountId":"default","id":"bob"}}]})).unwrap();
        assert!(!has_multiple_human_identities(
            &owners,
            std::slice::from_ref(&row),
            None
        ));
        row.participants[0]["identity"]["senderKind"] = serde_json::json!("human");
        assert!(has_multiple_human_identities(
            &owners,
            std::slice::from_ref(&row),
            None
        ));
        row.participants[0] = serde_json::json!({"identity":{"type":"legacy","actorType":"human","source":"channel","id":"bob"}});
        assert!(has_multiple_human_identities(&owners, &[row], None));
    }

    #[test]
    fn avatar_routes_preserve_mount_revision_and_namespace_without_remote_fetches() {
        let gateway = "wss://gateway.example/control";
        assert_eq!(
            trusted_avatar_url(
                "/api/users/alice/avatar?v=7#fragment",
                gateway,
                Some("profile")
            )
            .as_deref(),
            Some("https://gateway.example/control/api/users/alice/avatar?v=7")
        );
        assert_eq!(
            trusted_avatar_url("/control/avatar/scout?v=3", gateway, Some("agent")).as_deref(),
            Some("https://gateway.example/control/avatar/scout?v=3")
        );
        for value in [
            "https://other.example/api/users/alice/avatar",
            "//other.example/a.png",
            "/api/secrets",
            "/control/avatar/%ZZ",
            "/control/avatar/scout/extra",
            "/\\other.example/a.png",
        ] {
            assert!(
                trusted_avatar_url(value, gateway, None).is_none(),
                "{value}"
            );
        }
        assert!(trusted_avatar_url("/control/avatar/scout", gateway, Some("profile")).is_none());
        let remote = Person {
            id: "alice".into(),
            identity: Some(PersonIdentity {
                kind: "remote".into(),
                id: "alice".into(),
            }),
            avatar_url: Some("/api/users/alice/avatar".into()),
            ..Default::default()
        };
        assert!(person_avatar(&remote, gateway).url.is_none());
    }

    #[test]
    fn initials_and_colors_follow_the_web_utf16_contract() {
        assert_eq!(initials("Ada Lovelace Byron"), "AL");
        assert_eq!(initials("  "), "?");
        assert_eq!(fnv1a_utf16("hello"), 0x4f9f2cab);
        // UTF-16 surrogate pairs must not be hashed as Rust UTF-8 bytes.
        assert_eq!(fnv1a_utf16("😀"), 0xcb31c4b8);
        #[cfg(target_os = "macos")]
        assert_eq!(initials("👩‍💻 Ada"), "👩‍💻A");
    }

    #[test]
    fn transient_attention_precedes_icon_channel_and_owner() {
        let mut row: SessionRow = serde_json::from_value(serde_json::json!({"key":"group","icon":"🔧","channelAvatarUrl":"/__openclaw__/channel-avatar/group?v=1","owner":{"actor":{"id":"alice"}}})).unwrap();
        assert_eq!(
            session_avatar_kind(&row, true),
            SessionAvatarKind::Attention
        );
        assert_eq!(session_avatar_kind(&row, false), SessionAvatarKind::Icon);
        row.icon = None;
        assert_eq!(session_avatar_kind(&row, false), SessionAvatarKind::Channel);
        row.channel_avatar_url = None;
        assert_eq!(session_avatar_kind(&row, false), SessionAvatarKind::Owner);
        row.owner = None;
        assert_eq!(session_avatar_kind(&row, false), SessionAvatarKind::Empty);
    }
}
