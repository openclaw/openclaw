use gpui_kit::{component::Theme, *};
use std::sync::{Arc, OnceLock};

/// Shares the Control UI's canonical artwork; there is no second palette asset.
pub(in crate::ui) fn transcript_background(cx: &App) -> AnyElement {
    static DARK: OnceLock<Arc<Image>> = OnceLock::new();
    static LIGHT: OnceLock<Arc<Image>> = OnceLock::new();
    let (cache, bytes): (&OnceLock<Arc<Image>>, &[u8]) = if Theme::global(cx).is_dark() {
        (
            &DARK,
            include_bytes!("../../../../../ui/src/assets/themes/claw-dark.webp"),
        )
    } else {
        (
            &LIGHT,
            include_bytes!("../../../../../ui/src/assets/themes/claw-light.webp"),
        )
    };
    let image = cache
        .get_or_init(|| Arc::new(Image::from_bytes(ImageFormat::Webp, bytes.to_vec())))
        .clone();
    img(image)
        .absolute()
        .inset_0()
        .size_full()
        .object_fit(ObjectFit::Cover)
        .into_any_element()
}
