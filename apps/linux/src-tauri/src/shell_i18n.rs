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

#[cfg(any(target_os = "macos", test))]
fn menu_text_for(locale: &str, key: &str) -> String {
    format_for(locale, key, &[])
}

#[cfg(any(target_os = "macos", test))]
fn default_app_name<'a>(native_text: &'a str, english_prefix: &str) -> Option<Option<&'a str>> {
    if native_text == english_prefix {
        return Some(None);
    }
    native_text
        .strip_prefix(english_prefix)
        .and_then(|suffix| suffix.strip_prefix(' '))
        .filter(|name| !name.is_empty())
        .map(Some)
}

#[cfg(any(target_os = "macos", test))]
fn default_app_menu_text(
    locale: &str,
    bare_key: &str,
    named_key: &str,
    english_prefix: &str,
    native_text: &str,
) -> Option<String> {
    if locale != "pt-PT" {
        return Some(native_text.to_owned());
    }
    match default_app_name(native_text, english_prefix)? {
        None => Some(menu_text_for(locale, bare_key)),
        Some(app_name) => {
            let escaped_name = app_name.replace('&', "&&");
            Some(format_for(
                locale,
                named_key,
                &[("appName", escaped_name.as_str())],
            ))
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn default_submenu_label_for(locale: &str, native_text: &str) -> Option<String> {
    let key = match native_text {
        "File" => "nativeMenu.file",
        "Edit" => "nativeMenu.edit",
        "View" => "nativeMenu.view",
        "Window" => "nativeMenu.window",
        "Help" => "nativeMenu.help",
        _ => return None,
    };
    Some(menu_text_for(locale, key))
}

#[cfg(any(target_os = "macos", test))]
fn default_predefined_label_for(locale: &str, native_text: &str) -> Option<String> {
    match native_text {
        "Hide Others" => Some(menu_text_for(locale, "nativeMenu.hideOthers")),
        _ if native_text == "About" || native_text.starts_with("About ") => default_app_menu_text(
            locale,
            "nativeMenu.about",
            "nativeMenu.aboutNamed",
            "About",
            native_text,
        ),
        _ if native_text == "Hide" || native_text.starts_with("Hide ") => default_app_menu_text(
            locale,
            "nativeMenu.hide",
            "nativeMenu.hideNamed",
            "Hide",
            native_text,
        ),
        _ if native_text == "Quit" || native_text.starts_with("Quit ") => default_app_menu_text(
            locale,
            "nativeMenu.quit",
            "nativeMenu.quitNamed",
            "Quit",
            native_text,
        ),
        _ => {
            let key = match native_text {
                "Services" => "nativeMenu.services",
                "Close Window" => "nativeMenu.closeWindow",
                "Undo" => "nativeMenu.undo",
                "Redo" => "nativeMenu.redo",
                "Cut" => "nativeMenu.cut",
                "Copy" => "nativeMenu.copy",
                "Paste" => "nativeMenu.paste",
                "Select All" => "nativeMenu.selectAll",
                "Toggle Full Screen" => "nativeMenu.fullscreen",
                "Minimize" => "nativeMenu.minimize",
                "Zoom" => "nativeMenu.maximize",
                _ => return None,
            };
            Some(menu_text_for(locale, key))
        }
    }
}

#[cfg(target_os = "macos")]
pub fn localize_default_macos_menu<R: tauri::Runtime>(
    menu: &tauri::menu::Menu<R>,
) -> tauri::Result<()> {
    let locale = locale();
    if locale != "pt-PT" {
        return Ok(());
    }

    for (position, kind) in menu.items()?.iter().enumerate() {
        let Some(submenu) = kind.as_submenu() else {
            continue;
        };
        if position != 0 {
            if let Some(text) = default_submenu_label_for(locale, &submenu.text()?) {
                submenu.set_text(text)?;
            }
        }
        for child in submenu.items()? {
            let Some(item) = child.as_predefined_menuitem() else {
                continue;
            };
            if let Some(text) = default_predefined_label_for(locale, &item.text()?) {
                item.set_text(text)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        chrome_copy, default_app_menu_text, default_predefined_label_for,
        default_submenu_label_for, format_for, menu_text_for, render, select_locale,
    };

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

    #[test]
    fn default_macos_menu_labels_use_the_native_portuguese_catalog() {
        let labels = [
            ("nativeMenu.about", "About", "Acerca de"),
            ("nativeMenu.closeWindow", "Close Window", "Fechar janela"),
            ("nativeMenu.copy", "Copy", "Copiar"),
            ("nativeMenu.cut", "Cut", "Cortar"),
            ("nativeMenu.edit", "Edit", "Editar"),
            ("nativeMenu.file", "File", "Ficheiro"),
            (
                "nativeMenu.fullscreen",
                "Toggle Full Screen",
                "Alternar ecrã completo",
            ),
            ("nativeMenu.help", "Help", "Ajuda"),
            ("nativeMenu.hide", "Hide", "Ocultar"),
            (
                "nativeMenu.hideOthers",
                "Hide Others",
                "Ocultar outras aplicações",
            ),
            ("nativeMenu.maximize", "Zoom", "Maximizar"),
            ("nativeMenu.minimize", "Minimize", "Minimizar"),
            ("nativeMenu.paste", "Paste", "Colar"),
            ("nativeMenu.quit", "Quit", "Sair"),
            ("nativeMenu.redo", "Redo", "Refazer"),
            ("nativeMenu.selectAll", "Select All", "Selecionar tudo"),
            ("nativeMenu.services", "Services", "Serviços"),
            ("nativeMenu.undo", "Undo", "Desfazer"),
            ("nativeMenu.view", "View", "Ver"),
            ("nativeMenu.window", "Window", "Janela"),
        ];
        for (key, english, portuguese) in labels {
            let submenu = matches!(
                key,
                "nativeMenu.edit"
                    | "nativeMenu.file"
                    | "nativeMenu.help"
                    | "nativeMenu.view"
                    | "nativeMenu.window"
            );
            let english_label = if submenu {
                default_submenu_label_for("en", english)
            } else {
                default_predefined_label_for("en", english)
            };
            let portuguese_label = if submenu {
                default_submenu_label_for("pt-PT", english)
            } else {
                default_predefined_label_for("pt-PT", english)
            };
            assert_eq!(english_label.as_deref(), Some(english));
            assert_eq!(portuguese_label.as_deref(), Some(portuguese));
            assert_eq!(menu_text_for("pt-PT", key), portuguese);
        }
    }

    #[test]
    fn named_macos_menu_labels_preserve_literal_app_names() {
        for (bare_key, named_key, prefix, expected_bare, expected_named) in [
            (
                "nativeMenu.about",
                "nativeMenu.aboutNamed",
                "About",
                "Acerca de",
                "Acerca de File && {name}",
            ),
            (
                "nativeMenu.hide",
                "nativeMenu.hideNamed",
                "Hide",
                "Ocultar",
                "Ocultar File && {name}",
            ),
            (
                "nativeMenu.quit",
                "nativeMenu.quitNamed",
                "Quit",
                "Sair",
                "Sair de File && {name}",
            ),
        ] {
            assert_eq!(
                default_app_menu_text("pt-PT", bare_key, named_key, prefix, prefix),
                Some(expected_bare.to_owned())
            );
            assert_eq!(
                default_app_menu_text(
                    "pt-PT",
                    bare_key,
                    named_key,
                    prefix,
                    &format!("{prefix} File & {{name}}"),
                ),
                Some(expected_named.to_owned())
            );
            let english = format!("{prefix} File & {{name}}");
            assert_eq!(
                default_app_menu_text("en", bare_key, named_key, prefix, &english),
                Some(english)
            );
        }
        assert_eq!(
            default_app_menu_text(
                "pt-PT",
                "nativeMenu.about",
                "nativeMenu.aboutNamed",
                "About",
                "Aboutface File",
            ),
            None
        );
    }
}
