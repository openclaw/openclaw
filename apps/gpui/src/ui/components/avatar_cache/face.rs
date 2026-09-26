use crate::{model::avatars::fnv1a_utf16, ui::theme::tokens::colors};
use gpui_kit::{Image, ImageFormat};
use std::sync::Arc;

pub(super) fn image(id: &str) -> Arc<Image> {
    let seed = fnv1a_utf16(id);
    let eye_seed = seed / 10;
    let mouth_seed = eye_seed / 4;
    let pastel = mouth_seed / 4 % 2 == 1;
    let [color, pale, ink] = colors::generated_face(seed);
    let eyes = [
        "<circle cx='11' cy='13.5' r='1.6'/><circle cx='21' cy='13.5' r='1.6'/>".to_owned(),
        "<ellipse cx='11' cy='13' rx='1.5' ry='2'/><ellipse cx='21' cy='13' rx='1.5' ry='2'/>"
            .into(),
        format!(
            "<path d='M9 14q2-3 4 0m6 0q2-3 4 0' fill='none' stroke='{ink}' stroke-width='1.6' stroke-linecap='round'/>"
        ),
        format!(
            "<rect x='6.5' y='9' width='19' height='9.5' rx='4.75'/><g fill='{pale}'><rect x='10.5' y='12' width='2.5' height='3.5' rx='1.25'/><rect x='19' y='12' width='2.5' height='3.5' rx='1.25'/></g>"
        ),
    ];
    let mouths = [
        format!(
            "<path d='M11.5 20q4.5 4.5 9 0' fill='none' stroke='{ink}' stroke-width='1.6' stroke-linecap='round'/>"
        ),
        format!(
            "<path d='M11 19q5 1.5 10 0c-.5 4.5-3 6-5 6s-4.5-1.5-5-6Z'/><path d='M13.5 23q2.5-2 5 0-2.5 2-5 0Z' fill='{pale}'/>"
        ),
        format!(
            "<path d='M12 22q5 2 8-1' fill='none' stroke='{ink}' stroke-width='1.6' stroke-linecap='round'/>"
        ),
        format!(
            "<path d='M13.5 22.5h5' fill='none' stroke='{ink}' stroke-width='1.6' stroke-linecap='round'/>"
        ),
    ];
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='64' height='64'><circle cx='16' cy='16' r='16' fill='{}'/><g fill='{ink}'>{}{}</g></svg>",
        if pastel { pale } else { color },
        eyes[eye_seed as usize % 4],
        mouths[mouth_seed as usize % 4]
    );
    Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()))
}
