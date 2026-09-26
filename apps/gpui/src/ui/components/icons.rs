use crate::ui::theme::{Palette, controls as t, draft_tokens, tokens};
use gpui_kit::{
    assets::{AllAssets, IconName},
    component::Icon,
    *,
};
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
pub(crate) fn provider_icon_name(provider: &str) -> Option<String> {
    let name = match provider {
        "acp-copilot" | "copilot-proxy" | "github-copilot" => "copilot",
        "anthropic" | "claude-cli" => "claude",
        "amazon-bedrock" | "aws-bedrock" => "bedrock",
        "cloudflare-ai-gateway" => "cloudflare",
        "google" | "google-gemini-cli" => "gemini",
        "kilocode" => "kilo",
        "kimi-coding" | "moonshot" => "kimi",
        "llama-cpp" => "llamacpp",
        "microsoft-foundry" => "microsoft",
        "minimax-portal" => "minimax",
        "ollama-cloud" => "ollama",
        "openai" => "codex",
        "opencode-go" => "opencodego",
        "opencode-zen" => "opencode",
        "qwen" | "qwen-token-plan" => "alibaba",
        "stepfun-plan" => "stepfun",
        "tencent-tokenhub" | "tencent-tokenplan" => "tencent",
        "xai" => "grok",
        "xiaomi" | "xiaomi-token-plan" => "mimo",
        "vercel-ai-gateway" => "vercel",
        "vertex-ai" => "vertexai",
        "z-ai" => "zai",
        other => other,
    };
    let path = format!("provider-icons/ProviderIcon-{name}.svg");
    crate::assets::PROVIDER_ICONS
        .iter()
        .any(|(p, _)| *p == path)
        .then_some(path)
}
pub(crate) fn provider_icon(provider: &str, size: f32, neutral: bool, p: Palette) -> AnyElement {
    if let Some(path) = provider_icon_name(provider) {
        let color = if neutral {
            p.controls().chip
        } else {
            p.provider_color(provider)
        };
        svg()
            .path(path)
            .size(px(size))
            .flex_shrink_0()
            .text_color(color)
            .into_any_element()
    } else {
        div()
            .size(px(size))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(t::FALLBACK_ICON_RADIUS))
            .bg(p.hover)
            .text_size(px(t::TEXT_TINY))
            .font_weight(t::WEIGHT_HEADING)
            .child(
                provider
                    .chars()
                    .next()
                    .unwrap_or('?')
                    .to_uppercase()
                    .to_string(),
            )
            .into_any_element()
    }
}

pub(crate) fn filled_zap(size_px: f32, color: Hsla) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let mut path = PathBuilder::fill();
            for (index, (x, y)) in [
                (13., 2.),
                (3., 14.),
                (12., 14.),
                (11., 22.),
                (21., 10.),
                (12., 10.),
                (13., 2.),
            ]
            .into_iter()
            .enumerate()
            {
                let point = point(
                    bounds.left() + bounds.size.width * (x / 24.),
                    bounds.top() + bounds.size.height * (y / 24.),
                );
                if index == 0 {
                    path.move_to(point);
                } else {
                    path.line_to(point);
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        },
    )
    .size(px(size_px))
    .flex_shrink_0()
    .into_any_element()
}

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

pub fn incognito(color: Hsla) -> Icon {
    Icon::empty()
        .data(include_bytes!("../../../assets/icons/incognito.svg"))
        .size(px(draft_tokens::INCOGNITO_ICON_SIZE))
        .text_color(color)
}

#[cfg(test)]
mod tests {
    use super::{IconName, icon, tokens};

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
