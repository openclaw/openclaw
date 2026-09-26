use crate::ui::theme::{Palette, controls as t};
use gpui_kit::*;
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
