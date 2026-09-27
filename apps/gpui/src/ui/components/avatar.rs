use super::avatar_cache::{AvatarAssets, AvatarCache};
use crate::{
    model::avatars::{AvatarFallback, AvatarSpec},
    ui::theme::{
        Palette,
        tokens::{AvatarMetrics, avatar, colors, space},
    },
};
use gpui_kit::{
    base::{Avatar as AvatarRoot, AvatarFallback as FallbackSlot},
    prelude::FluentBuilder,
    *,
};

/// Web-compatible identity presentation; loading and identity policy stay with their owners.
#[derive(IntoElement)]
pub(in crate::ui) struct Avatar {
    fallback: AvatarFallback,
    assets: AvatarAssets,
    metrics: AvatarMetrics,
    border_color: Option<Hsla>,
    initials_weight: FontWeight,
    text_fallback_background: Hsla,
}

impl Avatar {
    pub fn new(spec: &AvatarSpec, cache: &AvatarCache, metrics: AvatarMetrics) -> Self {
        Self {
            fallback: spec.fallback.clone(),
            assets: cache.assets(spec),
            metrics,
            border_color: None,
            initials_weight: avatar::INITIALS_WEIGHT,
            text_fallback_background: transparent_black(),
        }
    }

    pub fn initials_weight(mut self, weight: FontWeight) -> Self {
        self.initials_weight = weight;
        self
    }

    pub fn text_fallback_background(mut self, color: Hsla) -> Self {
        self.text_fallback_background = color;
        self
    }

    pub fn border_color(mut self, color: Hsla) -> Self {
        self.border_color = Some(color);
        self
    }
}

impl RenderOnce for Avatar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let metrics = self.metrics;
        let inner = (metrics.diameter - metrics.border * 2.).max(space::NONE);
        let fallback = match self.fallback {
            AvatarFallback::Initials { text, hue, owner } => div()
                .size_full()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(colors::initials_background(hue, owner))
                .text_color(colors::initials_foreground())
                .text_size(metrics.text_size)
                .line_height(metrics.text_size)
                .font_weight(self.initials_weight)
                .child(text)
                .into_any_element(),
            AvatarFallback::Text(text) => div()
                .bg(self.text_fallback_background)
                .size_full()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .text_size(metrics.text_size)
                .line_height(metrics.text_size)
                .child(text)
                .into_any_element(),
            AvatarFallback::AgentFace(_) => self
                .assets
                .fallback_image
                .map(|face| {
                    img(face)
                        .size_full()
                        .rounded_full()
                        .object_fit(ObjectFit::Cover)
                        .into_any_element()
                })
                .unwrap_or_else(|| div().into_any_element()),
        };
        // Keep the fallback mounted while GPUI decodes the image. The styled Avatar
        // replaces its fallback slot eagerly and cannot express this failure behavior.
        let layers = FallbackSlot::new()
            .relative()
            .size(inner)
            .rounded_full()
            .overflow_hidden()
            .child(fallback)
            .when_some(self.assets.image, |this, image| {
                this.child(
                    img(image)
                        .absolute()
                        .inset_0()
                        .size_full()
                        .rounded_full()
                        .object_fit(ObjectFit::Cover)
                        .with_fallback(|| div().into_any_element()),
                )
            });
        AvatarRoot::new()
            .size(metrics.diameter)
            .flex_shrink_0()
            .rounded_full()
            .overflow_hidden()
            .border(metrics.border)
            .border_color(self.border_color.unwrap_or_else(|| Palette::get(cx).border))
            .fallback(layers)
    }
}
