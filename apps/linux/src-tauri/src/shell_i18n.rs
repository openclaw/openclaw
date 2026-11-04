use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::{Error, ErrorKind};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};

const SOURCE: &str = include_str!("../../i18n/en.json");

static SOURCE_MESSAGES: OnceLock<Option<Value>> = OnceLock::new();
static CATALOG_MESSAGES: OnceLock<Option<Value>> = OnceLock::new();
static LOCALE: OnceLock<String> = OnceLock::new();
const CATALOG_ASSET_PATH: &str = "/i18n/catalog.json";

fn messages(value: &'static str, cell: &'static OnceLock<Option<Value>>) -> Option<&'static Value> {
    cell.get_or_init(|| serde_json::from_str(value).ok())
        .as_ref()
}

fn source_messages() -> Option<&'static Value> {
    messages(SOURCE, &SOURCE_MESSAGES)
}

fn parse_catalog_asset(bytes: Option<&[u8]>) -> std::io::Result<Option<Value>> {
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let catalog: Value =
        serde_json::from_slice(bytes).map_err(|error| Error::new(ErrorKind::InvalidData, error))?;
    let valid_hash = catalog
        .get("sourceInventorySha256")
        .and_then(Value::as_str)
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let Some(catalog_messages) = catalog.get("messages").and_then(Value::as_object) else {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "Tauri shell catalog has no messages object",
        ));
    };
    if catalog.get("version").and_then(Value::as_u64) != Some(1) || !valid_hash {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "Tauri shell catalog has an unsupported version or inventory digest",
        ));
    }
    for (key, entry) in catalog_messages {
        let valid_entry = entry
            .get("en")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            && entry
                .get("ptPT")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            && entry
                .get("args")
                .and_then(Value::as_array)
                .is_some_and(|args| args.iter().all(Value::is_string));
        if !valid_entry {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("Tauri shell catalog has an invalid message entry for {key}"),
            ));
        }
    }
    Ok(Some(catalog))
}

pub fn initialize_catalog<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<()> {
    let bytes = catalog_asset_bytes(app.asset_resolver().iter());
    let catalog = parse_catalog_asset(bytes.as_deref())?;
    CATALOG_MESSAGES.set(catalog).map_err(|_| {
        Error::new(
            ErrorKind::AlreadyExists,
            "Tauri shell catalog was initialized more than once",
        )
    })
}

fn catalog_asset_bytes<'a>(
    mut assets: impl Iterator<Item = (Cow<'a, str>, Cow<'a, [u8]>)>,
) -> Option<Vec<u8>> {
    assets
        .find_map(|(path, bytes)| (path.as_ref() == CATALOG_ASSET_PATH).then(|| bytes.into_owned()))
}

fn catalog_messages() -> Option<&'static Value> {
    CATALOG_MESSAGES.get().and_then(Option::as_ref)
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

fn message_for_catalog<'a>(locale: &str, key: &str, catalog: Option<&'a Value>) -> Option<&'a str> {
    let source = source_text(key)?;
    if locale == "pt-PT" {
        if let Some(entry) = catalog
            .and_then(|catalog| catalog.get("messages"))
            .and_then(|messages| messages.get(key))
        {
            let entry_args = entry
                .get("args")
                .and_then(Value::as_array)
                .and_then(|args| args.iter().map(Value::as_str).collect::<Option<Vec<_>>>());
            if let (Some(entry_args), Some(text)) =
                (entry_args, entry.get("ptPT").and_then(Value::as_str))
            {
                if entry.get("en").and_then(Value::as_str) == Some(source)
                    && entry_args == declared_args(key)
                {
                    return Some(text);
                }
            }
        }
    }
    Some(source)
}

fn message_for(locale: &str, key: &str) -> Option<&'static str> {
    message_for_catalog(locale, key, catalog_messages())
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
    format_for_catalog(locale, key, args, catalog_messages())
}

fn format_for_catalog(
    locale: &str,
    key: &str,
    args: &[(&str, &str)],
    catalog: Option<&Value>,
) -> String {
    let Some(template) = message_for_catalog(locale, key, catalog) else {
        assert!(
            args.is_empty(),
            "Tauri formatting arguments require a declared message for {key}"
        );
        return key.to_owned();
    };
    let allowed = declared_args(key);
    render(key, template, &allowed, args)
}

#[cfg(test)]
fn test_catalog() -> Value {
    let translations = [
        ("setup.connecting", "A ligar ao OpenClaw"),
        (
            "tray.runtimeNoInstalledService",
            "Sem serviço do Gateway instalado",
        ),
        ("nativeMenu.about", "Acerca de"),
        ("nativeMenu.aboutNamed", "Acerca de {appName}"),
        ("nativeMenu.closeWindow", "Fechar janela"),
        ("nativeMenu.copy", "Copiar"),
        ("nativeMenu.cut", "Cortar"),
        ("nativeMenu.edit", "Editar"),
        ("nativeMenu.file", "Ficheiro"),
        ("nativeMenu.fullscreen", "Alternar ecrã completo"),
        ("nativeMenu.help", "Ajuda"),
        ("nativeMenu.hide", "Ocultar"),
        ("nativeMenu.hideNamed", "Ocultar {appName}"),
        ("nativeMenu.hideOthers", "Ocultar outras aplicações"),
        ("nativeMenu.maximize", "Maximizar"),
        ("nativeMenu.minimize", "Minimizar"),
        ("nativeMenu.paste", "Colar"),
        ("nativeMenu.quit", "Sair"),
        ("nativeMenu.quitNamed", "Sair de {appName}"),
        ("nativeMenu.redo", "Refazer"),
        ("nativeMenu.selectAll", "Selecionar tudo"),
        ("nativeMenu.services", "Serviços"),
        ("nativeMenu.undo", "Desfazer"),
        ("nativeMenu.view", "Ver"),
        ("nativeMenu.window", "Janela"),
    ];
    let messages = translations
        .into_iter()
        .map(|(key, pt_pt)| {
            (
                key.to_owned(),
                serde_json::json!({
                    "en": source_text(key).expect("test source declaration"),
                    "ptPT": pt_pt,
                    "args": declared_args(key),
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    serde_json::json!({
        "version": 1,
        "sourceInventorySha256": "0".repeat(64),
        "messages": messages,
    })
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
fn menu_text_for(locale: &str, key: &str, catalog: Option<&Value>) -> String {
    format_for_catalog(locale, key, &[], catalog)
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
    catalog: Option<&Value>,
) -> Option<String> {
    if locale != "pt-PT" {
        return Some(native_text.to_owned());
    }
    match default_app_name(native_text, english_prefix)? {
        None => Some(menu_text_for(locale, bare_key, catalog)),
        Some(app_name) => {
            let escaped_name = app_name.replace('&', "&&");
            Some(format_for_catalog(
                locale,
                named_key,
                &[("appName", escaped_name.as_str())],
                catalog,
            ))
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn default_submenu_label_for(
    locale: &str,
    native_text: &str,
    catalog: Option<&Value>,
) -> Option<String> {
    let key = match native_text {
        "File" => "nativeMenu.file",
        "Edit" => "nativeMenu.edit",
        "View" => "nativeMenu.view",
        "Window" => "nativeMenu.window",
        "Help" => "nativeMenu.help",
        _ => return None,
    };
    Some(menu_text_for(locale, key, catalog))
}

#[cfg(any(target_os = "macos", test))]
fn default_predefined_label_for(
    locale: &str,
    native_text: &str,
    catalog: Option<&Value>,
) -> Option<String> {
    match native_text {
        "Hide Others" => Some(menu_text_for(locale, "nativeMenu.hideOthers", catalog)),
        _ if native_text == "About" || native_text.starts_with("About ") => default_app_menu_text(
            locale,
            "nativeMenu.about",
            "nativeMenu.aboutNamed",
            "About",
            native_text,
            catalog,
        ),
        _ if native_text == "Hide" || native_text.starts_with("Hide ") => default_app_menu_text(
            locale,
            "nativeMenu.hide",
            "nativeMenu.hideNamed",
            "Hide",
            native_text,
            catalog,
        ),
        _ if native_text == "Quit" || native_text.starts_with("Quit ") => default_app_menu_text(
            locale,
            "nativeMenu.quit",
            "nativeMenu.quitNamed",
            "Quit",
            native_text,
            catalog,
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
            Some(menu_text_for(locale, key, catalog))
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
    let catalog = catalog_messages();

    for (position, kind) in menu.items()?.iter().enumerate() {
        let Some(submenu) = kind.as_submenu() else {
            continue;
        };
        if position != 0 {
            if let Some(text) = default_submenu_label_for(locale, &submenu.text()?, catalog) {
                submenu.set_text(text)?;
            }
        }
        for child in submenu.items()? {
            let Some(item) = child.as_predefined_menuitem() else {
                continue;
            };
            if let Some(text) = default_predefined_label_for(locale, &item.text()?, catalog) {
                item.set_text(text)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        catalog_asset_bytes, chrome_copy, default_app_menu_text, default_predefined_label_for,
        default_submenu_label_for, format_for, format_for_catalog, menu_text_for,
        parse_catalog_asset, render, select_locale, test_catalog, CATALOG_ASSET_PATH,
    };
    use serde_json::Value;
    use std::borrow::Cow;

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
        let catalog = test_catalog();
        assert_eq!(
            format_for_catalog("pt-PT", "setup.connecting", &[], Some(&catalog)),
            "A ligar ao OpenClaw"
        );
        assert_eq!(
            format_for_catalog("fr-FR", "gateway.statusConnected", &[], Some(&catalog)),
            "Connected"
        );
        assert_eq!(
            format_for_catalog("en", "tray.runtimeNoInstalledService", &[], Some(&catalog)),
            "No installed Gateway service"
        );
        assert_eq!(
            format_for_catalog(
                "pt-PT",
                "tray.runtimeNoInstalledService",
                &[],
                Some(&catalog),
            ),
            "Sem serviço do Gateway instalado"
        );
    }

    #[test]
    fn absent_or_stale_packaged_catalog_uses_current_english_per_key() {
        assert!(parse_catalog_asset(None).unwrap().is_none());
        let catalog = test_catalog();
        assert_eq!(
            format_for_catalog("pt-PT", "setup.connecting", &[], Some(&catalog)),
            "A ligar ao OpenClaw"
        );

        let mut stale_source: Value = catalog.clone();
        stale_source["messages"]["setup.connecting"]["en"] = Value::String("Old source".into());
        assert_eq!(
            format_for_catalog("pt-PT", "setup.connecting", &[], Some(&stale_source)),
            "Connecting to OpenClaw"
        );

        let mut stale_args = catalog;
        stale_args["messages"]["nativeMenu.aboutNamed"]["args"] = serde_json::json!(["oldName"]);
        assert_eq!(
            format_for_catalog(
                "pt-PT",
                "nativeMenu.aboutNamed",
                &[("appName", "OpenClaw")],
                Some(&stale_args),
            ),
            "About OpenClaw"
        );
    }

    #[test]
    fn exact_embedded_asset_key_adopts_the_current_portuguese_catalog() {
        let catalog = test_catalog();
        let bytes = serde_json::to_vec(&catalog).unwrap();
        let found = catalog_asset_bytes(
            [(
                Cow::Borrowed(CATALOG_ASSET_PATH),
                Cow::Borrowed(bytes.as_slice()),
            )]
            .into_iter(),
        )
        .unwrap();
        let parsed = parse_catalog_asset(Some(&found)).unwrap().unwrap();
        assert_eq!(
            format_for_catalog("pt-PT", "setup.connecting", &[], Some(&parsed)),
            "A ligar ao OpenClaw"
        );
        assert!(catalog_asset_bytes(
            [(
                Cow::Borrowed("i18n/catalog.json"),
                Cow::Borrowed(bytes.as_slice())
            )]
            .into_iter()
        )
        .is_none());
    }

    #[test]
    fn present_invalid_packaged_catalog_is_rejected() {
        for raw in [
            br#"{"version":2,"sourceInventorySha256":"0000000000000000000000000000000000000000000000000000000000000000","messages":{}}"#.as_slice(),
            br#"{"version":1,"sourceInventorySha256":"bad","messages":{}}"#.as_slice(),
            br#"{"version":1,"sourceInventorySha256":"0000000000000000000000000000000000000000000000000000000000000000","messages":{"bad":{"en":"Bad","ptPT":"Mau","args":[1]}}}"#.as_slice(),
        ] {
            assert!(parse_catalog_asset(Some(raw)).is_err());
        }
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
        let catalog = test_catalog();
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
                default_submenu_label_for("en", english, Some(&catalog))
            } else {
                default_predefined_label_for("en", english, Some(&catalog))
            };
            let portuguese_label = if submenu {
                default_submenu_label_for("pt-PT", english, Some(&catalog))
            } else {
                default_predefined_label_for("pt-PT", english, Some(&catalog))
            };
            assert_eq!(english_label.as_deref(), Some(english));
            assert_eq!(portuguese_label.as_deref(), Some(portuguese));
            assert_eq!(menu_text_for("pt-PT", key, Some(&catalog)), portuguese);
        }
    }

    #[test]
    fn named_macos_menu_labels_preserve_literal_app_names() {
        let catalog = test_catalog();
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
                default_app_menu_text("pt-PT", bare_key, named_key, prefix, prefix, Some(&catalog),),
                Some(expected_bare.to_owned())
            );
            assert_eq!(
                default_app_menu_text(
                    "pt-PT",
                    bare_key,
                    named_key,
                    prefix,
                    &format!("{prefix} File & {{name}}"),
                    Some(&catalog),
                ),
                Some(expected_named.to_owned())
            );
            let english = format!("{prefix} File & {{name}}");
            assert_eq!(
                default_app_menu_text("en", bare_key, named_key, prefix, &english, Some(&catalog),),
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
                Some(&catalog),
            ),
            None
        );
    }
}
