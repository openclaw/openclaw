use crate::ui::theme::tokens;
use gpui_kit::{
    AssetSource, Pixels, Styled,
    assets::{AllAssets, IconName},
    component::Icon,
};
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

/// Shared Control UI glyphs retain the bundled Lucide owner and theme stroke.
pub(crate) fn icon(name: IconName, size: Pixels) -> Icon {
    static ICONS: LazyLock<Mutex<HashMap<IconName, Option<Vec<u8>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let Ok(mut icons) = ICONS.lock() else {
        return Icon::new(name).size(size);
    };
    let bytes = icons.entry(name).or_insert_with(|| {
        let special = match name {
        IconName::PenLine => Some(br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>"#.as_slice()),
        IconName::House => Some(br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>"#.as_slice()),
        _ => None,
    };
        let bytes = if let Some(bytes) = special {
            Cow::Borrowed(bytes)
        } else {
            match AllAssets.load(&name.path()) {
                Ok(Some(bytes)) => bytes,
                _ => {
                    log::warn!("Could not prepare bundled UI icon {name:?}");
                    return None;
                }
            }
        };
        let stroke = format!("stroke-width=\"{}\"", tokens::icon::STROKE_WIDTH);
        Some(String::from_utf8_lossy(&bytes)
            .replace("stroke-width=\"2\"", &stroke)
            .replace("stroke-width=\"1.5\"", &stroke)
            .into_bytes())
    });
    match bytes {
        Some(bytes) => Icon::default().data(bytes).size(size),
        None => Icon::new(name).size(size),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_icon_is_admitted_by_the_sidebar_renderer() {
        // Agent menus and footer controls share this renderer with navigation.
        for &name in IconName::ALL {
            assert!(
                std::panic::catch_unwind(|| icon(name, tokens::icon::NORMAL)).is_ok(),
                "sidebar icon construction panicked for {name:?}"
            );
        }
    }
}
