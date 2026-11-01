use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

const SOURCE: &str = include_str!("../../i18n/en.json");
const CATALOG: &str = include_str!("../../ui/i18n/catalog.json");

static SOURCE_MESSAGES: OnceLock<Option<Value>> = OnceLock::new();
static CATALOG_MESSAGES: OnceLock<Option<Value>> = OnceLock::new();
static LOCALE: OnceLock<String> = OnceLock::new();

fn messages(value: &'static str, cell: &'static OnceLock<Option<Value>>) -> Option<&'static Value> {
    cell.get_or_init(|| serde_json::from_str(value).ok())
        .as_ref()
}

fn source_messages() -> Option<&'static Value> {
    messages(SOURCE, &SOURCE_MESSAGES)
}

fn catalog_messages() -> Option<&'static Value> {
    messages(CATALOG, &CATALOG_MESSAGES)
}

fn normalized_supported_locale(tag: &str) -> Option<&'static str> {
    let tag = tag
        .trim()
        .split(|character| matches!(character, '.' | '@'))
        .next()
        .unwrap_or_default();
    let mut parts = tag.split(|character| matches!(character, '-' | '_'));
    let language = parts.next()?.to_ascii_lowercase();
    let region = parts.next().unwrap_or_default().to_ascii_lowercase();
    match (language.as_str(), region.as_str()) {
        ("pt", "pt") if parts.next().is_none() => Some("pt-PT"),
        ("pt", _) => None,
        ("en", _) => Some("en"),
        _ => None,
    }
}

fn select_locale<'a>(preferred: impl IntoIterator<Item = &'a str>) -> &'static str {
    preferred
        .into_iter()
        .find_map(normalized_supported_locale)
        .unwrap_or("en")
}

fn system_locale() -> String {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::NSLocale;

        let languages = NSLocale::preferredLanguages();
        let tags = (0..languages.count())
            .map(|index| languages.objectAtIndex(index).to_string())
            .collect::<Vec<_>>();
        select_locale(tags.iter().map(String::as_str)).to_owned()
    }

    #[cfg(target_os = "windows")]
    {
        use windows::core::PWSTR;
        use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};

        let mut language_count = 0u32;
        let mut buffer_length = 0u32;
        let sized = unsafe {
            GetUserPreferredUILanguages(
                MUI_LANGUAGE_NAME,
                &mut language_count,
                None,
                &mut buffer_length,
            )
        };
        if sized.is_ok() && buffer_length > 0 {
            let mut buffer = vec![0u16; buffer_length as usize];
            let read = unsafe {
                GetUserPreferredUILanguages(
                    MUI_LANGUAGE_NAME,
                    &mut language_count,
                    Some(PWSTR(buffer.as_mut_ptr())),
                    &mut buffer_length,
                )
            };
            if read.is_ok() {
                let tags = buffer
                    .split(|unit| *unit == 0)
                    .filter(|part| !part.is_empty())
                    .filter_map(|part| String::from_utf16(part).ok())
                    .collect::<Vec<_>>();
                select_locale(tags.iter().map(String::as_str)).to_owned()
            } else {
                "en".to_owned()
            }
        } else {
            "en".to_owned()
        }
    }

    #[cfg(target_os = "linux")]
    {
        let mut preferred = Vec::new();
        if let Ok(language) = std::env::var("LANGUAGE") {
            preferred.extend(language.split(':').map(str::to_owned));
        }
        for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(value) = std::env::var(name) {
                preferred.push(value);
            }
        }
        select_locale(preferred.iter().map(String::as_str)).to_owned()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "en".to_owned()
    }
}

pub fn locale() -> &'static str {
    LOCALE.get_or_init(system_locale).as_str()
}

fn declared_args(key: &str) -> Vec<&'static str> {
    source_messages()
        .and_then(|source| source.get("messages"))
        .and_then(|messages| messages.get(key))
        .and_then(|entry| entry.get("args"))
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn source_text(key: &str) -> Option<&'static str> {
    source_messages()?
        .get("messages")?
        .get(key)?
        .get("source")?
        .as_str()
}

fn message_for(locale: &str, key: &str) -> Option<&'static str> {
    if locale == "pt-PT" {
        if let Some(text) = catalog_messages()
            .and_then(|catalog| catalog.get("messages"))
            .and_then(|messages| messages.get(key))
            .and_then(|entry| entry.get("ptPT"))
            .and_then(Value::as_str)
        {
            return Some(text);
        }
    }
    source_text(key)
}

fn render(key: &str, template: &str, allowed: &[&str], args: &[(&str, &str)]) -> String {
    let mut expected = allowed.to_vec();
    let mut provided = args.iter().map(|(name, _)| *name).collect::<Vec<_>>();
    expected.sort_unstable();
    provided.sort_unstable();
    assert_eq!(
        provided, expected,
        "Tauri formatting arguments must exactly match the declaration for {key}"
    );
    let values = args.iter().copied().collect::<HashMap<_, _>>();
    let mut output = String::with_capacity(template.len());
    let mut remaining = template;
    while let Some(open) = remaining.find('{') {
        output.push_str(&remaining[..open]);
        let token_start = open + 1;
        let Some(close_offset) = remaining[token_start..].find('}') else {
            output.push_str(&remaining[open..]);
            return output;
        };
        let close = token_start + close_offset;
        let name = &remaining[token_start..close];
        let valid_name = !name.is_empty()
            && name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_');
        if valid_name && allowed.contains(&name) {
            if let Some(value) = values.get(name) {
                output.push_str(value);
            } else {
                output.push_str(&remaining[open..=close]);
            }
        } else {
            output.push_str(&remaining[open..=close]);
        }
        remaining = &remaining[close + 1..];
    }
    output.push_str(remaining);
    output
}

pub fn text(key: &str) -> String {
    format(key, &[])
}

pub fn format(key: &str, args: &[(&str, &str)]) -> String {
    format_for(locale(), key, args)
}

fn format_for(locale: &str, key: &str, args: &[(&str, &str)]) -> String {
    let Some(template) = message_for(locale, key) else {
        assert!(
            args.is_empty(),
            "Tauri formatting arguments require a declared message for {key}"
        );
        return key.to_owned();
    };
    let allowed = declared_args(key);
    render(key, template, &allowed, args)
}

pub fn chrome_copy() -> Value {
    let keys = [
        "chrome.closeWindow",
        "chrome.dismissGatewayNotice",
        "chrome.maximizeWindow",
        "chrome.minimizeWindow",
        "chrome.restoreWindow",
        "chrome.windowActionFailed",
        "chrome.windowControls",
        "gatewaySwitch.actionFailed",
    ];
    let mut copy = serde_json::Map::new();
    for key in keys {
        let label = match key {
            "chrome.closeWindow" => "closeWindow",
            "chrome.dismissGatewayNotice" => "dismissGatewayNotice",
            "chrome.maximizeWindow" => "maximizeWindow",
            "chrome.minimizeWindow" => "minimizeWindow",
            "chrome.restoreWindow" => "restoreWindow",
            "chrome.windowActionFailed" => "windowActionFailed",
            "chrome.windowControls" => "windowControls",
            "gatewaySwitch.actionFailed" => "gatewayActionFailed",
            _ => unreachable!(),
        };
        let template = message_for(locale(), key).unwrap_or(key);
        copy.insert(label.to_owned(), Value::String(template.to_owned()));
    }
    Value::Object(copy)
}

#[cfg(test)]
mod tests {
    use super::{chrome_copy, format_for, render, select_locale};

    #[test]
    fn only_explicit_portuguese_portugal_tags_select_portuguese() {
        assert_eq!(select_locale(["pt-PT", "en-US"]), "pt-PT");
        assert_eq!(select_locale(["fr-FR", "pt_PT.UTF-8"]), "pt-PT");
        assert_eq!(select_locale(["pt", "pt-BR"]), "en");
        assert_eq!(select_locale(["pt-PT-BR", "en-US"]), "en");
        assert_eq!(select_locale(["pt-PT-BR", "fr-FR"]), "en");
        assert_eq!(select_locale(["en-US", "pt-PT"]), "en");
        assert_eq!(select_locale(["fr-FR", "de-DE"]), "en");
    }

    #[test]
    fn declared_arguments_are_substituted_once_without_reparsing_values() {
        let result = render(
            "quickChat.messageAgent",
            "Message {name}",
            &["name"],
            &[("name", "<b>{other}</b>")],
        );
        assert_eq!(result, "Message <b>{other}</b>");
        assert_eq!(
            render("fixture", "{other}", &["name"], &[("name", "ignored")]),
            "{other}"
        );
    }

    #[test]
    #[should_panic(expected = "Tauri formatting arguments must exactly match")]
    fn formatting_rejects_missing_declared_arguments() {
        format_for("en", "quickChat.messageAgent", &[]);
    }

    #[test]
    #[should_panic(expected = "Tauri formatting arguments must exactly match")]
    fn formatting_rejects_extra_or_duplicate_arguments() {
        format_for(
            "en",
            "quickChat.messageAgent",
            &[("name", "Ada"), ("other", "ignored")],
        );
    }

    #[test]
    fn portuguese_catalog_falls_back_to_the_source_catalog_per_key() {
        assert_eq!(
            format_for("pt-PT", "setup.connecting", &[]),
            "A ligar ao OpenClaw"
        );
        assert_eq!(
            format_for("fr-FR", "gateway.statusConnected", &[]),
            "Connected"
        );
        assert_eq!(
            format_for("en", "tray.runtimeNoInstalledService", &[]),
            "No installed Gateway service"
        );
        assert_eq!(
            format_for("pt-PT", "tray.runtimeNoInstalledService", &[]),
            "Sem serviço do Gateway instalado"
        );
    }

    #[test]
    fn chrome_copy_preserves_error_templates_for_browser_substitution() {
        let copy = chrome_copy();
        assert!(copy["windowActionFailed"]
            .as_str()
            .unwrap()
            .contains("{error}"));
        assert!(copy["gatewayActionFailed"]
            .as_str()
            .unwrap()
            .contains("{error}"));
    }
}
